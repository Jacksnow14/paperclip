/**
 * Pluggable scorecard storage. The in-memory adapter is the default so the
 * reference server runs with zero setup; the JSON-file adapter is provided
 * only as a persistence demo.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface ScorecardRecord {
  id: string;
  agentId: string;
  taskType: string;
  tokenCost: number;
  qualitySignal: number;
  valueSignal: number;
  reworkRequired: boolean;
  outcome: string;
  priority?: "urgent" | "high" | "medium" | "low" | null;
  scoreAdjusted: number | null;
  excludeFromAggregates: boolean;
  createdAt: string;
}

export interface ScorecardFilter {
  agentId?: string;
  taskType?: string;
}

export interface ScorecardStore {
  append(record: ScorecardRecord): void;
  query(filter?: ScorecardFilter): ScorecardRecord[];
}

export function newScorecardId(): string {
  return randomUUID();
}

export class InMemoryScorecardStore implements ScorecardStore {
  private records: ScorecardRecord[] = [];

  append(record: ScorecardRecord): void {
    this.records.push(record);
  }

  query(filter: ScorecardFilter = {}): ScorecardRecord[] {
    return this.records.filter(
      (r) =>
        (filter.agentId === undefined || r.agentId === filter.agentId) &&
        (filter.taskType === undefined || r.taskType === filter.taskType),
    );
  }
}

/** Persistence demo only — the in-memory store is the documented default. */
export class JsonFileScorecardStore implements ScorecardStore {
  constructor(private readonly filePath: string) {}

  private load(): ScorecardRecord[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, "utf8").trim();
    return raw ? (JSON.parse(raw) as ScorecardRecord[]) : [];
  }

  private save(records: ScorecardRecord[]): void {
    writeFileSync(this.filePath, JSON.stringify(records, null, 2));
  }

  append(record: ScorecardRecord): void {
    const all = this.load();
    all.push(record);
    this.save(all);
  }

  query(filter: ScorecardFilter = {}): ScorecardRecord[] {
    return this.load().filter(
      (r) =>
        (filter.agentId === undefined || r.agentId === filter.agentId) &&
        (filter.taskType === undefined || r.taskType === filter.taskType),
    );
  }
}
