# Email Operating Playbook for Agent-Owned Replies

This playbook answers the board's operating questions for Paperclip email handling and matches the mailbox routing implemented in AUR-1282.

## Decision

Do **not** create a separate Email Sender agent.

Outbound email is owned by the accountable domain owner. Gmail is the transport layer only. Inbound email is routed by mailbox and topic to the mailbox owner, who decides whether to draft, reply, delegate, escalate, or leave the thread for human review.

## Mailbox Ownership

| Mailbox | Owner | Primary scope |
| --- | --- | --- |
| `board@tryauranode.com` | CEO triage | Board, executive, and sensitive approvals |
| `alex@tryauranode.com` | CMO | Growth, sales, content, partnerships, customer comms |
| `leo@tryauranode.com` | CTO | Technical, vendor, infra, developer, security-adjacent comms |
| `adrian@tryauranode.com` | CFO | Finance, banking, tax, accounting, admin |

Ownership is not a shared sender queue. If a reply needs a business decision, the mailbox owner remains accountable for the content and outcome.

## Inbound Workflow

1. Gmail intake polls each supported mailbox.
2. New messages are turned into issues in `todo` so the owner can act immediately.
3. Existing threads get a system comment with Gmail thread/message metadata so reply handling can continue on the same issue.
4. The intake pipeline applies `paperclip/triaged` after processing.
5. The mailbox owner reviews the issue and chooses one of four actions:
   - draft a reply
   - send a reply
   - delegate to another agent
   - escalate for approval or human judgment

Issue status guidance:

- `todo` - waiting for the mailbox owner to start.
- `in_progress` - reply drafting, review, or send work is actively underway.
- `in_review` - waiting for manager or board approval before send.
- `blocked` - waiting on outside information or a first-class blocker.
- `done` - the thread is answered or no reply is needed.

## Approval Gates

High-risk outbound requires approval before send:

- legal commitments
- tax or accounting commitments
- finance or banking commitments
- pricing promises or discounts
- security claims
- refunds or compensation commitments
- contract terms or legal position statements
- anything that speaks as the board

If the reply is sensitive, the owner should route it to the CEO or board for approval rather than sending directly.

## Labels And Status Semantics

Use Gmail labels as operational markers, not as ownership replacement:

- `paperclip/triaged` - intake has processed the message and recorded it in Paperclip.
- `paperclip/needs-reply` - reply is pending and the issue still requires attention.
- `paperclip/replied` - the reply has been sent or the thread is otherwise resolved.

These labels support mailbox hygiene and visibility. They do not change business ownership.

Paperclip issue status captures the work state:

- `todo` - owned, not started
- `in_progress` - active drafting or send work
- `in_review` - awaiting approval
- `blocked` - waiting on an external blocker
- `done` - thread closed

## What Each Owner May Send Without Further Approval

### CEO / `board@tryauranode.com`

- triage acknowledgements
- requests for clarification
- approval or rejection of sensitive asks
- executive routing responses

### CMO / `alex@tryauranode.com`

- meeting scheduling and follow-up
- marketing or partnership acknowledgements
- customer communication that is factual and non-committal
- requests for more information before deciding

### CTO / `leo@tryauranode.com`

- technical acknowledgements
- vendor and infrastructure coordination
- developer support replies
- requests for logs, repro steps, or diagnostics

CTO replies must avoid commitments on incidents, timelines, root cause, security posture, or remediation dates unless approved.

### CFO / `adrian@tryauranode.com`

- invoice and payment coordination
- bookkeeping and admin follow-up
- bank, tax, and accounting information requests
- receipt acknowledgements

CFO replies must avoid tax, banking, or financial commitments without approval.

## Escalation Rules

Escalate instead of replying directly when:

- the message asks for a promise, guarantee, refund, or exception
- the message could create legal, tax, financial, or security exposure
- the message speaks for the company or board
- the owner is not clearly the right mailbox owner
- the issue crosses multiple domains and needs a single accountable decision

When in doubt, keep the thread visible in Paperclip and route it to the accountable owner rather than inventing a new sender role.

## Reply-To Strategy for auranode.ai Outbound

Any email sent from an `auranode.ai` Resend address must set the `Reply-To` header to the
owning `@tryauranode.com` mailbox so replies are routed through the Gmail intake pipeline.

Use the exported helper:

```ts
import { replyToForMailbox } from "../services/gmail.js";
// e.g. replyToForMailbox("alex") → "alex@tryauranode.com"
```

Routing table:

| Resend sender domain | Owning mailbox | Reply-To |
| --- | --- | --- |
| `*@auranode.ai` (CMO) | alex | `alex@tryauranode.com` |
| `*@auranode.ai` (CTO) | leo | `leo@tryauranode.com` |
| `*@auranode.ai` (CFO) | adrian | `adrian@tryauranode.com` |
| `*@auranode.ai` (board) | board | `board@tryauranode.com` |

This keeps a single inbound pipeline: every reply lands in the matching Gmail mailbox and is
picked up by the Gmail intake, which creates or updates the corresponding Paperclip issue.

## SLA Aging and Needs-Reply Visibility

The intake pipeline tracks when each inbound email was received. An SLA aging endpoint is
available for the dashboard:

```
GET /api/companies/:companyId/gmail/intake/aging?slaBusinessDays=2
```

Response fields per record:

- `issueId` — the Paperclip issue tracking this thread
- `mailbox` — which @tryauranode.com mailbox received it
- `sender` — external sender address
- `receivedAt` — timestamp of first message in thread
- `replyDueAt` — `receivedAt` + N business days
- `isOverdue` — boolean, true when now > replyDueAt
- `businessDaysOverdue` — how many business days past the SLA deadline

Records are sorted by `replyDueAt` ascending (most urgent first). Only open issues (not `done`
or `cancelled`) appear. The default SLA is 2 business days; override with `?slaBusinessDays=N`
(1–30).

## Short Form

- Outbound owner: the accountable domain owner
- Inbound owner: the mailbox owner assigned by routing
- Separate Email Sender agent: no
- Gmail role: transport and thread storage only
- Approval rule: high-risk replies require manager or board approval before send
- Reply-To rule: auranode.ai outbound must set Reply-To to the owning @tryauranode.com mailbox

