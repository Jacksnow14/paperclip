import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { quotaCreditEscalations } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

const execFileAsync = promisify(execFileCallback);

const NOTIFY_FOUNDER_TIMEOUT_MS = 15_000;

/**
 * AUR-4605: `out_of_credits` (see AUR-4144/PR#180's `resultJson.quotaExhaustion`) is not
 * a wait-for-the-clock quota wall -- Anthropic overage is disabled, so a reset does not
 * fix it. Reset-aware retry handles it wrongly (park, reopen, fail, park again,
 * indefinitely -- the AUR-4342 99-dead-run shape). This is the smallest honest
 * escalation: shell out to the proven notify_founder.sh contract (AUR-3930) instead of
 * inventing a transport, and persist the returned Telegram message_id as evidence.
 */
export interface QuotaExhaustionShape {
  outOfCredits?: boolean;
  resetAt?: string | null;
  rateLimitType?: string | null;
  overageDisabledReason?: string | null;
  source?: string | null;
}

export function readQuotaExhaustion(resultJson: unknown): QuotaExhaustionShape | null {
  if (!resultJson || typeof resultJson !== "object") return null;
  const value = (resultJson as Record<string, unknown>).quotaExhaustion;
  if (!value || typeof value !== "object") return null;
  return value as QuotaExhaustionShape;
}

export function isOutOfCreditsResultJson(resultJson: unknown): boolean {
  return readQuotaExhaustion(resultJson)?.outOfCredits === true;
}

// A distinct reset timestamp is a distinct episode -- a fresh window that is STILL out
// of credits is new, actionable news, not a repeat of the same failed run.
function buildEpisodeKey(quota: QuotaExhaustionShape): string {
  return quota.resetAt ?? "unknown-reset";
}

export function buildOutOfCreditsMessage(input: {
  agentName: string;
  quota: QuotaExhaustionShape;
  issueUrl?: string | null;
}): string {
  const resetText = input.quota.resetAt ? input.quota.resetAt : "an unknown time";
  const rateLimitType = input.quota.rateLimitType ?? "quota";
  const lines = [
    `Paperclip: agent "${input.agentName}" is OUT OF CREDITS (${rateLimitType} wall, ` +
      `overageDisabledReason=${input.quota.overageDisabledReason ?? "out_of_credits"}).`,
    `This will NOT self-heal at the ${resetText} reset -- overage is disabled, so retrying ` +
      `after reset will hit the same wall. Required action: buy credits or raise the spending cap.`,
  ];
  if (input.issueUrl) lines.push(`Issue: ${input.issueUrl}`);
  return lines.join("\n");
}

export interface MaybeEscalateOutOfCreditsInput {
  companyId: string;
  agentId: string;
  agentName: string;
  runId: string;
  issueId?: string | null;
  issueUrl?: string | null;
  resultJson: unknown;
}

export interface MaybeEscalateOutOfCreditsResult {
  escalated: boolean;
  reason: "not_out_of_credits" | "already_escalated" | "sent" | "send_failed";
  telegramMessageId?: string | null;
}

export interface MaybeEscalateOutOfCreditsOptions {
  notifyFounderScript?: string;
}

function parseTelegramMessageId(stdout: string): string | null {
  const match = stdout.match(/message_id=(\S+)/);
  if (!match) return null;
  return match[1] === "?" ? null : match[1];
}

/**
 * Called once per failed heartbeat run. Idempotent per credit-exhaustion episode (see
 * `quota_credit_escalations_company_agent_episode_uq`): only a SUCCESSFUL Telegram send
 * writes a row, so a delivery failure does not permanently suppress the next attempt --
 * it relies on notify_founder.sh's own fleet-wide rate guard to bound repeated attempts
 * during an outage.
 */
export async function maybeEscalateOutOfCredits(
  db: Db,
  input: MaybeEscalateOutOfCreditsInput,
  options: MaybeEscalateOutOfCreditsOptions = {},
): Promise<MaybeEscalateOutOfCreditsResult> {
  const quota = readQuotaExhaustion(input.resultJson);
  if (!quota || quota.outOfCredits !== true) {
    return { escalated: false, reason: "not_out_of_credits" };
  }

  const episodeKey = buildEpisodeKey(quota);

  const existing = await db.query.quotaCreditEscalations.findFirst({
    where: and(
      eq(quotaCreditEscalations.companyId, input.companyId),
      eq(quotaCreditEscalations.agentId, input.agentId),
      eq(quotaCreditEscalations.episodeKey, episodeKey),
    ),
  });
  if (existing) {
    return { escalated: false, reason: "already_escalated" };
  }

  const notifyFounderScript =
    options.notifyFounderScript ??
    process.env.PAPERCLIP_NOTIFY_FOUNDER_SCRIPT ??
    "/home/ievgen/bot/notify_founder.sh";
  const message = buildOutOfCreditsMessage({
    agentName: input.agentName,
    quota,
    issueUrl: input.issueUrl,
  });

  let stdout: string;
  try {
    const result = await execFileAsync(notifyFounderScript, ["SEV2", message], {
      timeout: NOTIFY_FOUNDER_TIMEOUT_MS,
    });
    stdout = result.stdout;
  } catch (err) {
    logger.error(
      { err, companyId: input.companyId, agentId: input.agentId, runId: input.runId },
      "out-of-credits founder escalation: notify_founder.sh delivery failed",
    );
    return { escalated: false, reason: "send_failed" };
  }

  const telegramMessageId = parseTelegramMessageId(stdout);
  await db
    .insert(quotaCreditEscalations)
    .values({
      companyId: input.companyId,
      agentId: input.agentId,
      runId: input.runId,
      issueId: input.issueId ?? null,
      episodeKey,
      rateLimitType: quota.rateLimitType ?? null,
      overageDisabledReason: quota.overageDisabledReason ?? null,
      resetAt: quota.resetAt ? new Date(quota.resetAt) : null,
      telegramMessageId,
    })
    .onConflictDoNothing();

  return { escalated: true, reason: "sent", telegramMessageId };
}
