import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

/**
 * AUR-4605: one row per delivered founder escalation for an `out_of_credits` quota
 * wall. Only ever written on a SUCCESSFUL Telegram send (see
 * server/src/services/quota-founder-escalation.ts) -- a failed send writes no row, so
 * the next failing run in the same episode retries rather than being silently
 * suppressed forever. The unique index is therefore sufficient without a status
 * column: this table only ever holds "sent" evidence.
 */
export const quotaCreditEscalations = pgTable(
  "quota_credit_escalations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    // Identifies the credit-exhaustion episode this escalation covers. Derived from
    // the provider's reset timestamp so repeated failures against the same wall
    // dedupe, while a genuinely new window (a fresh resetAt) is a new episode.
    episodeKey: text("episode_key").notNull(),
    rateLimitType: text("rate_limit_type"),
    overageDisabledReason: text("overage_disabled_reason"),
    resetAt: timestamp("reset_at", { withTimezone: true }),
    telegramMessageId: text("telegram_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentEpisodeUq: uniqueIndex("quota_credit_escalations_company_agent_episode_uq").on(
      table.companyId,
      table.agentId,
      table.episodeKey,
    ),
    companyCreatedIdx: index("quota_credit_escalations_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
  }),
);
