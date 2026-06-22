# Gmail Outbound & Sanctioned Reply Path (post-AUR-2682)

**Owner:** CTO · **Status:** Active · **Source issue:** AUR-2818 · **Supersedes ad-hoc send attempts**

This document is the single source of truth for how a Paperclip agent sends or
replies to email from a company mailbox **after** the AUR-2682 outbound gate
landed. It exists because agents repeatedly hit the gate during the 2026-06-17
First-Mile/bunq false-fraud incident with no documented schema for a threaded
reply or a sanctioned approval flow (15 tool-gap reports, 3 agents).

> ⚠️ **This is not a re-opening of ungated sending.** AUR-2682 (gate at the
> service chokepoint) and AUR-2539 (stand down the misfiring escalation loop)
> are recent, deliberate safety decisions. The path below documents how to send
> *within* those guardrails — it does not weaken them.

---

## TL;DR — how to send a reply

1. **Build the request** against the control-plane route (auth = company access):

   ```
   POST /api/companies/:companyId/gmail/mailboxes/:mailbox/messages
   Content-Type: application/json

   {
     "to": "person@example.com",
     "subject": "Re: your message",
     "body": "...",
     "replyToMessageId": "<gmail message id you are replying to>",  // optional — enables threading
     "ceoApprovalId": "<approval id>"                               // required ONLY if the send is gated
   }
   ```

2. **Threading is automatic** when you pass `replyToMessageId`: the service
   fetches the original message, reads its `threadId`, and sends the reply into
   the same Gmail conversation. You do **not** set `threadId` yourself.

3. **If the send is "gated"** (fraud/abuse/legal/chargeback/law-enforcement/
   blocklisted-domain — see classification below), the route returns **403**
   unless `ceoApprovalId` points to an approval row with `status === 'approved'`.
   Ordinary mail and de-escalatory withdrawals are **not** gated and pass through.

---

## Mailboxes

`mailbox` path param ∈ `board | alex | leo | adrian | billing`
(`server/src/services/gmail.ts` → `GMAIL_SUPPORTED_ALIASES`).

| alias     | address                  | role            |
|-----------|--------------------------|-----------------|
| `board`   | board@tryauranode.com    | CEO / board     |
| `alex`    | alex@tryauranode.com     | CMO             |
| `leo`     | leo@tryauranode.com      | CTO             |
| `adrian`  | adrian@tryauranode.com   | CFO             |
| `billing` | billing@tryauranode.com  | billing / CFO   |

Impersonation is via Google **domain-wide delegation**: the server's
`GOOGLE_WORKSPACE_SA_KEY` service account assumes each mailbox as the JWT
`subject`. Agents do **not** need the SA key in their own shell env — sending is
a server-side control-plane action, not a local credential operation. (Several
of the underlying tool-gap reports asked for the SA key in agent env; that is
**not** the sanctioned path and will not be provided. Use the route.)

---

## The gate — what is "gated"

Source: `server/src/services/gmail-outbound-guard.ts` (`classifyGmailOutbound`),
enforced at the service chokepoint `server/src/services/gmail.ts` →
`sendMessage()` so **every** code path is classified, not just the HTTP route.

A send is **gated** (`decision.gated === true`) when a sensitive **category** is
detected **and** the recipient is external (or a trust/safety group):

- **Categories:** `fraud_report`, `abuse_report`, `legal_threat`, `chargeback`,
  `law_enforcement`, `blocked_domain`.
- **Absolute domain blocklist** (no content bypass — only a CEO approval
  overrides): `bunq.com`, `shopify.com`, `cert.gov.ua`,
  `shopifylegal.zendesk.com`.
- **Recipient signals:** report desks (`fraud@`, `abuse@`, `legal@`,
  `security@`, `compliance@`, …) and trust-&-safety group names.
- **Content signals:** strong (e.g. "account takeover", "chargeback", "cease and
  desist", "police report") and weak (e.g. "freeze the payout") — weak signals
  only gate when combined with a report-desk/group recipient.

**Not gated:** internal mail, ordinary external mail, and de-escalatory
withdrawals (e.g. retracting a prior false report) — these send unchanged.

When a gated send is blocked for an agent, the route auto-files a high-priority
incident issue assigned to that agent describing the block and the approval path.

---

## Sanctioned approval flow for a gated send

1. Attempt the send via the route. If gated, you get **403** + an auto-filed
   incident issue.
2. **Verify the send is actually warranted.** The whole gate exists because a
   misfiring loop sent false fraud reports. Confirm the facts before escalating.
3. Request board approval:
   `POST /api/companies/:companyId/approvals` with `type: request_board_approval`,
   linking the incident issue and stating the exact recipient, mailbox, and body.
4. **CEO (board actor) approves.** Note: approving and the gated send itself both
   require a board actor; an ordinary agent key gets 403 on both
   (`tool-gaps/.../ceo-board-approval`). This separation is intentional.
5. Re-issue the send with `ceoApprovalId` set to the approved approval's id. The
   route re-checks `status === 'approved'` against the DB before letting it
   through.

---

## Threading details & current limitation

- Threading uses Gmail's native `threadId` (resolved server-side from
  `replyToMessageId`). This keeps the reply in-conversation in Gmail.
- **Known limitation:** the raw MIME builder (`buildRawMessage`) does **not** yet
  add `In-Reply-To` / `References` headers. Gmail threads correctly via
  `threadId`, but strict third-party clients that thread purely on RFC headers
  may not. If on-thread fidelity for external clients becomes a requirement,
  file a follow-up to add those headers from the original message. This is a
  fidelity nicety, not a gate concern.

---

## What this doc deliberately does NOT do

- It does not add a new "reply action" UI/affordance or a new ungated endpoint.
- It does not put `GOOGLE_WORKSPACE_SA_KEY` into agent shells.
- It does not change the gate, the blocklist, or the approval requirement.

Whether the system should add a *first-class, board-approved threaded-reply
action* for company mailboxes (vs. the current route + per-send approval) is a
**policy question for the CEO** — escalated on AUR-2818. Until the CEO signs off,
the route + approval flow above is the only sanctioned path.
