import { describe, expect, it } from "vitest";
import { Param } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { memoryBindings, memoryBindingTargets, memoryLocalRecords, memoryOperations } from "@paperclipai/db";
import { memoryService } from "../services/memory.js";

// Turns a real drizzle where() condition (built from and()/eq()/isNull() against
// memoryLocalRecords columns, exactly as captureLocalBasic() builds it) into a
// plain JS predicate, by reading the column name + bound value drizzle attaches
// to each Param/column chunk. This lets the fake db below apply the SAME
// filtering semantics as the real dedup query, instead of a hand-guessed
// approximation, so the "distinct keys don't collide" case is trustworthy.
function snakeToCamel(column: string): string {
  return column.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function whereToPredicate(condition: unknown): (row: Record<string, unknown>) => boolean {
  const eqConstraints: Record<string, unknown> = {};
  const isNullConstraints = new Set<string>();

  const visit = (node: unknown) => {
    if (node instanceof Param) {
      const column = (node as unknown as { encoder?: { name?: string } }).encoder?.name;
      if (column) eqConstraints[snakeToCamel(column)] = (node as unknown as { value: unknown }).value;
      return;
    }
    const sqlNode = node as { queryChunks?: unknown[] };
    if (Array.isArray(sqlNode.queryChunks)) {
      const chunks = sqlNode.queryChunks;
      for (let i = 0; i < chunks.length; i++) {
        const columnChunk = chunks[i] as { name?: string };
        const nextChunk = chunks[i + 1] as { value?: unknown[] } | undefined;
        if (columnChunk?.name && Array.isArray(nextChunk?.value) && nextChunk.value[0] === " is null") {
          isNullConstraints.add(snakeToCamel(columnChunk.name));
        }
      }
      for (const chunk of chunks) visit(chunk);
    }
  };
  visit(condition);

  return (row) => {
    for (const [key, value] of Object.entries(eqConstraints)) {
      if (row[key] !== value) return false;
    }
    for (const key of isNullConstraints) {
      if (row[key] !== null && row[key] !== undefined) return false;
    }
    return true;
  };
}

// AUR-3991: the routing-rationale backfill has no idempotency. Multiple manager
// heartbeats (CEO, CTO run A, CTO run B) reacting to the same gap issue each
// independently called POST /memory/capture for the same "routing/{issueId}"
// title, and the old captureLocalBasic() blindly inserted a new row every time
// -> 3 duplicate accepted records per key. This test exercises the real
// memoryService(...).capture() path (not a mock of the service) to prove a
// second capture of the same routing/{issueId} title, from a DIFFERENT owner,
// is a no-op that returns the existing record instead of inserting a new one.

const companyId = "11111111-1111-4111-8111-111111111111";
const bindingId = "22222222-2222-4222-8222-222222222222";
const ceoAgentId = "33333333-3333-4333-8333-333333333333";
const ctoAgentId = "44444444-4444-4444-8444-444444444444";

function makeFakeDb() {
  const records: Record<string, unknown>[] = [];
  const operations: Record<string, unknown>[] = [];

  const bindingRow = {
    id: bindingId,
    companyId,
    providerKey: "local_basic",
    enabled: true,
    key: null,
    config: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const bindingTargetRow = {
    id: "target-1",
    companyId,
    bindingId,
    targetType: "company" as const,
    targetId: companyId,
  };

  function chainable(result: Promise<unknown[]>) {
    const node: Record<string, unknown> = {
      from: () => node,
      innerJoin: () => node,
      where: () => node,
      orderBy: () => node,
      limit: () => node,
      then: (onFulfilled: (value: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        result.then(onFulfilled, onRejected),
      catch: (onRejected: (reason: unknown) => unknown) => result.catch(onRejected),
    };
    return node;
  }

  const db = {
    select: () => ({
      from: (table: unknown) => {
        if (table === memoryBindingTargets) {
          return chainable(Promise.resolve([{ target: bindingTargetRow, binding: bindingRow }]));
        }
        if (table === memoryBindings) {
          return chainable(Promise.resolve([bindingRow]));
        }
        if (table === memoryLocalRecords) {
          return {
            where: (condition: unknown) => {
              const predicate = whereToPredicate(condition);
              // Records are pushed in capture order, so the earliest match is
              // already first (mirrors orderBy(asc(createdAt))).
              return chainable(Promise.resolve(records.filter(predicate)));
            },
          };
        }
        return chainable(Promise.resolve([]));
      },
    }),
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => ({
        returning: () => {
          const now = new Date();
          const full = {
            id: `row-${records.length + operations.length + 1}`,
            createdAt: now,
            updatedAt: now,
            occurredAt: now,
            reviewState: "pending",
            revokedAt: null,
            supersededByRecordId: null,
            deletedAt: null,
            recordCount: 0,
            usageJson: [],
            status: "succeeded",
            ...row,
          };
          if (table === memoryLocalRecords) records.push(full);
          if (table === memoryOperations) operations.push(full);
          return Promise.resolve([full]);
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db;

  return { db, records };
}

describe("routing_rationale capture idempotency (AUR-3991)", () => {
  it("dedupes a second capture of the same routing/{issueId} title from a different owner", async () => {
    const { db, records } = makeFakeDb();
    const service = memoryService(db);

    const ceoActor = { actorType: "agent" as const, actorId: ceoAgentId, agentId: ceoAgentId, userId: null, runId: null };
    const ctoActor = { actorType: "agent" as const, actorId: ctoAgentId, agentId: ctoAgentId, userId: null, runId: null };

    const captureInput = {
      scope: {},
      source: { kind: "issue" as const, issueId: "AUR-9999" },
      title: "routing/AUR-9999",
      content: "Routed AUR-9999 to Claude Code Fast: bounded control-plane defect with a named failure and a test.",
      metadata: { category: "routing_rationale" },
    };

    const first = await service.capture(companyId, captureInput, ceoActor);
    expect(first.operation.resultJson?.dedup).toBeUndefined();
    expect(first.records).toHaveLength(1);

    // A different manager heartbeat (CTO) reacts to the same gap issue and
    // backfills the same key moments later.
    const second = await service.capture(companyId, captureInput, ctoActor);
    expect(second.operation.resultJson?.dedup).toBe(true);
    expect(second.records).toHaveLength(1);
    expect(second.records[0].id).toBe(first.records[0].id);

    // A third writer (e.g. a second CTO run) races in too.
    const third = await service.capture(companyId, captureInput, ceoActor);
    expect(third.operation.resultJson?.dedup).toBe(true);
    expect(third.records[0].id).toBe(first.records[0].id);

    expect(records).toHaveLength(1);
  });

  it("still captures distinct routing/{issueId} keys as separate records", async () => {
    const { db, records } = makeFakeDb();
    const service = memoryService(db);
    const actor = { actorType: "agent" as const, actorId: ceoAgentId, agentId: ceoAgentId, userId: null, runId: null };

    await service.capture(
      companyId,
      {
        scope: {},
        source: { kind: "issue" as const, issueId: "AUR-1000" },
        title: "routing/AUR-1000",
        content: "Routed AUR-1000 to CFO.",
        metadata: { category: "routing_rationale" },
      },
      actor,
    );
    await service.capture(
      companyId,
      {
        scope: {},
        source: { kind: "issue" as const, issueId: "AUR-1001" },
        title: "routing/AUR-1001",
        content: "Routed AUR-1001 to CTO.",
        metadata: { category: "routing_rationale" },
      },
      actor,
    );

    expect(records).toHaveLength(2);
  });
});
