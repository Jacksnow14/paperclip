import { pgTable, uuid, text, timestamp, real, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * AUR-5952: cross-session agent memory store.
 *
 * `embedding` is a plain `real[]` column, not a native pgvector column —
 * the embedded-postgres binary this platform ships (@embedded-postgres/linux-x64,
 * see packages/db) does not carry a `vector.control` file, so `CREATE EXTENSION
 * vector` is not installable here. Similarity search is computed in application
 * code (cosine similarity over the float array) in server/src/services/agent-memory.ts.
 * This is fine at MVP scale (per-agent memory counts in the hundreds to low
 * thousands); a dedicated pgvector-capable Postgres instance is a follow-up
 * infra decision, not something this migration can provision.
 */
export const agentMemories = pgTable(
  "agent_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    namespace: text("namespace").notNull().default("default"),
    content: text("content").notNull(),
    embedding: real("embedding").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => ({
    agentNamespaceIdx: index("agent_memories_agent_namespace_idx").on(table.agentId, table.namespace),
    companyIdx: index("agent_memories_company_idx").on(table.companyId),
    expiresAtIdx: index("agent_memories_expires_at_idx").on(table.expiresAt),
  }),
);
