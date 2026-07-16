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
  "ceoApprovalId": "optional — required only if the reply is gated, see Outbound gate below"
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
