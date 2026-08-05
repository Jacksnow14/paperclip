import { and, eq, gte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { readRawUsageTotals } from "./heartbeat.js";

export interface AgentTokenBudgetPolicy {
  windowMs: number;
  maxTokensPerWindow: number;
  maxTokensPerRun: number;
}

export interface AgentTokenBudgetBreach {
  agentId: string;
  reason: "per_run_ceiling" | "rolling_window_budget";
  policy: AgentTokenBudgetPolicy;
  windowTokens: number;
  breachingRunId: string;
  breachingRunTokens: number;
  /** Earliest instant the breach can self-clear: the run that tipped it, aged out of the window. */
  clearsAt: Date;
}

// AUR-4669: the codex_local and claude_local adapters are shared, subscription-billed
// credentials with a provider-side rolling quota window — not per-call metered spend
// (costUsd is undefined on codex runs, AUR-4157), so budgets.getInvocationBlock's
// dollar-cost hard-stop cannot see this class of overrun at all. AUR-4693 measured the
// codex lane wall itself (CTO Ops alone: 138.1M tokens / 16 runs / ~44h, one run at
// 19.1M) and CFO's prior 187,985,770 tokens / 113 runs. These defaults are sized so no
// single agent can reproduce that pattern inside one rolling day: a per-run ceiling well
// below the observed 19.1M-22.9M outlier runs, and a per-window total well below what one
// agent burned in 44h, while still leaving room for the sustained multi-run-per-day
// pattern AUR-4669 explicitly says is normal here (not a single-outlier-run problem).
export const DEFAULT_AGENT_TOKEN_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_TOKENS_PER_RUN = 12_000_000;
export const DEFAULT_MAX_TOKENS_PER_WINDOW = 30_000_000;

const DEFAULT_POLICY_BY_ADAPTER_TYPE: Record<string, AgentTokenBudgetPolicy> = {
  codex_local: {
    windowMs: DEFAULT_AGENT_TOKEN_BUDGET_WINDOW_MS,
    maxTokensPerRun: DEFAULT_MAX_TOKENS_PER_RUN,
    maxTokensPerWindow: DEFAULT_MAX_TOKENS_PER_WINDOW,
  },
  claude_local: {
    windowMs: DEFAULT_AGENT_TOKEN_BUDGET_WINDOW_MS,
    maxTokensPerRun: DEFAULT_MAX_TOKENS_PER_RUN,
    maxTokensPerWindow: DEFAULT_MAX_TOKENS_PER_WINDOW,
  },
};

interface TokenBudgetOverride {
  windowMs?: number;
  maxTokensPerRun?: number;
  maxTokensPerWindow?: number;
}

// adapterConfig is agent-authored jsonb, not a typed API surface — a non-numeric value
// here (e.g. windowMs: "1d") must be dropped, not trusted: it would flow into
// `new Date(now - NaN)` and throw inside the heartbeat_runs query, and since
// resolveContendedCeiling runs this check for every candidate on every admission pass,
// one malformed override on one agent would abort admission fleet-wide.
function asBudgetNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readOverride(adapterConfig: Record<string, unknown> | null | undefined): TokenBudgetOverride | null {
  const raw = adapterConfig?.tokenBudget;
  if (!raw || typeof raw !== "object") return null;
  const fields = raw as Record<string, unknown>;
  const override: TokenBudgetOverride = {
    windowMs: asBudgetNumber(fields.windowMs),
    maxTokensPerRun: asBudgetNumber(fields.maxTokensPerRun),
    maxTokensPerWindow: asBudgetNumber(fields.maxTokensPerWindow),
  };
  // An override with no valid numeric field is no override at all — in particular it
  // must not opt an unlisted adapter type into enforcement.
  if (
    override.windowMs === undefined &&
    override.maxTokensPerRun === undefined &&
    override.maxTokensPerWindow === undefined
  ) {
    return null;
  }
  return override;
}

// Adapters not in DEFAULT_POLICY_BY_ADAPTER_TYPE stay unenforced unless an agent opts in
// via adapterConfig.tokenBudget — this is a lane-sharing guard for shared-credential
// adapters, not a blanket cap on every adapter type (API-billed adapters already have a
// cost-based stop via budgets.getInvocationBlock).
export function resolveAgentTokenBudgetPolicy(agent: {
  adapterType: string;
  adapterConfig: Record<string, unknown> | null | undefined;
}): AgentTokenBudgetPolicy | null {
  const override = readOverride(agent.adapterConfig);
  // maxTokensPerWindow: 0 is the explicit opt-out, even for adapters with a shipped default.
  if (override?.maxTokensPerWindow === 0) return null;
  const base = DEFAULT_POLICY_BY_ADAPTER_TYPE[agent.adapterType] ?? null;
  if (!base && !override) return null;
  return {
    windowMs: override?.windowMs ?? base?.windowMs ?? DEFAULT_AGENT_TOKEN_BUDGET_WINDOW_MS,
    maxTokensPerRun: override?.maxTokensPerRun ?? base?.maxTokensPerRun ?? DEFAULT_MAX_TOKENS_PER_RUN,
    maxTokensPerWindow: override?.maxTokensPerWindow ?? base?.maxTokensPerWindow ?? DEFAULT_MAX_TOKENS_PER_WINDOW,
  };
}

// Derives a breach live from heartbeat_runs, the same way findActiveAdapterQuotaPause
// derives its pause — no new column/table, so there's nothing to leave stuck: once the
// breaching run ages out of the rolling window this simply stops matching. Scoped to a
// single agentId (unlike findActiveAdapterQuotaPause's companyId+adapterType scope), so a
// breach here suppresses admission for the offending agent only — the other agents
// sharing the same adapter credential stay admissible, per AUR-4669's acceptance
// criterion that a breach must not become a second lane-wide wall.
export async function findAgentTokenBudgetBreach(
  db: Db,
  agent: { id: string; adapterType: string; adapterConfig: Record<string, unknown> | null | undefined },
  now: Date,
): Promise<AgentTokenBudgetBreach | null> {
  const policy = resolveAgentTokenBudgetPolicy(agent);
  if (!policy) return null;

  const windowStart = new Date(now.getTime() - policy.windowMs);
  const rows = await db
    .select({
      id: heartbeatRuns.id,
      createdAt: heartbeatRuns.createdAt,
      usageJson: heartbeatRuns.usageJson,
    })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.agentId, agent.id), gte(heartbeatRuns.createdAt, windowStart)))
    .orderBy(heartbeatRuns.createdAt);

  let windowTokens = 0;
  // clearsAt is a hint, not a gating decision — the caller re-derives the breach live on
  // every admission check, so an imprecise hint here can never strand an agent past its
  // real clear time. It's the oldest contributing run's timestamp + windowMs: the
  // worst-case instant by which that run has aged out of the window and windowTokens is
  // guaranteed to have dropped by at least its contribution.
  let oldestContributingAt: Date | null = null;
  for (const row of rows) {
    const usage = readRawUsageTotals(row.usageJson);
    if (!usage) continue;
    // Total spend against the provider's rate limit: rawInputTokens (which already
    // includes cache-read tokens, see readRawUsageTotals) plus rawOutputTokens.
    // cachedInputTokens is a breakdown of inputTokens, not an additional cost — summing
    // it in as well would double-count the exact 97.9% AUR-4669 measured.
    const runTokens = usage.inputTokens + usage.outputTokens;
    if (runTokens <= 0) continue;
    if (oldestContributingAt === null) oldestContributingAt = row.createdAt;

    if (runTokens >= policy.maxTokensPerRun) {
      return {
        agentId: agent.id,
        reason: "per_run_ceiling",
        policy,
        windowTokens: windowTokens + runTokens,
        breachingRunId: row.id,
        breachingRunTokens: runTokens,
        clearsAt: new Date(row.createdAt.getTime() + policy.windowMs),
      };
    }

    windowTokens += runTokens;
    if (windowTokens >= policy.maxTokensPerWindow) {
      return {
        agentId: agent.id,
        reason: "rolling_window_budget",
        policy,
        windowTokens,
        breachingRunId: row.id,
        breachingRunTokens: runTokens,
        clearsAt: new Date(oldestContributingAt.getTime() + policy.windowMs),
      };
    }
  }

  return null;
}
