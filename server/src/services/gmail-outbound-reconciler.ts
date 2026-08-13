// AUR-4674: detective control for out-of-band Gmail sends.
//
// The AUR-2525/AUR-2682 chokepoint gates every send that goes THROUGH the
// control plane — but the Workspace SA key is readable by every agent shell on
// this host, so a raw googleapis send with domain-wide delegation bypasses the
// gate entirely. That is exactly how the 2026-07-29 fraud-class sends to
// shopify.com left the building with no approval on file (sent by a co-tenant
// agent via `users().messages().send()` with the key from the instance .env).
//
// Prevention (key rotation / credential isolation) is a founder-dropped track
// (2026-08-12). What remains closable is detection: every chokepoint send
// leaves a gmail_outbound_records row at dispatch time (AUR-1796), so a
// message in the mailbox's SENT label with no row was sent out-of-band. The
// reconciler classifies such messages with the same outbound guard the
// chokepoint uses; a gated category with no approved, scope-matching
// gmailOutbound approval files a critical incident — a silent bypass becomes
// loud within one polling interval.

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, gmailOutboundRecords } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { classifyGmailOutbound } from "./gmail-outbound-guard.js";
import {
  GMAIL_SUPPORTED_ALIASES,
  createGmailService,
  decodeGmailMessageBody,
  extractEmailAddresses,
  type GmailAlias,
} from "./gmail.js";
import { issueService } from "./issues.js";
import { createDailyHealthScheduler, type DailyHealthScheduler } from "./daily-health-scheduler.js";

/** Sweep window: everything in SENT from the last 2 days, newest pass wins. */
const SENT_LOOKBACK_QUERY = "in:sent newer_than:2d";
const MAX_MESSAGES_PER_PASS = 100;

/**
 * Ignore messages younger than this. A chokepoint send inserts its tracking
 * row immediately after dispatch, but the reconciler must not race that write
 * and mint a false critical for a legitimately gated-and-approved send.
 */
const SETTLE_MS = 5 * 60 * 1000;

/**
 * Messages sent before this instant cannot be classified: the chokepoint's
 * tracking insert was silently broken until the live table was converged
 * (0105 / hand-applied, verified live 2026-08-13T02:15Z), so absence of a row
 * proves nothing about how a pre-floor message was sent. Record them as
 * `pre_activation` (so they are not refetched every pass) and never file an
 * incident for them.
 */
const ACTIVATION_FLOOR_MS = Date.parse("2026-08-13T02:20:00Z");

export interface GmailOutboundReconcileSummary {
  scanned: number;
  recorded: number;
  gatedUnapproved: number;
  preActivation: number;
  errors: number;
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function splitScopeRecipients(scopeTo: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (scopeTo ?? "").split(/[,;]/)) {
    const addr = normalizeAddress(part);
    if (addr) out.add(addr);
  }
  return out;
}

/**
 * Mirror of isApprovalScopedToSend (gmail.ts): the approval must be for this
 * mailbox, must cover every To recipient of the message, and — when the
 * approval pinned a subject — that subject must match. Tolerant of the
 * comma-separated multi-recipient `scope.to` lists real approvals carry.
 */
export function approvalScopeCovers(
  scope: { mailbox?: unknown; to?: unknown; subject?: unknown },
  mailbox: string,
  toRecipients: string[],
  subject: string,
): boolean {
  if (typeof scope.mailbox !== "string" || scope.mailbox !== mailbox) return false;
  if (typeof scope.to !== "string") return false;
  const allowed = splitScopeRecipients(scope.to);
  if (allowed.size === 0 || toRecipients.length === 0) return false;
  for (const recipient of toRecipients) {
    if (!allowed.has(normalizeAddress(recipient))) return false;
  }
  if (typeof scope.subject === "string" && scope.subject.trim() !== subject.trim()) return false;
  return true;
}

export function createGmailOutboundReconciler(db: Db) {
  const gmail = createGmailService(db);
  const isvc = issueService(db);

  // Deliberately NOT filtered by company: the mailboxes are org-level, but the
  // chokepoint attributes its tracking row to whichever company's context
  // dispatched the send. A row under ANY company proves the send went through
  // the gate — a company-scoped check here would re-flag another company's
  // legitimate chokepoint send as out-of-band.
  async function hasChokepointRecord(
    mailbox: GmailAlias,
    gmailMessageId: string,
  ): Promise<boolean> {
    const rows = await db
      .select({ id: gmailOutboundRecords.id })
      .from(gmailOutboundRecords)
      .where(
        and(
          eq(gmailOutboundRecords.mailbox, mailbox),
          eq(gmailOutboundRecords.gmailMessageId, gmailMessageId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async function findCoveringApproval(
    companyId: string,
    mailbox: GmailAlias,
    toRecipients: string[],
    subject: string,
  ): Promise<string | null> {
    const rows = await db
      .select({ id: approvals.id, payload: approvals.payload })
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, companyId),
          eq(approvals.status, "approved"),
          eq(approvals.type, "request_board_approval"),
        ),
      );
    for (const row of rows) {
      const scope = (row.payload as Record<string, unknown> | null)?.gmailOutbound;
      if (!scope || typeof scope !== "object") continue;
      if (approvalScopeCovers(scope as Record<string, unknown>, mailbox, toRecipients, subject)) {
        return row.id;
      }
    }
    return null;
  }

  async function resolveIncidentAssignee(companyId: string): Promise<string | null> {
    const roleCandidates = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.role, ["cto", "ceo"])))
      .orderBy(sql`case when ${agents.role} = 'cto' then 0 else 1 end`, asc(agents.createdAt), asc(agents.id));
    return roleCandidates[0]?.id ?? null;
  }

  async function reconcileMailbox(
    companyId: string,
    mailbox: GmailAlias,
  ): Promise<GmailOutboundReconcileSummary> {
    const summary: GmailOutboundReconcileSummary = {
      scanned: 0,
      recorded: 0,
      gatedUnapproved: 0,
      preActivation: 0,
      errors: 0,
    };

    let listData: Awaited<ReturnType<typeof gmail.listMessages>>;
    try {
      listData = await gmail.listMessages(mailbox, {
        query: SENT_LOOKBACK_QUERY,
        maxResults: MAX_MESSAGES_PER_PASS,
      });
    } catch (err) {
      logger.error({ err, companyId, mailbox }, "gmail-outbound-reconciler: failed to list SENT");
      summary.errors++;
      return summary;
    }

    for (const stub of listData.messages ?? []) {
      if (!stub.id) continue;
      try {
        if (await hasChokepointRecord(mailbox, stub.id)) continue;

        const msg = await gmail.getMessage(mailbox, stub.id);
        const sentAtMs = Number(msg.internalDate ?? NaN);
        if (Number.isFinite(sentAtMs) && Date.now() - sentAtMs < SETTLE_MS) continue;

        const headers = msg.payload?.headers;
        const header = (name: string) =>
          (headers ?? []).find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
        const to = header("To");
        const cc = header("Cc");
        const subject = header("Subject");
        const bodyText = decodeGmailMessageBody(msg.payload).bodyText ?? msg.snippet ?? "";

        summary.scanned++;

        // Pre-floor messages predate a working chokepoint tracking insert, so
        // "no row" carries no signal for them — record and move on.
        if (!Number.isFinite(sentAtMs) || sentAtMs < ACTIVATION_FLOOR_MS) {
          const inserted = await db
            .insert(gmailOutboundRecords)
            .values({
              companyId,
              mailbox,
              gmailThreadId: msg.threadId ?? "",
              gmailMessageId: stub.id,
              recipient: to || "(unknown)",
              subject,
              snippet: bodyText.slice(0, 200),
              status: "pre_activation",
              sentAt: Number.isFinite(sentAtMs) ? new Date(sentAtMs) : null,
            })
            .onConflictDoNothing()
            .returning({ id: gmailOutboundRecords.id });
          if (inserted.length > 0) summary.preActivation++;
          continue;
        }

        const decision = classifyGmailOutbound({ to, subject, text: bodyText, cc });
        const toRecipients = extractEmailAddresses(to);
        const coveringApprovalId = decision.gated
          ? await findCoveringApproval(companyId, mailbox, toRecipients, subject)
          : null;
        const gatedUnapproved = decision.gated && !coveringApprovalId;

        // Insert BEFORE filing any incident: winning the row is the dedup
        // guard. If the insert loses the conflict (a prior pass already
        // recorded this message) or throws, no incident is filed — otherwise a
        // persistent DB failure would re-file a fresh critical every polling
        // interval forever.
        const inserted = await db
          .insert(gmailOutboundRecords)
          .values({
            companyId,
            mailbox,
            gmailThreadId: msg.threadId ?? "",
            gmailMessageId: stub.id,
            recipient: to || "(unknown)",
            subject,
            snippet: bodyText.slice(0, 200),
            status: gatedUnapproved
              ? "out_of_band_gated"
              : coveringApprovalId
                ? "out_of_band_approved"
                : "out_of_band",
            sentAt: new Date(sentAtMs),
          })
          .onConflictDoNothing()
          .returning({ id: gmailOutboundRecords.id });
        if (inserted.length === 0) continue;
        summary.recorded++;

        if (gatedUnapproved) {
          summary.gatedUnapproved++;
          const assigneeAgentId = await resolveIncidentAssignee(companyId);
          logger.error(
            {
              companyId,
              mailbox,
              gmailMessageId: stub.id,
              to,
              category: decision.category,
              reasons: decision.reasons,
            },
            "gmail-outbound-reconciler: OUT-OF-BAND GATED SEND detected (AUR-4674)",
          );
          try {
            await isvc.create(companyId, {
              title: `OUT-OF-BAND GATED SEND: ${decision.category ?? "report"} from ${mailbox}@ to ${to || "(unknown)"} (gmail ${stub.id})`,
              description:
                `## Out-of-band gated Gmail send detected (AUR-4674 reconciler)\n\n` +
                `A message in the \`${mailbox}@\` SENT label has **no chokepoint tracking record** — it did not ` +
                `go through the control-plane send path — and the outbound guard classifies it as gated with ` +
                `**no approved, scope-matching gmailOutbound approval** on file.\n\n` +
                `**Gmail message id:** \`${stub.id}\` (thread \`${msg.threadId ?? "?"}\`)\n` +
                `**To:** ${to || "(unknown)"}\n` +
                `**Subject:** ${subject || "(none)"}\n` +
                `**Classification:** ${decision.category}\n` +
                `**Signals:** ${decision.reasons.join(", ")}\n` +
                `**Sent at:** ${new Date(sentAtMs).toISOString()}\n\n` +
                `This is the AUR-4674 bypass class: a raw SA-key send that never consulted the outbound gate. ` +
                `Reconstruct who sent it (agent transcripts around the send time), and obtain or confirm ` +
                `retroactive CEO approval or remediation. Do not quote the message body into comments or memory ` +
                `if it contains PII — reference the Gmail message id instead.`,
              priority: "critical",
              status: "todo",
              ...(assigneeAgentId ? { assigneeAgentId } : {}),
            });
          } catch (err) {
            // The row is the dedup guard: if the incident could not be filed,
            // release the row so the next pass retries instead of a skipped
            // message silencing its own alarm forever.
            await db.delete(gmailOutboundRecords).where(eq(gmailOutboundRecords.id, inserted[0].id));
            throw err;
          }
        }
      } catch (err) {
        summary.errors++;
        logger.error(
          { err, companyId, mailbox, messageId: stub.id },
          "gmail-outbound-reconciler: failed to reconcile message",
        );
      }
    }

    return summary;
  }

  async function reconcileAllMailboxes(companyId: string): Promise<GmailOutboundReconcileSummary[]> {
    const results: GmailOutboundReconcileSummary[] = [];
    for (const mailbox of GMAIL_SUPPORTED_ALIASES) {
      results.push(await reconcileMailbox(companyId, mailbox));
    }
    return results;
  }

  return { reconcileMailbox, reconcileAllMailboxes };
}

export type GmailOutboundReconciler = ReturnType<typeof createGmailOutboundReconciler>;

export interface GmailOutboundReconcilerSchedulerOptions {
  /**
   * The mailboxes are org-level (one Workspace domain), so the sweep runs once
   * under a single owning company — fanning it over every company would insert
   * duplicate rows and mint false criticals in companies whose approvals and
   * fleet have nothing to do with the mailbox.
   */
  getOwningCompanyId: () => Promise<string | undefined>;
  reconciler: GmailOutboundReconciler;
  startupDelayMs?: number;
  intervalMs: number;
}

export function createGmailOutboundReconcilerScheduler(
  opts: GmailOutboundReconcilerSchedulerOptions,
): DailyHealthScheduler {
  return createDailyHealthScheduler({
    startupDelayMs: opts.startupDelayMs ?? 120_000,
    intervalMs: opts.intervalMs,
    run: async () => {
      const companyId = await opts.getOwningCompanyId();
      if (!companyId) {
        logger.warn("gmail-outbound-reconciler: no owning company resolved, skipping pass");
        return;
      }
      const results = await opts.reconciler.reconcileAllMailboxes(companyId);
      const scanned = results.reduce((s, r) => s + r.scanned, 0);
      const gatedUnapproved = results.reduce((s, r) => s + r.gatedUnapproved, 0);
      const errors = results.reduce((s, r) => s + r.errors, 0);
      if (scanned > 0 || gatedUnapproved > 0 || errors > 0) {
        logger.info(
          { companyId, scanned, gatedUnapproved, errors },
          "gmail-outbound-reconciler: pass complete",
        );
      }
    },
    onError: (err) => logger.error({ err }, "gmail-outbound-reconciler: scheduler unhandled error"),
  });
}
