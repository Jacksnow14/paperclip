import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, gmailIntakeRecords } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess } from "./authz.js";
import { badRequest, forbidden, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  createGmailService,
  isSupportedGmailAlias,
  GMAIL_SUPPORTED_ALIASES,
} from "../services/gmail.js";
import { createGmailIntakeService } from "../services/gmail-intake.js";
import { issueService } from "../services/index.js";
import {
  classifyGmailOutbound,
  GmailOutboundBlockedError,
} from "../services/gmail-outbound-guard.js";

const sendMessageBodySchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string().min(1),
  replyToMessageId: z.string().optional(),
  ceoApprovalId: z.string().optional(),
});

const modifyLabelsBodySchema = z.object({
  addLabelIds: z.array(z.string()).optional(),
  removeLabelIds: z.array(z.string()).optional(),
});

const vacationSettingsBodySchema = z.object({
  enableAutoReply: z.boolean().optional(),
  responseSubject: z.string().optional(),
  responseBodyHtml: z.string().optional(),
  startTimeIso: z.string().datetime().optional(),
  endTimeIso: z.string().datetime().optional(),
});

function assertGmailAvailable() {
  if (!process.env.GOOGLE_WORKSPACE_SA_KEY) {
    throw unprocessable("Gmail capability is not configured (GOOGLE_WORKSPACE_SA_KEY not set)");
  }
}

function parseListQuery(raw: Record<string, unknown>) {
  const q = typeof raw.q === "string" ? raw.q : undefined;
  const maxResults = raw.maxResults != null ? Number(raw.maxResults) : undefined;
  const pageToken = typeof raw.pageToken === "string" ? raw.pageToken : undefined;
  if (maxResults !== undefined && (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 500)) {
    throw badRequest("maxResults must be an integer between 1 and 500");
  }
  return { query: q, maxResults, pageToken };
}

export function gmailRoutes(db: Db) {
  const router = Router();
  const gmail = createGmailService();
  const intake = createGmailIntakeService(db);

  router.get("/companies/:companyId/gmail/mailboxes", (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ mailboxes: GMAIL_SUPPORTED_ALIASES.map((a) => `${a}@tryauranode.com`) });
  });

  router.get(
    "/companies/:companyId/gmail/mailboxes/:mailbox/messages",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const mailbox = req.params.mailbox as string;
      assertCompanyAccess(req, companyId);
      assertGmailAvailable();
      if (!isSupportedGmailAlias(mailbox)) throw badRequest(`Unsupported mailbox: ${mailbox}`);
      const opts = parseListQuery(req.query as Record<string, unknown>);
      const data = await gmail.listMessages(mailbox, opts);
      res.json(data);
    },
  );

  router.get(
    "/companies/:companyId/gmail/mailboxes/:mailbox/messages/:messageId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const mailbox = req.params.mailbox as string;
      const messageId = req.params.messageId as string;
      assertCompanyAccess(req, companyId);
      assertGmailAvailable();
      if (!isSupportedGmailAlias(mailbox)) throw badRequest(`Unsupported mailbox: ${mailbox}`);
      const data = await gmail.getMessage(mailbox, messageId);
      res.json(data);
    },
  );

  router.post(
    "/companies/:companyId/gmail/mailboxes/:mailbox/messages",
    validate(sendMessageBodySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const mailbox = req.params.mailbox as string;
      assertCompanyAccess(req, companyId);
      assertGmailAvailable();
      if (!isSupportedGmailAlias(mailbox)) throw badRequest(`Unsupported mailbox: ${mailbox}`);
      const body = req.body as z.infer<typeof sendMessageBodySchema>;

      // AUR-2525: Gate outbound fraud/abuse/legal/chargeback reports.
      // This is the path that fired the 2026-06-16 First Mile takeover cascade.
      const decision = classifyGmailOutbound({
        to: body.to,
        subject: body.subject,
        text: body.body,
      });

      if (decision.gated) {
        const approvalId = body.ceoApprovalId?.trim();
        let approvalValid = false;

        if (approvalId) {
          const approval = await db
            .select()
            .from(approvals)
            .where(and(eq(approvals.id, approvalId), eq(approvals.companyId, companyId)))
            .then((rows) => rows[0] ?? null);
          approvalValid = approval?.status === 'approved';
        }

        if (!approvalValid) {
          // Log a blocked-send incident issue for the caller agent (fire-and-forget).
          const callerAgentId =
            req.actor.type === 'agent' ? (req.actor.agentId ?? null) : null;
          if (callerAgentId) {
            issueService(db)
              .create(companyId, {
                title: `BLOCKED: outbound ${decision.category ?? 'report'} from ${mailbox}@ to ${body.to}`,
                description:
                  `## Gmail outbound guardrail triggered (AUR-2525)\n\n` +
                  `**Mailbox:** ${mailbox}@tryauranode.com\n` +
                  `**To:** ${body.to}\n` +
                  `**Subject:** ${body.subject}\n` +
                  `**Classification:** ${decision.category}\n` +
                  `**Signals:** ${decision.reasons.join(', ')}\n\n` +
                  `The send was hard-blocked. To proceed:\n` +
                  `1. Verify this is a legitimate report (check memory / prior board decisions).\n` +
                  `2. Create a board approval via \`POST /api/companies/{co}/approvals\` with type \`request_board_approval\`.\n` +
                  `3. After CEO approves, re-send with \`ceoApprovalId\` in the request body.`,
                priority: 'high',
                status: 'todo',
                assigneeAgentId: callerAgentId,
              })
              .catch((err: unknown) => {
                logger.error(
                  { err, mailbox, to: body.to },
                  'gmail-guard: failed to create blocked-send incident issue',
                );
              });
          }

          throw forbidden(new GmailOutboundBlockedError(decision).message);
        }

        logger.info(
          { mailbox, to: body.to, approvalId, category: decision.category },
          'gmail-guard: gated send allowed with CEO approval',
        );
      }

      // The route has already classified and (for gated sends) verified an
      // approved CEO board approval above. Tell the service-layer chokepoint
      // (AUR-2682) the approval was verified so the gated-but-approved send
      // proceeds; non-gated sends are unaffected either way.
      const data = await gmail.sendMessage(mailbox, body, { approvalVerified: true });
      res.status(201).json(data);
    },
  );

  router.get(
    "/companies/:companyId/gmail/mailboxes/:mailbox/threads",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const mailbox = req.params.mailbox as string;
      assertCompanyAccess(req, companyId);
      assertGmailAvailable();
      if (!isSupportedGmailAlias(mailbox)) throw badRequest(`Unsupported mailbox: ${mailbox}`);
      const opts = parseListQuery(req.query as Record<string, unknown>);
      const data = await gmail.listThreads(mailbox, opts);
      res.json(data);
    },
  );

  router.get(
    "/companies/:companyId/gmail/mailboxes/:mailbox/threads/:threadId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const mailbox = req.params.mailbox as string;
      const threadId = req.params.threadId as string;
      assertCompanyAccess(req, companyId);
      assertGmailAvailable();
      if (!isSupportedGmailAlias(mailbox)) throw badRequest(`Unsupported mailbox: ${mailbox}`);
      const data = await gmail.getThread(mailbox, threadId);
      res.json(data);
    },
  );

  router.get(
    "/companies/:companyId/gmail/mailboxes/:mailbox/labels",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const mailbox = req.params.mailbox as string;
      assertCompanyAccess(req, companyId);
      assertGmailAvailable();
      if (!isSupportedGmailAlias(mailbox)) throw badRequest(`Unsupported mailbox: ${mailbox}`);
      const data = await gmail.listLabels(mailbox);
      res.json({ labels: data });
    },
  );

  router.patch(
    "/companies/:companyId/gmail/mailboxes/:mailbox/messages/:messageId/labels",
    validate(modifyLabelsBodySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const mailbox = req.params.mailbox as string;
      const messageId = req.params.messageId as string;
      assertCompanyAccess(req, companyId);
      assertGmailAvailable();
      if (!isSupportedGmailAlias(mailbox)) throw badRequest(`Unsupported mailbox: ${mailbox}`);
      const body = req.body as z.infer<typeof modifyLabelsBodySchema>;
      const data = await gmail.modifyMessageLabels(mailbox, messageId, body);
      res.json(data);
    },
  );

  router.get(
    "/companies/:companyId/gmail/mailboxes/:mailbox/settings/vacation",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const mailbox = req.params.mailbox as string;
      assertCompanyAccess(req, companyId);
      assertGmailAvailable();
      if (!isSupportedGmailAlias(mailbox)) throw badRequest(`Unsupported mailbox: ${mailbox}`);
      const data = await gmail.getVacationSettings(mailbox);
      res.json(data);
    },
  );

  router.put(
    "/companies/:companyId/gmail/mailboxes/:mailbox/settings/vacation",
    validate(vacationSettingsBodySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const mailbox = req.params.mailbox as string;
      assertCompanyAccess(req, companyId);
      assertGmailAvailable();
      if (!isSupportedGmailAlias(mailbox)) throw badRequest(`Unsupported mailbox: ${mailbox}`);
      const body = req.body as z.infer<typeof vacationSettingsBodySchema>;
      const data = await gmail.updateVacationSettings(mailbox, body);
      res.json(data);
    },
  );

  // Trigger a manual intake poll for all mailboxes in a company.
  router.post(
    "/companies/:companyId/gmail/intake/poll",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertGmailAvailable();
      const results = await intake.pollAllMailboxes(companyId);
      res.json({ results });
    },
  );

  // Board-facing mail conversation dashboard — aggregates inbound threads.
  router.get(
    "/companies/:companyId/mail/conversations",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const q = req.query as Record<string, unknown>;
      const mailboxFilter = typeof q.mailbox === "string" ? q.mailbox : undefined;
      const ownerFilter = typeof q.owner === "string" ? q.owner : undefined;
      const statusFilter = typeof q.status === "string" ? q.status : undefined;

      const records = await db
        .select()
        .from(gmailIntakeRecords)
        .where(eq(gmailIntakeRecords.companyId, companyId));

      // Group by mailbox+threadId, keeping the most recent inbound message per thread.
      const threadMap = new Map<string, typeof records[0]>();
      for (const r of records) {
        const key = `${r.mailbox}:${r.gmailThreadId}`;
        const existing = threadMap.get(key);
        if (
          !existing ||
          (r.receivedAt &&
            (!existing.receivedAt || r.receivedAt > existing.receivedAt))
        ) {
          threadMap.set(key, r);
        }
      }

      type ConversationStatus = "needs-pickup" | "awaiting-reply" | "replied";
      const conversations = Array.from(threadMap.values()).map((r) => ({
        mailbox: `${r.mailbox}@tryauranode.com`,
        threadId: r.gmailThreadId,
        contact: r.sender ?? null,
        owner: r.mailbox,
        campaign: null as string | null,
        lastOutbound: null as { subject: string | null; sentAt: string | null } | null,
        lastInbound: {
          subject: r.subject ?? null,
          sender: r.sender ?? null,
          receivedAt: r.receivedAt?.toISOString() ?? null,
        },
        whoReplied: null as string | null,
        responseStatus: "needs-pickup" as ConversationStatus,
      }));

      const STATUS_ORDER: Record<ConversationStatus, number> = {
        "needs-pickup": 0,
        "awaiting-reply": 1,
        replied: 2,
      };

      let filtered = conversations;
      if (mailboxFilter) {
        filtered = filtered.filter(
          (c) => c.mailbox === mailboxFilter || c.mailbox.startsWith(`${mailboxFilter}@`),
        );
      }
      if (ownerFilter) {
        filtered = filtered.filter((c) => c.owner === ownerFilter);
      }
      if (statusFilter) {
        filtered = filtered.filter((c) => c.responseStatus === statusFilter);
      }

      filtered.sort((a, b) => {
        const od = STATUS_ORDER[a.responseStatus] - STATUS_ORDER[b.responseStatus];
        if (od !== 0) return od;
        const at = a.lastInbound?.receivedAt ?? a.lastOutbound?.sentAt ?? "";
        const bt = b.lastInbound?.receivedAt ?? b.lastOutbound?.sentAt ?? "";
        return bt < at ? -1 : bt > at ? 1 : 0;
      });

      res.json({ conversations: filtered });
    },
  );

  return router;
}
