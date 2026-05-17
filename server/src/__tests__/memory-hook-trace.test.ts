import { describe, expect, it } from "vitest";
import {
  buildPreRunHydrateTrace,
  buildSkippedMemoryHookTrace,
  buildThinIndexHydrateTrace,
  formatMemoryHookTraceLog,
} from "../services/memory-hook-trace.js";

describe("memory hook trace logs", () => {
  it("formats hydrated records with binding, provider, operation, and record ids", () => {
    const trace = buildPreRunHydrateTrace(
      {
        id: "binding-1",
        key: "company-default",
        providerKey: "local_basic",
      },
      {
        preamble: "Use the deployment notes.",
        operation: {
          id: "operation-1",
          operationType: "query",
          status: "succeeded",
        },
        records: [
          {
            id: "record-1",
            title: "Deployment notes",
            source: { kind: "issue_document", issueId: "issue-1", documentKey: "plan" },
            citation: { label: "Issue document", sourceTitle: "Plan" },
          },
        ],
      } as any,
    );

    expect(formatMemoryHookTraceLog(trace)).toBe(
      "[paperclip:memory] pre-run hydrate hydrated; 1 record; binding=company-default; provider=local_basic; operation=operation-1; preambleBytes=25; records=record-1 (Deployment notes)\n",
    );
  });

  it("formats skipped hook decisions with an explicit reason", () => {
    const trace = buildSkippedMemoryHookTrace({
      hookKind: "post_run_capture",
      reason: "no_run_summary",
    });

    expect(formatMemoryHookTraceLog(trace)).toBe(
      "[paperclip:memory] post-run capture skipped; 0 records; reason=no_run_summary\n",
    );
  });

  it("builds thin-index hydrate trace without operation or records", () => {
    const preamble = [
      `<memory-index binding="company-default" records="12" mode="thin_index">`,
      `Memory is available for this agent via explicit search. 12 records in scope.`,
      `</memory-index>`,
    ].join("\n");
    const trace = buildThinIndexHydrateTrace(
      { id: "binding-1", key: "company-default", providerKey: "local_basic" },
      preamble,
      12,
    );
    expect(trace.hookKind).toBe("pre_run_hydrate");
    expect(trace.status).toBe("hydrated");
    expect(trace.reason).toBe("thin_index");
    expect(trace.operation).toBeNull();
    expect(trace.records).toEqual([]);
    expect(trace.recordCount).toBe(12);
    expect(trace.preambleLength).toBe(preamble.length);
  });

  it("thin-index preamble is significantly smaller than top-k-facts preamble", () => {
    const thinIndexPreamble = [
      `<memory-index binding="default" records="50" mode="thin_index">`,
      `Memory is available for this agent via explicit search. 50 records in scope.`,
      `</memory-index>`,
    ].join("\n");

    const topKFactsPreamble = Array.from({ length: 5 }, (_, i) =>
      `## Memory ${i + 1}\n\nThis is a detailed memory record with substantial content that would typically be injected into the prompt. It contains facts, context, and other information that the agent might need. Average record: ~200 chars.`,
    ).join("\n\n");

    expect(thinIndexPreamble.length).toBeLessThan(200);
    expect(topKFactsPreamble.length).toBeGreaterThan(500);
    expect(thinIndexPreamble.length).toBeLessThan(topKFactsPreamble.length * 0.3);
  });
});
