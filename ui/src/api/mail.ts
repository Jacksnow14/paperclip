import { api } from "./client";

export type ConversationResponseStatus = "needs-pickup" | "awaiting-reply" | "replied";

export interface MailConversation {
  mailbox: string;
  threadId: string;
  contact: string | null;
  owner: string;
  campaign: string | null;
  lastOutbound: { subject: string | null; sentAt: string | null } | null;
  lastInbound: { subject: string | null; sender: string | null; receivedAt: string | null } | null;
  whoReplied: string | null;
  responseStatus: ConversationResponseStatus;
}

export interface ConversationsResponse {
  conversations: MailConversation[];
}

export interface ConversationFilters {
  mailbox?: string;
  owner?: string;
  status?: ConversationResponseStatus;
  campaign?: string;
}

export const mailApi = {
  listConversations: (companyId: string, filters: ConversationFilters = {}) => {
    const params = new URLSearchParams();
    if (filters.mailbox) params.set("mailbox", filters.mailbox);
    if (filters.owner) params.set("owner", filters.owner);
    if (filters.status) params.set("status", filters.status);
    if (filters.campaign) params.set("campaign", filters.campaign);
    const qs = params.toString();
    return api.get<ConversationsResponse>(
      `/companies/${companyId}/mail/conversations${qs ? `?${qs}` : ""}`,
    );
  },
};
