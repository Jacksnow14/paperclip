# @paperclipai/memory-sdk

TypeScript client for the Paperclip agent memory store (AUR-5952): a
per-agent, semantically-searchable memory API — `POST /v1/memory`,
`GET /v1/memory/search`, `DELETE /v1/memory/:id`.

## 5-minute quickstart

```bash
pnpm add @paperclipai/memory-sdk
```

```ts
import { MemoryClient } from "@paperclipai/memory-sdk";

const memory = new MemoryClient({
  baseUrl: "https://api.paperclip.ai", // or your local dev API
  apiKey: process.env.PAPERCLIP_API_KEY!, // the agent's existing Paperclip API key
});

// Store something worth remembering across sessions.
await memory.store("The deploy pipeline runs drizzle-kit migrations before app boot.", {
  namespace: "runbooks",
});

// Later — possibly in a brand new session — search for it back.
const hits = await memory.search("how do migrations run in prod?", { namespace: "runbooks", limit: 5 });
console.log(hits[0]?.content, hits[0]?.score);

// Delete a memory once it's stale or wrong.
await memory.forget(hits[0].id);
```

## API

- `store(content: string, options?: { namespace?: string; expiresAt?: Date | string }): Promise<AgentMemoryRecord>`
- `search(query: string, options?: { namespace?: string; limit?: number }): Promise<AgentMemorySearchResult[]>`
- `forget(id: string): Promise<void>`

All three throw `MemoryClientError` (with `.status` and `.body`) on a non-2xx
response — e.g. a missing/invalid API key (403) or a `forget()` on an id that
doesn't belong to the caller (404).

## Auth

Uses the same per-agent Paperclip API key as every other agent-facing
endpoint — no separate credential to provision. `namespace` is a caller-chosen
partition *within* the calling agent's own memories (e.g. `"runbooks"` vs.
`"scratch"`), not a security boundary; every memory is always scoped to the
agent (and company) that stored it.

## Notes on scale

The store ranks results by cosine similarity computed in the API server, not
via a native vector index — see `packages/db/src/schema/agent_memories.ts`
for why (this platform's embedded Postgres doesn't ship pgvector). This is
fine for an MVP's per-agent memory volumes; a dedicated pgvector-capable
Postgres instance is the tracked follow-up for scale.
