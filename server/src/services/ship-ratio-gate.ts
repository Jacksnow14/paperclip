// AUR-5207: the second gate the founder asked for on top of AUR-5168's token
// cap. Token spend measures what the fleet burns, not what it lands -- an
// unreviewed PR sitting open costs zero ongoing tokens, so a spend-based cap
// alone cannot see a fleet that stays "compliant" while shipping nothing.
// This gate reads a rolling 7-day merged-PR ratio (money-making repo vs
// self-improvement repo) computed out-of-band by
// scripts/sgi-ship-ratio-gate.mjs, since the server process has no GitHub
// credentials to compute it inline.
import { desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { shipRatioSnapshots } from "@paperclipai/db";

export const SHIP_RATIO_FLOOR = 2;

export interface ShipRatioDisagreement {
  prNumber: number;
  repo: string;
  repoWorkClass: "revenue" | "self_improvement";
  issueIdentifier: string;
  issueWorkClass: string;
  [key: string]: unknown;
}

export interface RecordShipRatioSnapshotInput {
  windowStart: Date;
  windowEnd: Date;
  moneyMakingMerged: number;
  selfImprovementMerged: number;
  moneyMakingClosedWithoutMerge?: number;
  selfImprovementClosedWithoutMerge?: number;
  disagreements?: ShipRatioDisagreement[];
  createdByRunId?: string | null;
}

export interface ShipRatioSnapshot {
  id: string;
  windowStart: string;
  windowEnd: string;
  moneyMakingMerged: number;
  selfImprovementMerged: number;
  moneyMakingClosedWithoutMerge: number;
  selfImprovementClosedWithoutMerge: number;
  ratio: number;
  floorRatio: number;
  overCap: boolean;
  disagreements: ShipRatioDisagreement[];
  createdAt: string;
}

function computeRatio(moneyMakingMerged: number, selfImprovementMerged: number): number {
  return moneyMakingMerged / Math.max(selfImprovementMerged, 1);
}

function toShipRatioSnapshot(row: typeof shipRatioSnapshots.$inferSelect): ShipRatioSnapshot {
  return {
    id: row.id,
    windowStart: row.windowStart.toISOString(),
    windowEnd: row.windowEnd.toISOString(),
    moneyMakingMerged: row.moneyMakingMerged,
    selfImprovementMerged: row.selfImprovementMerged,
    moneyMakingClosedWithoutMerge: row.moneyMakingClosedWithoutMerge,
    selfImprovementClosedWithoutMerge: row.selfImprovementClosedWithoutMerge,
    ratio: row.ratio,
    floorRatio: row.floorRatio,
    overCap: row.overCap,
    disagreements: (row.disagreements as ShipRatioDisagreement[] | null) ?? [],
    createdAt: row.createdAt.toISOString(),
  };
}

export function shipRatioGateService(db: Db) {
  return {
    // Most-recent snapshot for the company, or null if the daily routine has
    // never run yet. A missing snapshot must NOT be treated as overCap --
    // that would shed all self-improvement work on every company until the
    // first computation lands, which is a worse failure mode than the gate
    // being a no-op until real data exists.
    getLatestSnapshot: async (companyId: string): Promise<ShipRatioSnapshot | null> => {
      const rows = await db
        .select()
        .from(shipRatioSnapshots)
        .where(eq(shipRatioSnapshots.companyId, companyId))
        .orderBy(desc(shipRatioSnapshots.createdAt))
        .limit(1);
      const row = rows[0];
      return row ? toShipRatioSnapshot(row) : null;
    },

    recordSnapshot: async (companyId: string, input: RecordShipRatioSnapshotInput): Promise<ShipRatioSnapshot> => {
      const ratio = computeRatio(input.moneyMakingMerged, input.selfImprovementMerged);
      const [row] = await db
        .insert(shipRatioSnapshots)
        .values({
          companyId,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          moneyMakingMerged: input.moneyMakingMerged,
          selfImprovementMerged: input.selfImprovementMerged,
          moneyMakingClosedWithoutMerge: input.moneyMakingClosedWithoutMerge ?? 0,
          selfImprovementClosedWithoutMerge: input.selfImprovementClosedWithoutMerge ?? 0,
          ratio,
          floorRatio: SHIP_RATIO_FLOOR,
          overCap: ratio < SHIP_RATIO_FLOOR,
          disagreements: input.disagreements ?? [],
          createdByRunId: input.createdByRunId ?? null,
        })
        .returning();
      return toShipRatioSnapshot(row);
    },
  };
}
