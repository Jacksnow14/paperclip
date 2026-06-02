import type {
  MemoryBinding,
  MemoryCaptureResult,
  MemoryHookKind,
  MemoryOperation,
  MemoryQueryResult,
  MemoryRecord,
} from "@paperclipai/shared";

type MemoryHookTraceAction = "hydrate" | "capture";
type MemoryHookTraceStatus = "hydrated" | "captured" | "skipped" | "errored";

export interface MemoryHookRecordTrace {
  id: string;
  title: string | null;
  sourceKind: string | null;
  sourceIssueId: string | null;
  sourceCommentId: string | null;
  sourceDocumentKey: string | null;
  sourceRunId: string | null;
  citationLabel: string | null;
  citationSourceTitle: string | null;
}

export interface MemoryHookTrace {
  hookKind: MemoryHookKind;
  action: MemoryHookTraceAction;
  status: MemoryHookTraceStatus;
  reason: string | null;
  binding: {
    id: string;
    key: string;
    providerKey: string;
  } | null;
  operation: {
    id: string;
    operationType: MemoryOperation["operationType"];
    status: MemoryOperation["status"];
  } | null;
  recordCount: number;
  records: MemoryHookRecordTrace[];
  preambleLength: number | null;
  error: string | null;
}

function actionForHook(hookKind: MemoryHookKind): MemoryHookTraceAction {
  return hookKind === "pre_run_hydrate" ? "hydrate" : "capture";
}

function bindingTrace(binding: Pick<MemoryBinding, "id" | "key" | "providerKey"> | null | undefined) {
  if (!binding) return null;
  return {
    id: binding.id,
    key: binding.key,
    providerKey: binding.providerKey,
  };
}

function operationTrace(operation: MemoryOperation | null | undefined): MemoryHookTrace["operation"] {
  if (!operation) return null;
  return {
    id: operation.id,
    operationType: operation.operationType,
    status: operation.status,
  };
}

function recordTrace(record: MemoryRecord): MemoryHookRecordTrace {
  return {
    id: record.id,
    title: record.title ?? null,
    sourceKind: record.source?.kind ?? null,
    sourceIssueId: record.source?.issueId ?? null,
    sourceCommentId: record.source?.commentId ?? null,
    sourceDocumentKey: record.source?.documentKey ?? null,
    sourceRunId: record.source?.runId ?? null,
    citationLabel: record.citation?.label ?? null,
    citationSourceTitle: record.citation?.sourceTitle ?? null,
  };
}

export function buildSkippedMemoryHookTrace(input: {
  hookKind: MemoryHookKind;
  reason: string;
  binding?: Pick<MemoryBinding, "id" | "key" | "providerKey"> | null;
}): MemoryHookTrace {
  return {
    hookKind: input.hookKind,
    action: actionForHook(input.hookKind),
    status: "skipped",
    reason: input.reason,
    binding: bindingTrace(input.binding),
    operation: null,
    recordCount: 0,
    records: [],
    preambleLength: null,
    error: null,
  };
}

export function buildErroredMemoryHookTrace(input: {
  hookKind: MemoryHookKind;
  error: unknown;
  binding?: Pick<MemoryBinding, "id" | "key" | "providerKey"> | null;
}): MemoryHookTrace {
  return {
    hookKind: input.hookKind,
    action: actionForHook(input.hookKind),
    status: "errored",
    reason: null,
    binding: bindingTrace(input.binding),
    operation: null,
    recordCount: 0,
    records: [],
    preambleLength: null,
    error: input.error instanceof Error ? input.error.message : String(input.error),
  };
}

export function buildPreRunHydrateTrace(
  binding: Pick<MemoryBinding, "id" | "key" | "providerKey">,
  result: MemoryQueryResult,
): MemoryHookTrace {
  return {
    hookKind: "pre_run_hydrate",
    action: "hydrate",
    status: "hydrated",
    reason: null,
    binding: bindingTrace(binding),
    operation: operationTrace(result.operation),
    recordCount: result.records.length,
    records: result.records.map(recordTrace),
    preambleLength: result.preamble?.length ?? 0,
    error: null,
  };
}

export function buildThinIndexHydrateTrace(
  binding: Pick<MemoryBinding, "id" | "key" | "providerKey">,
  preamble: string,
  scopeRecordCount: number,
): MemoryHookTrace {
  return {
    hookKind: "pre_run_hydrate",
    action: "hydrate",
    status: "hydrated",
    reason: "thin_index",
    binding: bindingTrace(binding),
    operation: null,
    recordCount: scopeRecordCount,
    records: [],
    preambleLength: preamble.length,
    error: null,
  };
}

export function buildPostRunCaptureTrace(
  binding: Pick<MemoryBinding, "id" | "key" | "providerKey">,
  result: MemoryCaptureResult,
): MemoryHookTrace {
  return {
    hookKind: "post_run_capture",
    action: "capture",
    status: "captured",
    reason: null,
    binding: bindingTrace(binding),
    operation: operationTrace(result.operation),
    recordCount: result.records.length,
    records: result.records.map(recordTrace),
    preambleLength: null,
    error: null,
  };
}

function describeHook(hookKind: MemoryHookKind) {
  switch (hookKind) {
    case "pre_run_hydrate":
      return "pre-run hydrate";
    case "post_run_capture":
      return "post-run capture";
    case "issue_comment_capture":
      return "issue comment capture";
    case "issue_document_capture":
      return "issue document capture";
    default:
      return hookKind;
  }
}

function describeRecord(record: MemoryHookRecordTrace) {
  const label = record.title || record.citationSourceTitle || record.citationLabel || "untitled";
  return `${record.id} (${label})`;
}

export function formatMemoryHookTraceLog(trace: MemoryHookTrace) {
  const parts = [
    `[paperclip:memory] ${describeHook(trace.hookKind)} ${trace.status}`,
    `${trace.recordCount} record${trace.recordCount === 1 ? "" : "s"}`,
  ];
  if (trace.reason) parts.push(`reason=${trace.reason}`);
  if (trace.binding) parts.push(`binding=${trace.binding.key}`, `provider=${trace.binding.providerKey}`);
  if (trace.operation) parts.push(`operation=${trace.operation.id}`);
  if (trace.preambleLength !== null) parts.push(`preambleBytes=${trace.preambleLength}`);
  if (trace.records.length > 0) parts.push(`records=${trace.records.map(describeRecord).join(", ")}`);
  if (trace.error) parts.push(`error=${trace.error}`);
  return `${parts.join("; ")}\n`;
}
