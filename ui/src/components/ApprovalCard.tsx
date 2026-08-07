import { CheckCircle2, XCircle, Clock, Archive, ArrowRightLeft } from "lucide-react";
import { Link } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Identity } from "./Identity";
import {
  approvalSubject,
  typeIcon,
  defaultTypeIcon,
  ApprovalPayloadRenderer,
  typeLabel,
} from "./ApprovalPayload";
import { timeAgo } from "../lib/timeAgo";
import type { Approval, Agent } from "@paperclipai/shared";
import { cn } from "@/lib/utils";

function statusIcon(status: string) {
  if (status === "approved") return <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />;
  if (status === "rejected") return <XCircle className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />;
  if (status === "revision_requested") return <Clock className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />;
  if (status === "pending") return <Clock className="h-3.5 w-3.5 text-yellow-600 dark:text-yellow-400" />;
  if (status === "withdrawn") return <Archive className="h-3.5 w-3.5 text-muted-foreground" />;
  return null;
}

export function ApprovalCard({
  approval,
  requesterAgent,
  supersedes = [],
  onApprove,
  onReject,
  onOpen,
  detailLink,
  isPending = false,
  pendingAction = null,
}: {
  approval: Approval;
  requesterAgent: Agent | null;
  /**
   * Approvals this row replaces (AUR-5344). Two requests with a byte-identical
   * title are indistinguishable at the point of clicking; saying so on the live
   * row is the half of the fix a withdrawal alone does not cover.
   */
  supersedes?: Approval[];
  onApprove?: () => void;
  onReject?: () => void;
  onOpen?: () => void;
  detailLink?: string;
  isPending?: boolean;
  pendingAction?: "approve" | "reject" | null;
}) {
  const payload = approval.payload as Record<string, unknown> | null;
  const Icon = typeIcon[approval.type] ?? defaultTypeIcon;
  const kindLabel = typeLabel[approval.type] ?? approval.type;
  const subject = approvalSubject(payload);
  const showResolutionButtons =
    Boolean(onApprove && onReject) &&
    approval.type !== "budget_override_required" &&
    (approval.status === "pending" || approval.status === "revision_requested");
  const hasFooter = showResolutionButtons || Boolean(detailLink || onOpen);

  return (
    <div className="rounded-xl border border-border/70 bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/80">
              <Icon className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className="border-border/70 bg-background/70 px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
                >
                  {kindLabel}
                </Badge>
                {requesterAgent && (
                  <div className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <span>Requested by</span>
                    <Identity name={requesterAgent.name} size="sm" className="inline-flex" />
                  </div>
                )}
              </div>
              <div className="space-y-1">
                <h3 className="text-base font-semibold leading-6 text-foreground">
                  {subject ?? kindLabel}
                </h3>
                <p className="text-xs leading-5 text-muted-foreground">
                  Approval request created {timeAgo(approval.createdAt)}
                </p>
              </div>
            </div>
          </div>
        </div>
        <div className="shrink-0">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/80 px-2.5 py-1 text-xs text-muted-foreground">
            {statusIcon(approval.status)}
            <span className="capitalize">{approval.status.replace(/_/g, " ")}</span>
          </div>
        </div>
      </div>

      <div className="mt-4 border-t border-border/60 pt-4">
        <ApprovalPayloadRenderer
          type={approval.type}
          payload={approval.payload}
          hidePrimaryTitle={Boolean(subject)}
        />
      </div>

      {approval.supersededByApprovalId && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3.5 py-3 text-xs leading-5 text-muted-foreground">
          <ArrowRightLeft className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <span className="font-medium text-foreground">Withdrawn — superseded.</span>{" "}
            Replaced by{" "}
            <Link
              to={`/approvals/${approval.supersededByApprovalId}`}
              className="underline underline-offset-2"
            >
              the current request
            </Link>
            .{approval.withdrawalReason ? ` ${approval.withdrawalReason}` : ""}
          </div>
        </div>
      )}

      {supersedes.length > 0 && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3.5 py-3 text-xs leading-5 text-muted-foreground">
          <ArrowRightLeft className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
          <div>
            <span className="font-medium text-foreground">
              Replaces {supersedes.length} withdrawn request{supersedes.length === 1 ? "" : "s"}.
            </span>{" "}
            This is the current version — approve this one.{" "}
            {supersedes.map((old, index) => (
              <span key={old.id}>
                {index > 0 && ", "}
                <Link to={`/approvals/${old.id}`} className="underline underline-offset-2">
                  {old.id.slice(0, 8)}
                </Link>
              </span>
            ))}
          </div>
        </div>
      )}

      {approval.decisionNote && (
        <div className="mt-4 rounded-lg border border-border/60 bg-muted/30 px-3.5 py-3 text-xs leading-5 text-muted-foreground">
          <span className="font-medium text-foreground">Decision note.</span> {approval.decisionNote}
        </div>
      )}

      {hasFooter ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            {showResolutionButtons && (
              <>
                <Button
                  size="sm"
                  className="bg-green-700 hover:bg-green-600 text-white"
                  onClick={onApprove}
                  disabled={isPending}
                >
                  {pendingAction === "approve" ? "Approving..." : "Approve"}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={onReject}
                  disabled={isPending}
                >
                  {pendingAction === "reject" ? "Rejecting..." : "Reject"}
                </Button>
              </>
            )}
          </div>
          {(detailLink || onOpen) ? (
            detailLink ? (
              <Link
                to={detailLink}
                className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-auto px-2 text-xs text-muted-foreground")}
              >
                View details
              </Link>
            ) : (
              <Button variant="ghost" size="sm" className="h-auto px-2 text-xs text-muted-foreground" onClick={onOpen}>
                View details
              </Button>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
