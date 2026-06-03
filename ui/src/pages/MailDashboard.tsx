import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Mail, Inbox, Send, RefreshCw } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { mailApi } from "../api/mail";
import type { ConversationResponseStatus, MailConversation } from "../api/mail";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

const STATUS_LABELS: Record<ConversationResponseStatus, string> = {
  "needs-pickup": "Needs Pickup",
  "awaiting-reply": "Awaiting Reply",
  replied: "Replied",
};

const STATUS_VARIANT: Record<
  ConversationResponseStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  "needs-pickup": "destructive",
  "awaiting-reply": "secondary",
  replied: "default",
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ConversationRow({ conv }: { conv: MailConversation }) {
  const lastActivity =
    conv.lastInbound?.receivedAt ?? conv.lastOutbound?.sentAt ?? null;

  return (
    <tr className="border-b border-border hover:bg-muted/40 transition-colors">
      <td className="px-4 py-3 text-sm font-medium text-foreground max-w-[220px] truncate">
        {conv.contact ?? <span className="text-muted-foreground italic">unknown</span>}
      </td>
      <td className="px-4 py-3 text-sm text-muted-foreground max-w-[260px] truncate">
        {conv.lastOutbound?.subject ?? conv.lastInbound?.subject ?? "—"}
      </td>
      <td className="px-4 py-3 text-sm text-muted-foreground">{conv.mailbox}</td>
      <td className="px-4 py-3 text-sm text-muted-foreground capitalize">{conv.owner}</td>
      <td className="px-4 py-3">
        <Badge variant={STATUS_VARIANT[conv.responseStatus]}>
          {STATUS_LABELS[conv.responseStatus]}
        </Badge>
      </td>
      <td className="px-4 py-3 text-sm text-muted-foreground">
        {conv.campaign ?? <span className="italic">—</span>}
      </td>
      <td className="px-4 py-3 text-sm text-muted-foreground whitespace-nowrap">
        {formatDate(lastActivity)}
      </td>
    </tr>
  );
}

export function MailDashboard() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const [statusFilter, setStatusFilter] = useState<ConversationResponseStatus | "all">("all");
  const [mailboxFilter, setMailboxFilter] = useState("all");

  useEffect(() => {
    setBreadcrumbs([{ label: "Mail" }]);
  }, [setBreadcrumbs]);

  const filters = {
    ...(statusFilter !== "all" ? { status: statusFilter } : {}),
    ...(mailboxFilter !== "all" ? { mailbox: mailboxFilter } : {}),
  };

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.mail.conversations(selectedCompanyId!, filters),
    queryFn: () => mailApi.listConversations(selectedCompanyId!, filters),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const conversations = data?.conversations ?? [];

  const needsPickup = conversations.filter((c) => c.responseStatus === "needs-pickup").length;
  const replied = conversations.filter((c) => c.responseStatus === "replied").length;
  const awaiting = conversations.filter((c) => c.responseStatus === "awaiting-reply").length;

  const mailboxes = Array.from(new Set(data?.conversations.map((c) => c.mailbox) ?? [])).sort();

  if (isLoading) return <PageSkeleton />;

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Mail className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Mail</h1>
        </div>
        <button
          onClick={() => void refetch()}
          disabled={isFetching}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Inbox className="h-4 w-4" />
            Needs Pickup
          </div>
          <div className="text-2xl font-bold text-destructive">{needsPickup}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Send className="h-4 w-4" />
            Awaiting Reply
          </div>
          <div className="text-2xl font-bold">{awaiting}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Mail className="h-4 w-4" />
            Replied
          </div>
          <div className="text-2xl font-bold text-green-600 dark:text-green-400">{replied}</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3">
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as ConversationResponseStatus | "all")}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="needs-pickup">Needs Pickup</SelectItem>
            <SelectItem value="awaiting-reply">Awaiting Reply</SelectItem>
            <SelectItem value="replied">Replied</SelectItem>
          </SelectContent>
        </Select>

        <Select value={mailboxFilter} onValueChange={setMailboxFilter}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Mailbox" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All mailboxes</SelectItem>
            {mailboxes.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      {error ? (
        <EmptyState
          icon={Mail}
          message={error instanceof Error ? error.message : "Failed to load mail"}
        />
      ) : conversations.length === 0 ? (
        <EmptyState
          icon={Mail}
          message="No conversations yet. Sent emails and replies will appear here."
        />
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-left">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Contact
                </th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Subject
                </th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Mailbox
                </th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Owner
                </th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Status
                </th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Campaign
                </th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Last Activity
                </th>
              </tr>
            </thead>
            <tbody>
              {conversations.map((conv) => (
                <ConversationRow key={`${conv.mailbox}:${conv.threadId}`} conv={conv} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
