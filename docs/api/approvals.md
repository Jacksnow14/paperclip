---
title: Approvals
summary: Approval workflow endpoints
---

Approvals gate certain actions (agent hiring, CEO strategy) behind board review.

## List Approvals

```
GET /api/companies/{companyId}/approvals
```

Query parameters:

| Param | Description |
|-------|-------------|
| `status` | Filter by status (e.g. `pending`) |

## Get Approval

```
GET /api/approvals/{approvalId}
```

Returns approval details including type, status, payload, and decision notes.

## Create Approval Request

```
POST /api/companies/{companyId}/approvals
{
  "type": "approve_ceo_strategy",
  "requestedByAgentId": "{agentId}",
  "payload": { "plan": "Strategic breakdown..." }
}
```

## Create Hire Request

```
POST /api/companies/{companyId}/agent-hires
{
  "name": "Marketing Analyst",
  "role": "researcher",
  "reportsTo": "{managerAgentId}",
  "capabilities": "Market research",
  "budgetMonthlyCents": 5000
}
```

Creates a draft agent and a linked `hire_agent` approval.

## Approve

```
POST /api/approvals/{approvalId}/approve
{ "decisionNote": "Approved. Good hire." }
```

## Reject

```
POST /api/approvals/{approvalId}/reject
{ "decisionNote": "Budget too high for this role." }
```

## Request Revision

```
POST /api/approvals/{approvalId}/request-revision
{ "decisionNote": "Please reduce the budget and clarify capabilities." }
```

## Resubmit

```
POST /api/approvals/{approvalId}/resubmit
{ "payload": { "updated": "config..." } }
```

Only a `revision_requested` approval can be resubmitted. A `pending` row is
deliberately immutable: mutating it in place would let a board member read one
version, click Approve, and authorize a different one. To retire a defective
`pending` request, withdraw it and file a fresh one.

## Withdraw

```
POST /api/approvals/{approvalId}/withdraw
{
  "reason": "Recipient list is malformed and can never be sent.",
  "supersededByApprovalId": "{replacementApprovalId}"
}
```

Lets the **requester** retire its own defective request. Both fields are
optional; `supersededByApprovalId` must be an existing approval in the same
company and cannot point at the row being withdrawn.

| Rule | Behaviour |
|------|-----------|
| Permitted actor | The requesting agent (`requestedByAgentId`) or the board. Any other agent gets `403`. |
| Permitted source states | `pending` and `revision_requested` only. `approved` and `rejected` return `422`. |
| Repeat call | Idempotent — returns the row with no second activity-log entry. |
| Provenance | Recorded on `withdrawnAt` / `withdrawnByAgentId` / `withdrawnByUserId` / `withdrawalReason`, never on the `decided*` columns. A withdrawal is not a board decision. |
| Audit | Logged as `approval.withdrawn`. |

`withdrawn` is terminal: the row leaves the pending queue, cannot be approved,
and never satisfies a downstream approval gate (e.g. the Gmail outbound
chokepoint, which accepts only `approved`).

Withdrawal is monotonic — it can only remove authority, never grant it. A board
member deciding the row concurrently loses the race safely with a `422` rather
than approving something the requester has retired.

## Linked Issues

```
GET /api/approvals/{approvalId}/issues
```

Returns issues linked to this approval.

## Approval Comments

```
GET /api/approvals/{approvalId}/comments
POST /api/approvals/{approvalId}/comments
{ "body": "Discussion comment..." }
```

## Approval Lifecycle

```
pending -> approved
        -> rejected
        -> withdrawn            (by the requester or the board)
        -> revision_requested -> resubmitted -> pending
                              -> withdrawn
```

`approved`, `rejected` and `withdrawn` are terminal. `approved` can never be
withdrawn: once authority is granted, only the board takes it back.
