import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess } from "./authz.js";
import { badRequest, unprocessable } from "../errors.js";
import {
  createGmailService,
  isSupportedGmailAlias,
  GMAIL_SUPPORTED_ALIASES,
} from "../services/gmail.js";
import { UnresolvedPlaceholderError } from "../services/outbound-render-guard.js";
import { createGmailIntakeService } from "../services/gmail-intake.js";
import { createGmailOutboundService } from "../services/gmail-outbound.js";
import type { ConversationResponseStatus } from "../services/gmail-outbound.js";

const sendMessageBodySchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string().min(1),
  replyToMessageId: z.string().optional(),
  campaign: z.string().optional(),
  issueId: z.string().uuid().optional(),
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

const VALID_RESPONSE_STATUSES = new Set<ConversationResponseStatus>([
  "needs-pickup",
  "awaiting-reply",
  "replied",
]);

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
  const outbound = createGmailOutboundService(db);

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
      let data: Awaited<ReturnType<typeof gmail.sendMessage>>;
      try {
        data = await gmail.sendMessage(mailbox, body);
      } catch (err) {
        if (err instanceof UnresolvedPlaceholderError) {
          throw unprocessable(err.message, { tokens: err.tokens });
        }
        throw err;
      }

      // Persist outbound record — non-fatal: failure must not break the send response.
      if (data.id && data.threadId) {
        const sentByAgentId = req.actor?.type === "agent" ? (req.actor.agentId ?? null) : null;
        void outbound.persistSend({
          companyId,
          mailbox,
          gmailThreadId: data.threadId,
          gmailMessageId: data.id,
          recipient: body.to,
          subject: body.subject,
          campaign: body.campaign ?? undefined,
          issueId: body.issueId ?? undefined,
          sentByAgentId,
          sentAt: new Date(),
        });
      }

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

  // Returns needs-reply aging for open email-origin issues, sorted by replyDueAt ascending.
  // Query param: slaBusinessDays (integer 1–30, default 2).
  router.get(
    "/companies/:companyId/gmail/intake/aging",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const rawSla = req.query.slaBusinessDays;
      const slaBusinessDays = rawSla != null ? Number(rawSla) : 2;
      if (!Number.isInteger(slaBusinessDays) || slaBusinessDays < 1 || slaBusinessDays > 30) {
        throw badRequest("slaBusinessDays must be an integer between 1 and 30");
      }
      const aging = await intake.getAgingReport(companyId, slaBusinessDays);
      res.json({ slaBusinessDays, aging });
    },
  );

  // Unified conversation view: joins outbound + inbound records by thread.
  router.get(
    "/companies/:companyId/mail/conversations",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const q = req.query as Record<string, unknown>;
      const mailboxFilter = typeof q.mailbox === "string" ? q.mailbox : undefined;
      const ownerFilter = typeof q.owner === "string" ? q.owner : undefined;
      const campaignFilter = typeof q.campaign === "string" ? q.campaign : undefined;
      const statusRaw = typeof q.status === "string" ? q.status : undefined;
      if (statusRaw && !VALID_RESPONSE_STATUSES.has(statusRaw as ConversationResponseStatus)) {
        throw badRequest(`Invalid status filter: ${statusRaw}. Must be one of: needs-pickup, awaiting-reply, replied`);
      }
      const conversations = await outbound.queryConversations(companyId, {
        mailbox: mailboxFilter,
        owner: ownerFilter,
        campaign: campaignFilter,
        status: statusRaw as ConversationResponseStatus | undefined,
      });
      res.json({ conversations });
    },
  );

  return router;
}
