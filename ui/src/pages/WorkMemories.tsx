import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Link, useSearchParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MEMORY_PROMOTION_SCOPE_TYPES,
  MEMORY_RETENTION_STATES,
  MEMORY_REVIEW_STATES,
  MEMORY_SCOPE_TYPES,
  MEMORY_SENSITIVITY_LABELS,
  MEMORY_SOURCE_KINDS,
  type Agent,
  type Issue,
  type MemoryListOperationsQuery,
  type MemoryListRecordsQuery,
  type MemoryPromotionScopeType,
  type MemoryRecord,
  type MemoryRetentionState,
  type MemoryReviewState,
  type MemoryScopeType,
  type MemorySensitivityLabel,
  type MemorySourceKind,
  type Project,
} from "@paperclipai/shared";
import { AlertTriangle, ArrowUpCircle, Check, ChevronDown, Clipboard, Database, RotateCcw, SlidersHorizontal, Trash2, X } from "lucide-react";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { memoryApi } from "../api/memory";
import { projectsApi } from "../api/projects";
import { EmptyState } from "../components/EmptyState";
import {
  getMemoryRecordTitle,
  labelizeMemoryValue,
  MemoryRecordRow,
  memoryRecordSourceHref,
  memoryRecordSourceLabel,
} from "../components/MemoryRecordRow";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "../components/StatusBadge";
import { Textarea } from "@/components/ui/textarea";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl, cn, formatDateTime, projectUrl, relativeTime } from "../lib/utils";

const SCOPE_RANK: Record<MemoryScopeType, number> = {
  run: 1, agent: 2, workspace: 3, project: 4, team: 5, org: 6,
};

function promotionTargets(scopeType: MemoryScopeType | null | undefined): MemoryPromotionScopeType[] {
  const rank = SCOPE_RANK[scopeType ?? "org"] ?? 6;
  return MEMORY_PROMOTION_SCOPE_TYPES.filter((t) => SCOPE_RANK[t as MemoryScopeType] > rank);
}

type MemoryFilters = {
  q: string;
  providerKey: string;
  reviewState: MemoryReviewState | "";
  retentionState: MemoryRetentionState | "";
  sensitivityLabel: MemorySensitivityLabel | "";
  sourceKind: MemorySourceKind | "";
  scopeType: MemoryScopeType | "";
  projectId: string;
  agentId: string;
  issueId: string;
  runId: string;
  includeRevoked: boolean;
  includeExpired: boolean;
  includeSuperseded: boolean;
};

const DEFAULT_FILTERS: MemoryFilters = {
  q: "",
  providerKey: "",
  reviewState: "pending",
  retentionState: "",
  sensitivityLabel: "",
  sourceKind: "",
  scopeType: "",
  projectId: "",
  agentId: "",
  issueId: "",
  runId: "",
  includeRevoked: false,
  includeExpired: false,
  includeSuperseded: false,
};

const SELECT_ALL_VALUE = "__all__";
const REVIEW_TABS = ["pending", "accepted", "rejected", "revoked"] as const;
type ReviewTab = (typeof REVIEW_TABS)[number];

function labelize(value: string) {
  return labelizeMemoryValue(value);
}

function memoryReviewStatus(record: MemoryRecord) {
  return record.revokedAt || record.retentionState === "revoked" ? "revoked" : record.reviewState;
}

function sourceLabel(record: MemoryRecord, issuesById: Map<string, Issue>) {
  return memoryRecordSourceLabel(record, issuesById);
}

function sourceHref(record: MemoryRecord, issuesById: Map<string, Issue>) {
  return memoryRecordSourceHref(record, issuesById);
}

function buildRecordFilters(filters: MemoryFilters): Partial<MemoryListRecordsQuery> {
  return {
    q: filters.q.trim() || undefined,
    providerKey: filters.providerKey || undefined,
    reviewState: filters.reviewState || undefined,
    retentionState: filters.retentionState || undefined,
    sensitivityLabel: filters.sensitivityLabel || undefined,
    sourceKind: filters.sourceKind || undefined,
    scopeType: filters.scopeType || undefined,
    projectId: filters.projectId || undefined,
    agentId: filters.agentId || undefined,
    issueId: filters.issueId || undefined,
    runId: filters.runId.trim() || undefined,
    includeDeleted: false,
    includeRevoked: filters.includeRevoked,
    includeExpired: filters.includeExpired,
    includeSuperseded: filters.includeSuperseded,
    limit: 100,
  };
}

function buildCountFilters(filters: MemoryFilters, reviewTab: ReviewTab): Partial<MemoryListRecordsQuery> {
  const base = buildRecordFilters({
    ...filters,
    reviewState: "",
    retentionState: filters.retentionState === "revoked" ? "" : filters.retentionState,
  });
  delete base.limit;

  if (reviewTab === "revoked") {
    return {
      ...base,
      reviewState: undefined,
      retentionState: "revoked",
      includeRevoked: true,
    };
  }

  return {
    ...base,
    reviewState: reviewTab,
    includeRevoked: false,
  };
}

function detailOperationFilters(record: MemoryRecord | null): MemoryListOperationsQuery | undefined {
  if (!record) return undefined;
  if (record.scope.runId ?? record.source?.runId) {
    return { runId: record.scope.runId ?? record.source?.runId ?? undefined, limit: 20 };
  }
  if (record.scope.issueId ?? record.source?.issueId) {
    return { issueId: record.scope.issueId ?? record.source?.issueId ?? undefined, limit: 20 };
  }
  if (record.scope.agentId) return { agentId: record.scope.agentId, limit: 20 };
  return { limit: 20 };
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select
        value={value || SELECT_ALL_VALUE}
        onValueChange={(nextValue) => onChange(nextValue === SELECT_ALL_VALUE ? "" : nextValue)}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value || SELECT_ALL_VALUE} value={option.value || SELECT_ALL_VALUE}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function MemoryDetailSheet({
  companyId,
  record,
  agentsById,
  issuesById,
  projectsById,
  onClose,
}: {
  companyId: string;
  record: MemoryRecord | null;
  agentsById: Map<string, Agent>;
  issuesById: Map<string, Issue>;
  projectsById: Map<string, Project>;
  onClose: () => void;
}) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [reviewNote, setReviewNote] = useState("");
  const [revokeReason, setRevokeReason] = useState("");
  const [correctionContent, setCorrectionContent] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [promotionTargetScopeType, setPromotionTargetScopeType] = useState<MemoryPromotionScopeType | "">("");
  const [promotionTargetScopeId, setPromotionTargetScopeId] = useState("");
  const [promotionReason, setPromotionReason] = useState("");

  useEffect(() => {
    setReviewNote(record?.reviewNote ?? "");
    setRevokeReason("");
    setCorrectionContent(record?.content ?? "");
    setCorrectionReason("");
    setPromotionTargetScopeType("");
    setPromotionTargetScopeId("");
    setPromotionReason("");
  }, [record]);

  const operationFilters = useMemo(() => detailOperationFilters(record), [record]);
  const operationsQuery = useQuery({
    queryKey: record && operationFilters ? queryKeys.memory.operations(companyId, operationFilters) : ["memory", companyId, "operations", "none"],
    queryFn: () => memoryApi.listOperations(companyId, operationFilters),
    enabled: Boolean(record && operationFilters),
  });

  const invalidateMemory = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.memory.all });
  };

  const reviewRecord = useMutation({
    mutationFn: (reviewState: "pending" | "accepted" | "rejected") => {
      if (!record) throw new Error("No memory record selected");
      return memoryApi.reviewRecord(companyId, record.id, {
        reviewState,
        note: reviewNote.trim() || null,
      });
    },
    onSuccess: async () => {
      await invalidateMemory();
      pushToast({ title: "Memory review saved", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to review memory",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const correctRecord = useMutation({
    mutationFn: () => {
      if (!record) throw new Error("No memory record selected");
      return memoryApi.correctRecord(companyId, record.id, {
        content: correctionContent,
        reason: correctionReason,
      });
    },
    onSuccess: async () => {
      setCorrectionReason("");
      await invalidateMemory();
      pushToast({ title: "Memory corrected", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to correct memory",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const revokeRecord = useMutation({
    mutationFn: () => {
      if (!record) throw new Error("No memory record selected");
      return memoryApi.revoke(companyId, {
        selector: { recordIds: [record.id] },
        reason: revokeReason,
      });
    },
    onSuccess: async () => {
      setRevokeReason("");
      await invalidateMemory();
      pushToast({ title: "Memory revoked", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to revoke memory",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const promoteRecord = useMutation({
    mutationFn: () => {
      if (!record) throw new Error("No memory record selected");
      if (!promotionTargetScopeType) throw new Error("Select a target scope");
      if (!promotionReason.trim()) throw new Error("Promotion reason is required");
      return memoryApi.promoteRecord(companyId, record.id, {
        targetScope: {
          scopeType: promotionTargetScopeType,
          scopeId: promotionTargetScopeId.trim() || null,
        },
        reason: promotionReason.trim(),
      });
    },
    onSuccess: async () => {
      setPromotionTargetScopeType("");
      setPromotionTargetScopeId("");
      setPromotionReason("");
      await invalidateMemory();
      pushToast({ title: "Memory promoted", tone: "success" });
      onClose();
    },
    onError: (error) => {
      pushToast({
        title: "Failed to promote memory",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  if (!record) {
    return (
      <Sheet open={false} onOpenChange={onClose}>
        <SheetContent />
      </Sheet>
    );
  }

  const sourceUrl = sourceHref(record, issuesById);
  const agent = record.scope.agentId ? agentsById.get(record.scope.agentId) : null;
  const project = record.scope.projectId ? projectsById.get(record.scope.projectId) : null;
  const canMutate = record.retentionState === "active" && !record.revokedAt && !record.supersededByRecordId;
  const validPromotionTargets = promotionTargets(record.scopeType);
  const canPromote = canMutate && validPromotionTargets.length > 0;
  const scopeIdRequired = promotionTargetScopeType && !["org"].includes(promotionTargetScopeType);
  const canSubmitPromotion =
    canPromote &&
    Boolean(promotionTargetScopeType) &&
    Boolean(promotionReason.trim()) &&
    (!scopeIdRequired || Boolean(promotionTargetScopeId.trim())) &&
    !promoteRecord.isPending;
  const sourceReference = [
    record.source?.kind ?? "memory",
    record.source?.issueId ? `issue:${record.source.issueId}` : null,
    record.source?.commentId ? `comment:${record.source.commentId}` : null,
    record.source?.documentKey ? `document:${record.source.documentKey}` : null,
    record.source?.runId ? `run:${record.source.runId}` : null,
  ].filter(Boolean).join(" ");
  const canSaveCorrection = canMutate && Boolean(correctionContent.trim()) && Boolean(correctionReason.trim()) && !correctRecord.isPending;

  const copySourceReference = () => {
    void navigator.clipboard.writeText(sourceReference);
    pushToast({ title: "Source reference copied", tone: "success" });
  };

  const handleSheetKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const isEditable = Boolean(target.closest("input, textarea, select, [contenteditable=true]"));

    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      if (canSaveCorrection) {
        event.preventDefault();
        correctRecord.mutate();
      }
      return;
    }

    if (isEditable) return;

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
      const selection = window.getSelection()?.toString();
      if (!selection) {
        event.preventDefault();
        copySourceReference();
      }
      return;
    }

    if (!canMutate || reviewRecord.isPending || event.metaKey || event.ctrlKey || event.altKey) return;

    const key = event.key.toLowerCase();
    if (key === "a") {
      event.preventDefault();
      reviewRecord.mutate("accepted");
    }
    if (key === "r") {
      event.preventDefault();
      reviewRecord.mutate("rejected");
    }
    if (key === "p") {
      event.preventDefault();
      reviewRecord.mutate("pending");
    }
  };

  return (
    <Sheet open={Boolean(record)} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl" onKeyDownCapture={handleSheetKeyDown}>
        <SheetHeader>
          <SheetTitle className="text-base">{getMemoryRecordTitle(record)}</SheetTitle>
          <SheetDescription>
            {record.providerKey} · {record.sensitivityLabel} · {record.retentionState}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-5 space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={memoryReviewStatus(record)} />
            <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] text-muted-foreground">
              {record.scopeType}
            </span>
            <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] text-muted-foreground">
              {labelize(record.source?.kind ?? "memory")}
            </span>
          </div>

          <div className="rounded-md border border-border px-4 py-3">
            <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">Content</div>
            <p className="whitespace-pre-wrap text-sm leading-6">{record.content}</p>
            {record.summary ? (
              <div className="mt-4 border-t border-border pt-3 text-sm text-muted-foreground">
                {record.summary}
              </div>
            ) : null}
          </div>

          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="rounded-md border border-border px-3 py-3">
              <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">Provenance</div>
              <div className="space-y-1">
                {sourceUrl ? (
                  <Link className="text-primary hover:underline" to={sourceUrl}>
                    {sourceLabel(record, issuesById)}
                  </Link>
                ) : (
                  <div>{sourceLabel(record, issuesById)}</div>
                )}
                {record.citation?.label || record.citation?.sourceTitle ? (
                  <div className="text-xs text-muted-foreground">
                    {record.citation.label ?? record.citation.sourceTitle}
                  </div>
                ) : null}
                {record.citation?.url ? (
                  <a className="block break-all text-xs text-primary hover:underline" href={record.citation.url}>
                    {record.citation.url}
                  </a>
                ) : null}
              </div>
            </div>
            <div className="rounded-md border border-border px-3 py-3">
              <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">Scope</div>
              <div className="space-y-1 text-xs">
                {project ? <Link className="block text-primary hover:underline" to={projectUrl(project)}>{project.name}</Link> : null}
                {agent ? <Link className="block text-primary hover:underline" to={agentUrl(agent)}>{agent.name}</Link> : null}
                <div className="break-all text-muted-foreground">{record.scopeId ?? record.scopeType}</div>
                <div className="text-muted-foreground">Created {formatDateTime(record.createdAt)}</div>
              </div>
            </div>
          </div>

          <div className="rounded-md border border-border px-4 py-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">Review</div>
                <div className="text-xs text-muted-foreground">
                  {record.reviewedAt ? `Last reviewed ${relativeTime(record.reviewedAt)}` : "Not reviewed yet"}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={copySourceReference}
              >
                <Clipboard className="mr-2 h-4 w-4" />
                Copy
              </Button>
            </div>
            <Textarea
              value={reviewNote}
              onChange={(event) => setReviewNote(event.target.value)}
              placeholder="Optional review note"
              className="min-h-20"
            />
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!canMutate || reviewRecord.isPending}
                onClick={() => reviewRecord.mutate("pending")}
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                Pending
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!canMutate || reviewRecord.isPending}
                onClick={() => reviewRecord.mutate("rejected")}
              >
                <X className="mr-2 h-4 w-4" />
                Reject
              </Button>
              <Button
                size="sm"
                disabled={!canMutate || reviewRecord.isPending}
                onClick={() => reviewRecord.mutate("accepted")}
              >
                <Check className="mr-2 h-4 w-4" />
                Accept
              </Button>
            </div>
          </div>

          <div className="rounded-md border border-border px-4 py-4">
            <div className="mb-3 text-sm font-medium">Correct</div>
            <Textarea
              value={correctionContent}
              onChange={(event) => setCorrectionContent(event.target.value)}
              className="min-h-32"
            />
            <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
              <Input
                value={correctionReason}
                onChange={(event) => setCorrectionReason(event.target.value)}
                placeholder="Correction reason"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!canSaveCorrection}
                onClick={() => correctRecord.mutate()}
              >
                Save correction
              </Button>
            </div>
          </div>

          <div className="rounded-md border border-border px-4 py-4">
            <div className="mb-3 text-sm font-medium">Revoke</div>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <Input
                value={revokeReason}
                onChange={(event) => setRevokeReason(event.target.value)}
                placeholder="Revocation reason"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!canMutate || !revokeReason.trim() || revokeRecord.isPending}
                onClick={() => revokeRecord.mutate()}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Revoke
              </Button>
            </div>
          </div>

          {canPromote ? (
            <div className="rounded-md border border-border px-4 py-4">
              <div className="mb-1 text-sm font-medium">Promote</div>
              <div className="mb-3 text-xs text-muted-foreground">
                Widen this record to a broader scope. The original record is superseded.
              </div>
              <div className="space-y-2">
                <Select
                  value={promotionTargetScopeType}
                  onValueChange={(v) => {
                    setPromotionTargetScopeType(v as MemoryPromotionScopeType);
                    setPromotionTargetScopeId("");
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select target scope…" />
                  </SelectTrigger>
                  <SelectContent>
                    {validPromotionTargets.map((t) => (
                      <SelectItem key={t} value={t}>
                        {labelize(t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {scopeIdRequired ? (
                  <Input
                    value={promotionTargetScopeId}
                    onChange={(e) => setPromotionTargetScopeId(e.target.value)}
                    placeholder={`${labelize(promotionTargetScopeType)} ID`}
                  />
                ) : null}
                <div className="flex gap-2">
                  <Input
                    value={promotionReason}
                    onChange={(e) => setPromotionReason(e.target.value)}
                    placeholder="Promotion reason"
                    className="flex-1"
                  />
                  <Button
                    size="sm"
                    disabled={!canSubmitPromotion}
                    onClick={() => promoteRecord.mutate()}
                  >
                    <ArrowUpCircle className="mr-2 h-4 w-4" />
                    Promote
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          <div className="rounded-md border border-border px-4 py-4">
            <div className="mb-3 text-sm font-medium">Operations</div>
            {operationsQuery.isLoading ? (
              <div className="text-sm text-muted-foreground">Loading operations...</div>
            ) : (operationsQuery.data ?? []).length === 0 ? (
              <div className="text-sm text-muted-foreground">No related operations found.</div>
            ) : (
              <div className="divide-y divide-border">
                {(operationsQuery.data ?? []).map((operation) => (
                  <div key={operation.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <div>
                      <div className="font-medium">{operation.operationType}</div>
                      <div className="text-xs text-muted-foreground">{operation.hookKind ?? operation.triggerKind}</div>
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      <div>{operation.status}</div>
                      <div>{relativeTime(operation.occurredAt)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="text-xs text-muted-foreground">
            Shortcuts: A accept · R reject · P pending · Cmd+C copy reference · Cmd+Enter save correction
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function WorkMemories() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const searchAgentId = searchParams.get("agentId") ?? "";
  const [filters, setFilters] = useState<MemoryFilters>(() => ({ ...DEFAULT_FILTERS, agentId: searchAgentId }));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [selectedRecordIds, setSelectedRecordIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setBreadcrumbs([{ label: "Memories" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    setFilters((current) => current.agentId === searchAgentId ? current : { ...current, agentId: searchAgentId });
  }, [searchAgentId]);

  const providersQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.memory.providers(selectedCompanyId) : ["memory", "providers", "none"],
    queryFn: () => memoryApi.providers(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const bindingsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.memory.bindings(selectedCompanyId) : ["memory", "bindings", "none"],
    queryFn: () => memoryApi.listBindings(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "none"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const projectsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.projects.list(selectedCompanyId) : ["projects", "none"],
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const issuesQuery = useQuery({
    queryKey: selectedCompanyId ? [...queryKeys.issues.list(selectedCompanyId), "memory-filter"] : ["issues", "none"],
    queryFn: () => issuesApi.list(selectedCompanyId!, { includeRoutineExecutions: true, limit: 300 }),
    enabled: !!selectedCompanyId,
  });

  const recordFilters = useMemo(() => buildRecordFilters(filters), [filters]);
  const recordsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.memory.records(selectedCompanyId, recordFilters) : ["memory", "records", "none"],
    queryFn: () => memoryApi.listRecords(selectedCompanyId!, recordFilters),
    enabled: !!selectedCompanyId,
  });
  const countFilters = useMemo(
    () => Object.fromEntries(REVIEW_TABS.map((tab) => [tab, buildCountFilters(filters, tab)])) as Record<ReviewTab, Partial<MemoryListRecordsQuery>>,
    [filters],
  );
  const pendingCountQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.memory.recordCount(selectedCompanyId, countFilters.pending) : ["memory", "records", "count", "pending", "none"],
    queryFn: () => memoryApi.countRecords(selectedCompanyId!, countFilters.pending),
    enabled: !!selectedCompanyId,
  });
  const acceptedCountQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.memory.recordCount(selectedCompanyId, countFilters.accepted) : ["memory", "records", "count", "accepted", "none"],
    queryFn: () => memoryApi.countRecords(selectedCompanyId!, countFilters.accepted),
    enabled: !!selectedCompanyId,
  });
  const rejectedCountQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.memory.recordCount(selectedCompanyId, countFilters.rejected) : ["memory", "records", "count", "rejected", "none"],
    queryFn: () => memoryApi.countRecords(selectedCompanyId!, countFilters.rejected),
    enabled: !!selectedCompanyId,
  });
  const revokedCountQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.memory.recordCount(selectedCompanyId, countFilters.revoked) : ["memory", "records", "count", "revoked", "none"],
    queryFn: () => memoryApi.countRecords(selectedCompanyId!, countFilters.revoked),
    enabled: !!selectedCompanyId,
  });

  const agentsById = useMemo(() => new Map((agentsQuery.data ?? []).map((agent) => [agent.id, agent])), [agentsQuery.data]);
  const projectsById = useMemo(() => new Map((projectsQuery.data ?? []).map((project) => [project.id, project])), [projectsQuery.data]);
  const issuesById = useMemo(() => new Map((issuesQuery.data ?? []).map((issue) => [issue.id, issue])), [issuesQuery.data]);
  const records = recordsQuery.data ?? [];
  const selectedRecord = records.find((record) => record.id === selectedRecordId) ?? null;

  const counts = {
    pending: pendingCountQuery.data?.count ?? 0,
    accepted: acceptedCountQuery.data?.count ?? 0,
    rejected: rejectedCountQuery.data?.count ?? 0,
    revoked: revokedCountQuery.data?.count ?? 0,
  };
  const countsLoading = pendingCountQuery.isLoading || acceptedCountQuery.isLoading || rejectedCountQuery.isLoading || revokedCountQuery.isLoading;

  const selectedVisibleRecords = useMemo(
    () => records.filter((record) => selectedRecordIds.has(record.id)),
    [records, selectedRecordIds],
  );
  const allVisibleSelected = records.length > 0 && records.every((record) => selectedRecordIds.has(record.id));
  const someVisibleSelected = selectedVisibleRecords.length > 0 && !allVisibleSelected;

  const bulkReview = useMutation({
    mutationFn: async (reviewState: "pending" | "accepted" | "rejected") => {
      if (!selectedCompanyId) throw new Error("No company selected");
      const recordIds = Array.from(selectedRecordIds);
      await Promise.all(
        recordIds.map((recordId) =>
          memoryApi.reviewRecord(selectedCompanyId, recordId, {
            reviewState,
            note: null,
          }),
        ),
      );
      return recordIds.length;
    },
    onSuccess: async (count) => {
      setSelectedRecordIds(new Set());
      await queryClient.invalidateQueries({ queryKey: queryKeys.memory.all });
      pushToast({ title: `${count} memories reviewed`, tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to review memories",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  useEffect(() => {
    const visibleIds = new Set(records.map((record) => record.id));
    setSelectedRecordIds((current) => {
      const next = new Set(Array.from(current).filter((id) => visibleIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [records]);

  const visibleCounts = useMemo(() => {
    return {
      total: records.length,
      pending: records.filter((record) => record.reviewState === "pending").length,
      accepted: records.filter((record) => record.reviewState === "accepted").length,
      rejected: records.filter((record) => record.reviewState === "rejected").length,
      revoked: records.filter((record) => memoryReviewStatus(record) === "revoked").length,
    };
  }, [records]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Database} message="Select a company to view memories." />;
  }

  const providerOptions = [
    { value: "", label: "Any provider" },
    ...(providersQuery.data ?? []).map((provider) => ({ value: provider.key, label: provider.displayName })),
  ];
  const bindingById = new Map((bindingsQuery.data ?? []).map((binding) => [binding.id, binding]));
  const activeReviewTab: ReviewTab | null =
    filters.retentionState === "revoked" && filters.includeRevoked
      ? "revoked"
      : filters.reviewState || null;
  const activeFilterChips = [
    activeReviewTab
      ? {
          key: "review",
          label: `Review: ${labelize(activeReviewTab)}`,
          onClear: () =>
            setFilters((current) => ({
              ...current,
              reviewState: "",
              retentionState: activeReviewTab === "revoked" ? "" : current.retentionState,
              includeRevoked: activeReviewTab === "revoked" ? false : current.includeRevoked,
            })),
        }
      : null,
    filters.q.trim()
      ? { key: "q", label: `Search: ${filters.q.trim()}`, onClear: () => setFilters((current) => ({ ...current, q: "" })) }
      : null,
    filters.providerKey
      ? {
          key: "provider",
          label: `Provider: ${providerOptions.find((option) => option.value === filters.providerKey)?.label ?? filters.providerKey}`,
          onClear: () => setFilters((current) => ({ ...current, providerKey: "" })),
        }
      : null,
    filters.projectId
      ? {
          key: "project",
          label: `Project: ${projectsById.get(filters.projectId)?.name ?? filters.projectId}`,
          onClear: () => setFilters((current) => ({ ...current, projectId: "" })),
        }
      : null,
    filters.agentId
      ? {
          key: "agent",
          label: `Agent: ${agentsById.get(filters.agentId)?.name ?? filters.agentId}`,
          onClear: () => setFilters((current) => ({ ...current, agentId: "" })),
        }
      : null,
    filters.issueId
      ? {
          key: "task",
          label: `Task: ${issuesById.get(filters.issueId)?.identifier ?? filters.issueId.slice(0, 8)}`,
          onClear: () => setFilters((current) => ({ ...current, issueId: "" })),
        }
      : null,
    filters.runId.trim()
      ? {
          key: "run",
          label: `Run: ${filters.runId.trim().slice(0, 8)}`,
          onClear: () => setFilters((current) => ({ ...current, runId: "" })),
        }
      : null,
    filters.sourceKind
      ? {
          key: "source",
          label: `Source: ${labelize(filters.sourceKind)}`,
          onClear: () => setFilters((current) => ({ ...current, sourceKind: "" })),
        }
      : null,
    filters.sensitivityLabel
      ? {
          key: "sensitivity",
          label: `Sensitivity: ${filters.sensitivityLabel}`,
          onClear: () => setFilters((current) => ({ ...current, sensitivityLabel: "" })),
        }
      : null,
    filters.retentionState && activeReviewTab !== "revoked"
      ? {
          key: "retention",
          label: `Retention: ${filters.retentionState}`,
          onClear: () => setFilters((current) => ({ ...current, retentionState: "" })),
        }
      : null,
    filters.scopeType
      ? {
          key: "scope",
          label: `Scope: ${filters.scopeType}`,
          onClear: () => setFilters((current) => ({ ...current, scopeType: "" })),
        }
      : null,
    filters.includeRevoked && activeReviewTab !== "revoked"
      ? {
          key: "include-revoked",
          label: "Including revoked",
          onClear: () => setFilters((current) => ({ ...current, includeRevoked: false })),
        }
      : null,
    filters.includeExpired
      ? {
          key: "include-expired",
          label: "Including expired",
          onClear: () => setFilters((current) => ({ ...current, includeExpired: false })),
        }
      : null,
    filters.includeSuperseded
      ? {
          key: "include-superseded",
          label: "Including superseded",
          onClear: () => setFilters((current) => ({ ...current, includeSuperseded: false })),
        }
      : null,
  ].filter(Boolean) as Array<{ key: string; label: string; onClear: () => void }>;
  const selectReviewTab = (tab: ReviewTab) => {
    setFilters((current) => ({
      ...current,
      reviewState: tab === "revoked" ? "" : tab,
      retentionState: tab === "revoked" ? "revoked" : current.retentionState === "revoked" ? "" : current.retentionState,
      includeRevoked: tab === "revoked" ? true : false,
    }));
    setSelectedRecordIds(new Set());
  };
  const toggleRecordSelection = (recordId: string, checked: boolean) => {
    setSelectedRecordIds((current) => {
      const next = new Set(current);
      if (checked) next.add(recordId);
      else next.delete(recordId);
      return next;
    });
  };
  const toggleAllVisible = (checked: boolean) => {
    setSelectedRecordIds((current) => {
      const next = new Set(current);
      if (checked) {
        records.forEach((record) => next.add(record.id));
      } else {
        records.forEach((record) => next.delete(record.id));
      }
      return next;
    });
  };
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-xl font-bold">Memories</h1>
          </div>
          <div className="mt-3 flex min-h-7 flex-wrap gap-2">
            {activeFilterChips.length === 0 ? (
              <span className="text-xs text-muted-foreground">No filters applied</span>
            ) : (
              activeFilterChips.map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                  onClick={chip.onClear}
                >
                  {chip.label}
                  <X className="h-3 w-3" />
                </button>
              ))
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setFilters({ ...DEFAULT_FILTERS, agentId: searchAgentId });
              setSelectedRecordIds(new Set());
            }}
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset
          </Button>
        </div>
      </div>

      <Collapsible open={filtersOpen} onOpenChange={setFiltersOpen} className="rounded-md border border-border px-4 py-4">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="w-full justify-between px-0 hover:bg-transparent">
            <span className="flex items-center gap-2 text-sm font-medium">
              <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
              Filters
            </span>
            <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", filtersOpen && "rotate-180")} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-4">
        <div className="grid gap-3 lg:grid-cols-4">
          <label className="space-y-1 text-xs font-medium text-muted-foreground lg:col-span-2">
            <span>Search</span>
            <Input
              value={filters.q}
              onChange={(event) => setFilters((current) => ({ ...current, q: event.target.value }))}
              placeholder="Search title, summary, or content"
            />
          </label>
          <FilterSelect
            label="Review"
            value={filters.reviewState}
            onChange={(reviewState) =>
              setFilters((current) => ({ ...current, reviewState: reviewState as MemoryFilters["reviewState"] }))
            }
            options={[
              { value: "", label: "Any review state" },
              ...MEMORY_REVIEW_STATES.map((state) => ({ value: state, label: state })),
            ]}
          />
          <FilterSelect
            label="Provider"
            value={filters.providerKey}
            onChange={(providerKey) => setFilters((current) => ({ ...current, providerKey }))}
            options={providerOptions}
          />
          <FilterSelect
            label="Project"
            value={filters.projectId}
            onChange={(projectId) => setFilters((current) => ({ ...current, projectId }))}
            options={[
              { value: "", label: "Any project" },
              ...(projectsQuery.data ?? []).map((project) => ({ value: project.id, label: project.name })),
            ]}
          />
          <FilterSelect
            label="Agent"
            value={filters.agentId}
            onChange={(agentId) => setFilters((current) => ({ ...current, agentId }))}
            options={[
              { value: "", label: "Any agent" },
              ...(agentsQuery.data ?? []).map((agent) => ({ value: agent.id, label: agent.name })),
            ]}
          />
          <FilterSelect
            label="Task"
            value={filters.issueId}
            onChange={(issueId) => setFilters((current) => ({ ...current, issueId }))}
            options={[
              { value: "", label: "Any task" },
              ...(issuesQuery.data ?? []).map((issue) => ({
                value: issue.id,
                label: `${issue.identifier ?? issue.id.slice(0, 8)} ${issue.title}`,
              })),
            ]}
          />
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            <span>Run ID</span>
            <Input
              value={filters.runId}
              onChange={(event) => setFilters((current) => ({ ...current, runId: event.target.value }))}
              placeholder="UUID"
            />
          </label>
          <FilterSelect
            label="Source"
            value={filters.sourceKind}
            onChange={(sourceKind) =>
              setFilters((current) => ({ ...current, sourceKind: sourceKind as MemoryFilters["sourceKind"] }))
            }
            options={[
              { value: "", label: "Any source" },
              ...MEMORY_SOURCE_KINDS.map((kind) => ({ value: kind, label: labelize(kind) })),
            ]}
          />
          <FilterSelect
            label="Sensitivity"
            value={filters.sensitivityLabel}
            onChange={(sensitivityLabel) =>
              setFilters((current) => ({
                ...current,
                sensitivityLabel: sensitivityLabel as MemoryFilters["sensitivityLabel"],
              }))
            }
            options={[
              { value: "", label: "Any label" },
              ...MEMORY_SENSITIVITY_LABELS.map((label) => ({ value: label, label })),
            ]}
          />
          <FilterSelect
            label="Retention"
            value={filters.retentionState}
            onChange={(retentionState) =>
              setFilters((current) => ({
                ...current,
                retentionState: retentionState as MemoryFilters["retentionState"],
              }))
            }
            options={[
              { value: "", label: "Active records" },
              ...MEMORY_RETENTION_STATES.map((state) => ({ value: state, label: state })),
            ]}
          />
          <FilterSelect
            label="Scope"
            value={filters.scopeType}
            onChange={(scopeType) =>
              setFilters((current) => ({ ...current, scopeType: scopeType as MemoryFilters["scopeType"] }))
            }
            options={[
              { value: "", label: "Any scope" },
              ...MEMORY_SCOPE_TYPES.map((scope) => ({ value: scope, label: scope })),
            ]}
          />
        </div>
        <div className="mt-4 rounded-md border border-border px-3 py-3">
          <div className="mb-3 text-xs font-medium text-muted-foreground">Include records</div>
          <div className="flex flex-wrap gap-4 text-sm">
            <Label className="gap-2">
              <Checkbox
                checked={filters.includeRevoked}
                onCheckedChange={(checked) => setFilters((current) => ({ ...current, includeRevoked: checked === true }))}
              />
              Include revoked
            </Label>
            <Label className="gap-2">
              <Checkbox
                checked={filters.includeExpired}
                onCheckedChange={(checked) => setFilters((current) => ({ ...current, includeExpired: checked === true }))}
              />
              Include expired
            </Label>
            <Label className="gap-2">
              <Checkbox
                checked={filters.includeSuperseded}
                onCheckedChange={(checked) => setFilters((current) => ({ ...current, includeSuperseded: checked === true }))}
              />
              Include superseded
            </Label>
          </div>
        </div>
        </CollapsibleContent>
      </Collapsible>

      <div className="flex flex-wrap items-center gap-2">
        {REVIEW_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
              activeReviewTab === tab
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground",
            )}
            onClick={() => selectReviewTab(tab)}
          >
            {labelize(tab)} {countsLoading ? "" : `(${counts[tab]})`}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          Showing {visibleCounts.total} records from this page
        </span>
      </div>

      {recordsQuery.isLoading ? (
        <div className="rounded-md border border-border">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="grid gap-3 border-b border-border px-4 py-4 last:border-b-0 md:grid-cols-[32px_1fr_220px_160px]">
              <Skeleton className="h-4 w-4" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-4/5" />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-3 w-24" />
              </div>
              <div className="space-y-2 md:justify-self-end">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-3 w-20" />
              </div>
            </div>
          ))}
        </div>
      ) : recordsQuery.error ? (
        <EmptyState
          icon={AlertTriangle}
          title="Memory records failed to load"
          message={recordsQuery.error.message}
          action="Retry"
          onAction={() => void recordsQuery.refetch()}
          tone="destructive"
        />
      ) : records.length === 0 ? (
        <EmptyState
          icon={Database}
          title="No memories match these filters"
          message="Try widening review state or clearing filters."
        />
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <div className="grid gap-3 border-b border-border bg-muted/30 px-4 py-3 text-xs font-medium text-muted-foreground md:grid-cols-[32px_1fr_220px_160px]">
            <div>
              <Checkbox
                checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
                onCheckedChange={(checked) => toggleAllVisible(checked === true)}
                aria-label="Select all visible memories"
              />
            </div>
            <div>Memory</div>
            <div className="hidden md:block">Source</div>
            <div className="hidden text-right md:block">Context</div>
          </div>
          <div className="divide-y divide-border">
            {records.map((record) => (
              <MemoryRecordRow
                key={record.id}
                record={record}
                binding={bindingById.get(record.bindingId)}
                issuesById={issuesById}
                agentsById={agentsById}
                projectsById={projectsById}
                onSelect={() => setSelectedRecordId(record.id)}
                selected={selectedRecordIds.has(record.id)}
                onSelectedChange={(checked) => toggleRecordSelection(record.id, checked)}
              />
            ))}
          </div>
        </div>
      )}

      {selectedRecordIds.size > 0 ? (
        <div className="sticky bottom-4 z-10 mx-auto flex w-fit max-w-full flex-wrap items-center gap-2 rounded-md border border-border bg-background px-3 py-2 shadow-lg">
          <span className="px-1 text-sm font-medium">{selectedRecordIds.size} selected</span>
          <Button size="sm" variant="outline" disabled={bulkReview.isPending} onClick={() => bulkReview.mutate("accepted")}>
            <Check className="mr-2 h-4 w-4" />
            Accept
          </Button>
          <Button size="sm" variant="outline" disabled={bulkReview.isPending} onClick={() => bulkReview.mutate("rejected")}>
            <X className="mr-2 h-4 w-4" />
            Reject
          </Button>
          <Button size="sm" variant="outline" disabled={bulkReview.isPending} onClick={() => bulkReview.mutate("pending")}>
            <RotateCcw className="mr-2 h-4 w-4" />
            Mark pending
          </Button>
        </div>
      ) : null}

      <MemoryDetailSheet
        companyId={selectedCompanyId}
        record={selectedRecord}
        agentsById={agentsById}
        issuesById={issuesById}
        projectsById={projectsById}
        onClose={() => setSelectedRecordId(null)}
      />
    </div>
  );
}
