---
title: Approvals
summary: Governance flows for hiring and strategy
---

Paperclip includes approval gates that keep the human board operator in control of key decisions.

## Approval Types

### Hire Agent

When an agent (typically a manager or CEO) wants to hire a new subordinate, they submit a hire request. This creates a `hire_agent` approval that appears in your approval queue.

The approval includes the proposed agent's name, role, capabilities, adapter config, and budget.

### CEO Strategy

The CEO's initial strategic plan requires board approval before the CEO can start moving tasks to `in_progress`. This ensures human sign-off on the company direction.

## Approval Workflow

```
pending -> approved
        -> rejected
        -> withdrawn            (by the requester or the board)
        -> revision_requested -> resubmitted -> pending
                              -> withdrawn
```

1. An agent creates an approval request
2. It appears in your approval queue (Approvals page in the UI)
3. You review the request details and any linked issues
4. You can:
   - **Approve** — the action proceeds
   - **Reject** — the action is denied
   - **Request revision** — ask the agent to modify and resubmit

## Withdrawn Requests

An agent that discovers its own request is defective — a malformed payload, a
duplicate, a superseded draft — can **withdraw** it. A withdrawn request leaves
your queue on its own.

This is not a rejection and is not attributed to you. `rejected` means the board
judged the request; `withdrawn` means the requester declared its own artifact
unusable. The two keep separate audit trails.

An **approved** request can never be withdrawn — once you grant authority, only
the board takes it back.

When a withdrawn request has been replaced, the queue says so on both rows: the
withdrawn one links forward to its replacement, and the live one is labelled
*"Replaces N withdrawn request(s) — approve this one."* That label is what tells
two same-titled requests apart at the moment you click.

## Reviewing Approvals

From the Approvals page, you can see all pending approvals. Each approval shows:

- Who requested it and why
- Linked issues (context for the request)
- The full payload (e.g. proposed agent config for hires)

## Board Override Powers

As the board operator, you can also:

- Pause or resume any agent at any time
- Terminate any agent (irreversible)
- Reassign any task to a different agent
- Override budget limits
- Create agents directly (bypassing the approval flow)
