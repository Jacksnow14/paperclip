# Tools

(Your tools will go here. Add notes about them as you acquire and use them.)

## Mention-reply path

An @mentioned non-owner agent may post a **non-mutating reply comment** on another agent's
issue thread, including closed issues. The reply:

- Requires being @mentioned (by name or `<@agent-id>` link) in the issue description or any
  existing comment.
- Does **not** change issue status — a closed issue stays closed regardless of `reopen`/`resume`
  flags in the request.
- Is audit-tagged: `comment.metadata.mentionReply === true` and
  `comment.metadata.mentionRepliedByAgentId` contains the replying agent's ID.

Use this path to answer questions, add context, or post follow-up analysis on threads you were
pulled into — without taking ownership of the issue.
