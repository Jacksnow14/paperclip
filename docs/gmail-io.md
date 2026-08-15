# Gmail I/O

First-class Gmail read/send API for agent workflows. Backed by a Google Workspace
service account with domain-wide delegation (`server/src/services/gmail.ts`,
`server/src/routes/gmail.ts`) — no raw SA-key/urllib workaround required.

**Auth:** service-account JWT, key from env `GOOGLE_WORKSPACE_SA_KEY` (raw JSON).
**Mailboxes:** `board@tryauranode.com`, `alex@tryauranode.com` (`GMAIL_SUPPORTED_ALIASES`).
All routes are under `/api/companies/:companyId/gmail/mailboxes/:mailbox/...` and require
company access (agent API key or board session), same as any other `/api` route.

## Read: message body + headers

```
GET /api/companies/:companyId/gmail/mailboxes/:mailbox/messages/:messageId
```

Returns the full Gmail API message resource (`format: "full"`): headers, body parts,
and — for messages with attachments — `payload.parts[].body.attachmentId` +
`payload.parts[].filename` + `payload.parts[].mimeType`. Use those fields to discover
what's downloadable, then call the attachment endpoint below.

## Read: download an attachment

```
GET /api/companies/:companyId/gmail/mailboxes/:mailbox/messages/:messageId/attachments/:attachmentId
```

```json
{ "attachmentId": "ANGjdJ...", "size": 48213, "data": "<base64url>", "dataBase64": "<standard base64>" }
```

`data` is Gmail's native base64url encoding; `dataBase64` is the same bytes
re-encoded as standard base64 for convenience (e.g. writing to a file, embedding
in a new outbound attachment).

**One-call read + attachment example:**

```bash
MSG=$(curl -s -H "Authorization: Bearer $AGENT_KEY" \
  "$API/api/companies/$COMPANY_ID/gmail/mailboxes/board/messages/$MESSAGE_ID")
ATTACHMENT_ID=$(echo "$MSG" | jq -r '.payload.parts[] | select(.filename != "") | .body.attachmentId' | head -1)

curl -s -H "Authorization: Bearer $AGENT_KEY" \
  "$API/api/companies/$COMPANY_ID/gmail/mailboxes/board/messages/$MESSAGE_ID/attachments/$ATTACHMENT_ID" \
  | jq -r '.dataBase64' | base64 -d > downloaded-file
```

## Where board@ keeps DMARC aggregate reports

DMARC aggregate reports sent to `board@tryauranode.com` live under the **`DMARC`**
label (`Label_2`), **archived** — they are deliberately not in `INBOX`. Anything
reading them must ask for the label explicitly:

```
GET /api/companies/:companyId/gmail/mailboxes/board/messages?q=label:DMARC
```

An unfiltered listing is **not** equivalent: it returns whatever is newest and
buries the reports behind unrelated mail.

**Gmail filters on board@ must never add `TRASH`.** Two filters previously did
(`addLabelIds: ["Label_2", "TRASH"]`), which routed every incoming aggregate
straight to Trash. Gmail purges Trash after ~30 days, so the reports were being
destroyed on a rolling basis and the deliverability sensor read an empty mailbox —
a silent, self-erasing data loss. The filters now use
`addLabelIds: ["Label_2"]`, `removeLabelIds: ["INBOX", "UNREAD"]`. If you recreate
or edit them, keep it that way. (Gmail filters cannot be edited in place — only
deleted and recreated — so re-adding `TRASH` by accident is easy.)

Two consumer-facing details, both of which have caused silent breakage:

- The **list** endpoint returns `{ id, threadId }` only — no `subject`/`from`.
  Do not filter a listing on those fields; they are always `undefined`.
- Reports arrive compressed, and the format varies by reporter: Google sends
  `.zip`, Microsoft/Yahoo/AOL send `.gz`. Handle both, or you drop roughly half
  the corpus without any error.

## Send

```
POST /api/companies/:companyId/gmail/mailboxes/:mailbox/messages
```

```json
{
  "to": "someone@example.com",
  "subject": "Subject line",
  "body": "Plain-text body",
  "replyToMessageId": "optional — threads as a reply to this message",
  "cc": "optional — string or string[]",
  "replyTo": "optional — emits a Reply-To: header",
  "attachments": [
    { "filename": "report.pdf", "mimeType": "application/pdf", "contentBase64": "<standard base64>" }
  ],
  "ceoApprovalId": "optional — required only if the send is gated, see Outbound gate below"
}
```

## Threaded reply

```
POST /api/companies/:companyId/gmail/mailboxes/:mailbox/reply
```

```json
{
  "replyToMessageId": "or use threadId to reply to the thread's latest message",
  "threadId": "optional if replyToMessageId is given",
  "body": "Reply text",
  "cc": "optional — string or string[]",
  "replyTo": "optional",
  "attachments": [ { "filename": "...", "mimeType": "...", "contentBase64": "..." } ],
  "ceoApprovalId": "optional — required only if the reply is gated, see Outbound gate below",
  "allowSelfAddressed": "optional — opt in to a reply addressed only to our own domain"
}
```

The reply is resolved against the original message (or the thread's last message):
`Subject` gets a `Re:` prefix (no double-prefix), `In-Reply-To`/`References` headers
are set from the original message, and `threadId` is preserved so Gmail keeps the
message in the same thread. When `attachments` is non-empty, the raw message is
built as `multipart/mixed` (a `text/plain` part plus one base64 part per attachment);
with no attachments it stays a plain `text/plain` message, byte-for-byte the same as
before this feature existed.

**One-call threaded reply with cc + attachment example:**

```bash
curl -s -X POST -H "Authorization: Bearer $AGENT_KEY" -H "Content-Type: application/json" \
  "$API/api/companies/$COMPANY_ID/gmail/mailboxes/board/reply" \
  -d '{
    "replyToMessageId": "'"$MESSAGE_ID"'",
    "body": "Thanks — see the attached summary.",
    "cc": "manager@example.com",
    "replyTo": "board@tryauranode.com",
    "attachments": [{ "filename": "summary.txt", "mimeType": "text/plain", "contentBase64": "'"$(base64 -w0 summary.txt)"'" }]
  }'
```

### A returned message id proves DISPATCH, not delivery to the intended party (AUR-4479)

`POST .../reply` returns `201` with a Gmail message id whenever Gmail accepted the
message. That is **not** evidence the mail reached the person you meant to answer.
Gmail will happily accept — and return an id for — a message addressed to our own
alias, which reaches nobody. **Read the resolved recipient back and assert on it:**

```bash
curl -s -X POST ... "$API/.../reply" -d '{ "threadId": "...", "body": "..." }' \
  | jq -e '.resolvedRecipient | test("@tryauranode\\.com$") | not'   # fails if we self-addressed
```

The `201` body now carries `resolvedRecipient` (the address the reply was actually
sent to) and `recipientSourceMessageId` (the thread message that address came from).

**Recipient resolution never self-addresses.** The recipient used to be taken from
the `From:` of the thread's last message. That is correct only when the last message
is inbound — on any follow-up *we* spoke last, so `From:` was our own alias and the
reply was addressed to ourselves, sent successfully, and reached nobody (gmail msg
`19f98227a5d306dc`). Resolution now walks the thread **backwards** to the last
message whose sender is not one of our aliases and replies to them. If the thread
has no external participant at all, the call **throws instead of sending**.

A genuinely self-addressed send (capability probes, invoice/booking smoketests) is
still possible, but must be declared with `"allowSelfAddressed": true` so a self-send
is always a deliberate act, never an accident. The same rule is enforced one level
down in `sendMessage()`: a *threaded* send whose entire recipient set is on our own
domain is rejected outright.

### "Not us" was the wrong question — prospecting must reach a HUMAN (AUR-5732)

The AUR-4479 read-back above asks *"is the recipient not us?"*. It never asks *"is
the recipient the prospect?"* — so the 2026-07-29 Help at Home resend passed
verification while going straight back into a helpdesk ticket queue.

`Coupa@helpathome.com` is not a person; it is Help at Home's "Great Support" queue.
Every one of our ~9 touches auto-opened a new support ticket, and on 2026-08-11 five
of them were closed and merged into an unrelated landscaping-invoice ticket. All 18
AUR-681 contact paths were role/queue/shared inboxes. Ten weeks, ~14 accounts, one
substantive reply — from a helpdesk agent on queue duty, not a buyer.

Two fields close it, both on `POST .../messages` and `POST .../reply`:

| field | effect |
| --- | --- |
| `prospecting: true` | turns on the **recipient-shape check**. A role/queue-shaped recipient (in `to` **or** `cc`) is refused unless `queueJustification` (≥20 chars) says why the queue is right for this send. Naming a human does **not** excuse mailing a queue — that was the exact AUR-681 pattern. A human-shaped recipient still requires `recipientPersonName`, so "who is this for?" is answered before the send. |
| `intendedRecipient` | the prospect address recorded on the tracker row. The address actually placed in `To:` must equal it. On a **reply** this is checked against the recipient *resolved from the thread*, which is the only place a queue auto-responder can silently take the conversation over. |

Both are opt-in per send: replying to a support queue that wrote to **us** first is
legitimate and stays unblocked. Violations are `422` (fix the recipient), not `403`
(get approval) — see `server/src/services/outbound-recipient-shape.ts`.

### Naming a human is not the same as knowing you've reached them (AUR-5735/AUR-5737)

The shape check above only asks whether an address *looks* like a person. AUR-5735
then researched sixteen accounts and wrote six addresses derived from a confirmed org
email pattern (e.g. `first.last@domain`) but **never actually observed** for the named
person — human-shaped, plausible, and unverified. Every one of them satisfies
`recipientPersonName` trivially, so the shape check alone would let all six through.

Two more fields, required whenever `prospecting: true` and the recipient is
`named_human`-shaped:

| field | effect |
| --- | --- |
| `evidenceGrade` | how the caller knows this address reaches `recipientPersonName`: `"verified"` \| `"pattern_hypothesis"` \| `"queue_only_confirmed"` \| `"none"`. Only `"verified"` (the address was directly observed — a header, a signed document, an org directory, or a confirmed person/switchboard reply) clears the bar on its own. Anything else — including an omitted or unrecognized grade — fails closed. |
| `evidenceJustification` | why sending on non-`verified` evidence is nonetheless correct for this specific send (≥20 chars), the same override shape as `queueJustification`. |

```bash
curl -s -X POST ... "$API/.../messages" -d '{
  "to": "abbey.jones@sonoco.com",
  "subject": "...",
  "body": "...",
  "prospecting": true,
  "recipientPersonName": "Abbey Jones",
  "evidenceGrade": "pattern_hypothesis",
  "evidenceJustification": "Sole named procurement contact at this account; time-sensitive deal, sending anyway."
}'
```

Omitting `evidenceGrade`/`evidenceJustification` on a named-human prospecting send now
fails closed with a `422`, even though the field was optional before AUR-5737 — see
`server/src/services/outbound-recipient-shape.ts`.

The `201` body now also carries `intendedRecipientMatched`: `true`/`false` when an
`intendedRecipient` was declared, and `null` when none was — so absence stays visible
instead of reading as a pass.

```bash
curl -s -X POST ... "$API/.../reply" -d '{
  "threadId": "'"$THREAD_ID"'",
  "body": "...",
  "prospecting": true,
  "recipientPersonName": "Zachary Welsher",
  "intendedRecipient": "zwelsher@helpathome.com"
}' | jq -e '.intendedRecipientMatched == true'
```

## Outbound gate (CEO-approval chokepoint)

Every outbound send — `POST .../messages` and `POST .../reply` alike — is
classified by `classifyGmailOutbound()` (`server/src/services/gmail-outbound-guard.ts`)
**inside `sendMessage()` itself** (AUR-2525 / AUR-2682 / AUR-3523). Because
`replyInThread()` delegates to `sendMessage()`, there is no in-repo send path —
route, intake auto-reply, or a future script calling `createGmailService()`
directly — that skips classification.

A send is **gated** (blocked by default) when either is true:
- The recipient (`to` or `cc`) is on the absolute domain blocklist
  (`BLOCKED_RECIPIENT_DOMAINS`: `bunq.com`, `shopify.com`, `cert.gov.ua`,
  `shopifylegal.zendesk.com`) — content is irrelevant, this always blocks.
- The subject/body matches a fraud/abuse/legal/chargeback/law-enforcement
  content signal **and** the recipient is external (outside `tryauranode.com`).

**To unblock a gated send:** attach `ceoApprovalId` — the id of a
`POST .../approvals` row with `type: "request_board_approval"` — to the request
body. The route looks it up scoped to the calling company; only a row with
`status: "approved"` counts as verified.

**AUR-3628 — the approval must be scoped to this exact send.** It is not
enough for the approval to be `approved`; its `payload` must carry a
`gmailOutbound` block that matches the mailbox and target recipient (and, if
present, subject) of the send being made:
```json
{
  "type": "request_board_approval",
  "payload": {
    "gmailOutbound": { "mailbox": "board", "to": "report@bunq.com" }
  }
}
```
An approval that is `approved` but was granted for a different
mailbox/recipient (or isn't `request_board_approval` with a `gmailOutbound`
block at all) is treated the same as no approval — it cannot be reused to
unblock an unrelated gated send. If gated and no validly-scoped approval is
attached:
- The request is rejected with **HTTP 403** (message references AUR-2525 and
  explains how to request approval).
- A high-priority incident issue is filed (fire-and-forget) and assigned to the
  calling agent, describing the classification, signals, and how to unblock
  (including the required `gmailOutbound` payload shape).

Non-gated sends (internal recipients, no risk signals) pass through unaffected —
same behavior as before this gate existed. Every send is also `logger.info`- or
`logger.error`-logged for audit trail.

```json
{
  "to": "report@bunq.com",
  "subject": "Fraud report",
  "body": "We are reporting an account takeover.",
  "ceoApprovalId": "<id of an approved request_board_approval row scoped via gmailOutbound.mailbox/to>"
}
```
Without a valid, correctly-scoped `ceoApprovalId` the call above returns 403
and files an incident issue; with one, it sends normally.

**Header injection (AUR-3628).** `to`, `cc`, `subject`, `replyTo`, and
attachment `filename` are rejected with **HTTP 400** if they contain a CR or
LF character, before being interpolated into the raw RFC822 message
(defense-in-depth — the outbound guard's recipient scan already tokenizes
CRLF-smuggled recipients for classification purposes).

## Prospect-suppression gate (AUR-5734 — the "second sink")

AUR-3864 taught the Auranode email-deliverability CLI's dispatcher to refuse a
recipient whose reply history proves they only ever answer with a machine
(`loadUnifiedSuppression()`), and AUR-3749 taught it to refuse role/system
mailboxes and own-domain recipients (`nonProspectReason()`). Both only ever
reached the Resend/dispatcher send path. The Gmail route is a **second sink**:
an agent driving `sendMessage()`/`replyInThread()` directly never consulted
either check, so the exact recipient the dispatcher had already learned to
refuse — Help at Home's `coupa@` ticket-queue mailbox, answered twice by a
machine and zero times by a human — kept being resent to over this route.

`sendMessage()` now consults the SAME truth as the dispatcher for every
**external** recipient (`to` + `cc`, own-domain addresses are exempt) before
building the Gmail client. It does not re-implement the predicate: it shells
out to the canonical Auranode checkout's `check-recipient.ts`
(`server/src/services/gmail-prospect-guard.ts`, `checkProspectSendability()`),
which imports `loadUnifiedSuppression()`/`nonProspectReason()` unchanged.
Paperclip and Auranode are separately deployed repos with no shared package
graph but are colocated on this host — this subprocess call is the reuse
seam, not a second copy of the logic.

**A refusal is a `GmailProspectSuppressedError`, HTTP 403**, naming the
address and the evidence verbatim (e.g. `machine-only mailbox: 2 automated
replies, 0 human`), same as the CLI's run log — never a silent drop. Like the
outbound gate above, a blocked send files a high-priority incident issue
(fire-and-forget, assigned to the calling agent) via
`fileProspectSuppressedIncident()` in `server/src/routes/gmail.ts`. **The
account is not disqualified — only this automated route into it** — the
incident's guidance is to find a verified human contact, not to give up on
the account.

**Fails open, loudly, on infra failure.** If the Auranode checkout can't be
found or the subprocess errors/times out, `checkProspectSendability()` logs at
`error` level and returns `null` rather than throwing; `sendMessage()` treats
`null` as "unable to verify" and lets the send proceed. The underlying
predicate is itself deliberately fail-open (silence is not evidence of a
machine-only mailbox — see `machine-only-suppression.ts`); an infra hiccup on
this side of the subprocess boundary is a weaker signal still, and
hard-blocking every external Gmail send whenever the sibling checkout is
briefly unavailable would be a worse outage than the one this guard exists to
prevent.

`AURANODE_REPO_DIR` (default `/home/ievgen/Auranode`) overrides which
checkout the subprocess is run against — set it in tests to point at a
fixture or a branch worktree.

**Exempt when the CEO already approved this exact send.** A send whose
`ceoApprovalId` is verified and scoped to this mailbox/`to`/subject (the same
scoping the outbound gate above checks) skips this guard entirely. Role/queue
mailboxes (`report@`, `compliance@`, `security@`) are routinely the *correct*
address for approved business correspondence — a fraud report, a compliance
escalation — and that is not the class of unsupervised cold-send mistake this
guard exists to catch. A human sign-off on this specific recipient outranks
the automated non-prospect heuristic.

## Limits

- Attachments are capped at a ~25MB decoded size (checked against the base64
  payload length before any Gmail API call); oversized attachments return HTTP 400.
- `to`/`replyTo` must be valid email addresses; `cc` accepts a string or array of
  strings (comma-separated entries are also accepted in a single string).

## Also available (unchanged by this doc)

- `GET .../messages` — list messages (`q`, `maxResults`, `pageToken`)
- `GET .../threads`, `GET .../threads/:threadId` — list/get threads
- `GET .../labels`, `PATCH .../messages/:messageId/labels` — labels
- `GET`/`PUT .../settings/vacation` — vacation auto-reply
- `POST /companies/:companyId/gmail/intake/poll` — manual intake poll
- `GET /companies/:companyId/mail/conversations` — board-facing conversation dashboard
