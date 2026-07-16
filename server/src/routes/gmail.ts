import { Router, type Request } from "express";
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
  decodeGmailMessageBody,
  isSupportedGmailAlias,
  GMAIL_SUPPORTED_ALIASES,
  type GmailSendGuardContext,
} from "../services/gmail.js";
import { GmailOutboundBlockedError, type GmailOutboundDecision } from "../services/gmail-outbound-guard.js";
import { createGmailIntakeService } from "../services/gmail-intake.js";

const attachmentInputSchema = z.object({
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  contentBase64: z.string().min(1),
});

const ccSchema = z.union([z.string(), z.array(z.string())]).optional();

const sendMessageBodySchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string().min(1),
  replyToMessageId: z.string().optional(),
  cc: ccSchema,
  replyTo: z.string().email().optional(),
  attachments: z.array(attachmentInputSchema).optional(),
  ceoApprovalId: z.string().optional(),
});

const replyBodySchema = z
  .object({
    replyToMessageId: z.string().optional(),
    threadId: z.string().optional(),
    body: z.string().min(1),
    cc: ccSchema,
    replyTo: z.string().email().optional(),
    attachments: z.array(attachmentInputSchema).optional(),
    ceoApprovalId: z.string().optional(),
  })
  .refine((v) => Boolean(v.replyToMessageId || v.threadId), {
    message: "replyToMessageId or threadId is required",
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

// AUR-2525/AUR-3523: an attached ceoApprovalId only counts as verification for
// the outbound guard if it resolves to an `approved` approvals row scoped to
// this company. Anything else (missing, pending, wrong company) is treated as
// unverified and the service-layer chokepoint in sendMessage() decides
// whether that matters (i.e. whether this particular send is actually gated).
async function verifyCeoApproval(
  db: Db,
  companyId: string,
  ceoApprovalId: string | undefined,
): Promise<GmailSendGuardContext> {
  const approvalId = ceoApprovalId?.trim();
  if (!approvalId) return {};
  const approval = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.id, approvalId), eq(approvals.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  return { approvalVerified: approval?.status === "approved" };
}

// Fire-and-forget: file a high-priority incident issue assigned to the
// calling agent so a blocked gated send doesn't just silently vanish.
function fileBlockedSendIncident(
  db: Db,
  companyId: string,
  req: Request,
  mailbox: string,
  context: { to?: string; replyToMessageId?: string; threadId?: string },
  decision: GmailOutboundDecision,
) {
  const callerAgentId = req.actor.type === "agent" ? (req.actor.agentId ?? null) : null;
  if (!callerAgentId) return;
  const target = context.to
    ? `to ${context.to}`
    : `replying in ${context.replyToMessageId ? `message ${context.replyToMessageId}` : `thread ${context.threadId}`}`;
  // Lazy import so the route module graph doesn't statically pull in the full
  // issues service (and its module-load-time db/drizzle usage). This path only
  // runs on the rare blocked-outbound case.
  void import("../services/index.js")
    .then(({ issueService }) =>
      issueService(db).create(companyId, {
      title: `BLOCKED: outbound ${decision.category ?? "report"} from ${mailbox}@ ${target}`,
      description:
        `## Gmail outbound guardrail triggered (AUR-2525)\n\n` +
        `**Mailbox:** ${mailbox}@tryauranode.com\n` +
        `**Target:** ${target}\n` +
        `**Classification:** ${decision.category}\n` +
        `**Signals:** ${decision.reasons.join(", ")}\n\n` +
        `The send was hard-blocked. To proceed:\n` +
        `1. Verify this is a legitimate report (check memory / prior board decisions).\n` +
        `2. Create a board approval via \`POST /api/companies/{co}/approvals\` with type \`request_board_approval\`.\n` +
        `3. After CEO approves, re-send with \`ceoApprovalId\` in the request body.`,
      priority: "high",
      status: "todo",
      assigneeAgentId: callerAgentId,
      }),
    )
    .catch((err: unknown) => {
      logger.error(
        { err, mailbox, target },
        "gmail-guard: failed to create blocked-send incident issue",
      );
    });
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
      const { bodyText, bodyHtml } = decodeGmailMessageBody(data.payload);
      res.json({ ...data, bodyText, bodyHtml });
    },
  );

  router.get(
    "/companies/:companyId/gmail/mailboxes/:mailbox/messages/:messageId/attachments/:attachmentId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const mailbox = req.params.mailbox as string;
      const messageId = req.params.messageId as string;
      const attachmentId = req.params.attachmentId as string;
      assertCompanyAccess(req, companyId);
      assertGmailAvailable();
      if (!isSupportedGmailAlias(mailbox)) throw badRequest(`Unsupported mailbox: ${mailbox}`);
      const data = await gmail.getAttachment(mailbox, messageId, attachmentId);
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
      const guard = await verifyCeoApproval(db, companyId, body.ceoApprovalId);
      try {
        const data = await gmail.sendMessage(mailbox, body, guard);
        res.status(201).json(data);
      } catch (err) {
        if (err instanceof GmailOutboundBlockedError) {
          fileBlockedSendIncident(db, companyId, req, mailbox, { to: body.to }, err.decision);
          throw forbidden(err.message);
        }
        throw err;
      }
    },
  );

  router.post(
    "/companies/:companyId/gmail/mailboxes/:mailbox/reply",
    validate(replyBodySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const mailbox = req.params.mailbox as string;
      assertCompanyAccess(req, companyId);
      assertGmailAvailable();
      if (!isSupportedGmailAlias(mailbox)) throw badRequest(`Unsupported mailbox: ${mailbox}`);
      const body = req.body as z.infer<typeof replyBodySchema>;
      const guard = await verifyCeoApproval(db, companyId, body.ceoApprovalId);
      try {
        const data = await gmail.replyInThread(mailbox, body, guard);
        res.status(201).json(data);
      } catch (err) {
        if (err instanceof GmailOutboundBlockedError) {
          fileBlockedSendIncident(
            db,
            companyId,
            req,
            mailbox,
            { replyToMessageId: body.replyToMessageId, threadId: body.threadId },
            err.decision,
          );
          throw forbidden(err.message);
        }
        throw err;
      }
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
