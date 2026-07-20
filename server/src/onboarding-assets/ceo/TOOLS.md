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

## Control-plane API reachability (on-host agents)

Locally-spawned agents/scripts are handed `PAPERCLIP_API_URL` in their env — use it as-is,
first attempt, with no manual override. The value is now the on-host loopback address
(`http://127.0.0.1:{port}`), not the public IP: the public IP hairpin-NATs/hangs when a
local agent calls back into its own host's server, so `buildPaperclipEnv` rewrites the host to
`127.0.0.1` for locally-executed adapters before the env reaches the child process.

- Do **not** hand-edit `PAPERCLIP_API_URL` to `127.0.0.1` yourself — it is already correct.
- If a script needs a fallback list of candidate base URLs (e.g. to probe multiple reachable
  addresses), read `PAPERCLIP_RUNTIME_API_CANDIDATES_JSON` (a JSON array of URL strings) when
  present in the env instead of hardcoding hosts.
- This only applies to on-host/local adapters. Remote/cloud adapters keep using the public URL,
  since they are not on the same host as the server.
