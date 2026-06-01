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

const sendMessageBodySchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string().min(1),
  replyToMessageId: z.string().optional(),
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
      try {
        const data = await gmail.sendMessage(mailbox, body);
        res.status(201).json(data);
      } catch (err) {
        if (err instanceof UnresolvedPlaceholderError) {
          throw unprocessable(err.message, { tokens: err.tokens });
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

  return router;
}
