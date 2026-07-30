# Runbook: per-agent git identity

Closes AUR-4030 — commits made by agent runs were all attributed to the
shared repo-level `[user] name = Paperclip CTO` identity, which was already
producing false signal (a commit the CTO *reviewed* was recorded as authored
by "Paperclip CTO").

## How it works

`buildPaperclipEnv()` (`packages/adapter-utils/src/server-utils.ts`) is the
single env seed shared by every adapter (`process`, `claude-local`,
`codex-local`, `gemini-local`, `pi-local`, `grok-local`, `cursor-local`,
`cursor-cloud`, `opencode-local`, `acpx-local`, `openclaw-gateway`). When the
`agent` passed in carries a `name` (every adapter call site passes the full
`AdapterAgent`, which always has one), it derives and injects:

- `GIT_AUTHOR_NAME` / `GIT_COMMITTER_NAME` — `"{agent.name} (agent {shortId})"`
- `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_EMAIL` — `"{slug(agent.name)}-{shortId}@agents.paperclip.local"`

`shortId` is the agent's UUID with dashes stripped, truncated to 8 chars, so
different agents get visibly distinct identities without a lookup table.

`GIT_AUTHOR_*`/`GIT_COMMITTER_*` environment variables take precedence over
both repo-level and global `git config user.*`, so this covers every
worktree and every clone an agent might work in — no per-checkout setup, and
nothing for an agent to remember or hand-set. Do **not** tell an agent to run
`git config user.name/user.email` to "fix" attribution; that is the failure
mode this closes, and a hand-set repo config would just get overridden by
these env vars anyway (harmlessly, but it signals the wrong mental model).

## Verifying it's live

Two different agents committing in the same repo in the same hour should
show two distinct, correct identities:

```bash
git log --format='%an <%ae>' -20
```

If every row is still `Paperclip CTO <cto@tryauranode.com>` (or
`Paperclip Agent (unattributed) <agents+unattributed@tryauranode.com>`, the
interim mitigation), the running server has not picked up the
`buildPaperclipEnv()` change yet — check `/api/health` `build.sha` against
the commit that shipped this fix, not just "merged".

To check a single run's own commit:

```bash
git log -1 --format='%an <%ae>'
```

It should read `"<agent name> (agent <8-char id>) <slug-8charid@agents.paperclip.local>"`.

## Historical commits are NOT rewritten

Commits authored before this fix shipped (2026-07-25) carry the shared
identity and **carry zero per-agent information** — do not use them for
per-agent forensics, scorecards, or routing. Treat repo creation through the
fix's deploy date as an unattributed window. This was a deliberate choice
(rewriting history has its own blast radius and would invalidate existing PR
references, review threads, and signed commits); the ambiguity window is
documented here instead.

## Regression test

`server/src/__tests__/paperclip-env.test.ts` → `describe("per-agent git
identity (AUR-4030)")` asserts: no `GIT_*` vars when `name` is absent
(back-compat with the pre-fix call shape), a correctly derived identity when
`name` is present, two agents producing two distinct identities, and safe
slugification of unusual names.
