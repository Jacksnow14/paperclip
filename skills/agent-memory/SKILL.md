---
name: agent-memory
required: false
description: >
  Store and recall durable, cross-session notes for a Paperclip agent via
  the AUR-5952 agent memory API (semantic search over a per-agent store).
  Use at the start of a session to load relevant prior context, and during
  a session to save decisions/findings worth remembering next time.
---

# Agent Memory

Paperclip agents run one heartbeat at a time with no memory of prior
sessions except what's in the issue thread. The agent memory API
(`/v1/memory`, see `packages/memory-sdk` and `server/src/routes/agent-memory.ts`)
gives an agent its own semantically-searchable notebook that survives
across sessions — separate from the platform's issue/comment history and
separate from the unrelated `memory_records` note system used elsewhere in
this repo.

## When to use this skill

- **On wake**, before starting new work: search your memory for anything
  relevant to the task at hand, so you don't re-derive facts you already
  learned in a prior session.
- **Before ending a session**, when you learned something durable and
  non-obvious that would help a future session on similar work: a root
  cause, a gotcha, an environment limitation, a decision and its reasoning.

This is for an *individual agent's own* working notes — not a replacement
for the company-wide Paperclip Memory system (`/api/companies/:companyId/memory/*`,
covered by the memory-capture doctrine in your instructions) and not a
substitute for posting findings to the issue thread, which remains the
system of record other agents and humans read.

## Setup

```ts
import { MemoryClient } from "@paperclipai/memory-sdk";

const memory = new MemoryClient({
  baseUrl: process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100",
  apiKey: process.env.PAPERCLIP_AGENT_API_KEY!,
});
```

## Auto-load top-K memories on wake

```ts
const relevant = await memory.search(taskDescription, { limit: 5 });
if (relevant.length > 0) {
  console.log("Relevant memories from prior sessions:");
  for (const hit of relevant) {
    console.log(`- (${hit.score.toFixed(2)}) ${hit.content}`);
  }
}
```

Only act on hits with a meaningfully high score — low-score results are
noise, not a match. There is no fixed cutoff; use judgment (a `0.85` on a
short, specific query is a strong hit, a `0.3` is not).

## Saving a memory

```ts
await memory.store(
  "AUR-5952: local pnpm install OOMs on this host under concurrent agent load — hand-author migrations/services instead of running drizzle-kit generate, and disclose the gap rather than fabricating a passing test run.",
  { namespace: "lessons" },
);
```

Keep entries short, specific, and dated implicitly by content (mention the
issue id or concrete fact, not "recently" or "yesterday"). Use `namespace`
to separate concerns if useful (e.g. `"lessons"` vs `"todo"` vs default) —
it's just a partition within your own memories, not a security boundary.

## Forgetting

```ts
await memory.forget(hit.id);
```

Delete a memory once it's confirmed stale or wrong — don't leave incorrect
notes for a future session to trust.
