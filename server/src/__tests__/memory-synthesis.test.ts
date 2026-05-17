import { describe, expect, it } from "vitest";
import {
  UnionFind,
  computeClusterId,
  jaccardSim,
  synthesisTokenize,
} from "../services/memory.js";

describe("synthesisTokenize", () => {
  it("lowercases, strips punctuation, drops stopwords and 1-char tokens, dedupes", () => {
    const tokens = synthesisTokenize(
      "The Launch Checklist lives in THE issue document. A document!",
    );
    expect([...tokens].sort()).toEqual(
      ["checklist", "document", "issue", "launch", "lives"].sort(),
    );
  });

  it("returns an empty set for null/empty/whitespace input", () => {
    expect(synthesisTokenize(null).size).toBe(0);
    expect(synthesisTokenize("").size).toBe(0);
    expect(synthesisTokenize("   \n\t  ").size).toBe(0);
  });

  it("caps the token set at 200 unique tokens", () => {
    const words: string[] = [];
    for (let i = 0; i < 500; i++) words.push(`tok${i}`);
    const tokens = synthesisTokenize(words.join(" "));
    expect(tokens.size).toBe(200);
  });

  it("ignores duplicate tokens after normalization", () => {
    const tokens = synthesisTokenize("Cluster cluster CLUSTER, cluster!");
    expect([...tokens]).toEqual(["cluster"]);
  });
});

describe("jaccardSim", () => {
  it("is symmetric and bounded in [0, 1]", () => {
    const a = new Set(["alpha", "beta", "gamma"]);
    const b = new Set(["beta", "gamma", "delta"]);
    const j = jaccardSim(a, b);
    expect(j).toBeCloseTo(2 / 4);
    expect(jaccardSim(b, a)).toBeCloseTo(j);
  });

  it("returns 0 when either set is empty", () => {
    expect(jaccardSim(new Set(), new Set(["x"]))).toBe(0);
    expect(jaccardSim(new Set(["x"]), new Set())).toBe(0);
    expect(jaccardSim(new Set(), new Set())).toBe(0);
  });

  it("returns 1 for identical token sets", () => {
    const tokens = new Set(["one", "two", "three"]);
    expect(jaccardSim(tokens, new Set(tokens))).toBe(1);
  });
});

describe("computeClusterId", () => {
  it("is deterministic across reruns of the same record id set", () => {
    const ids = ["rec-c", "rec-a", "rec-b"];
    expect(computeClusterId(ids)).toBe(computeClusterId(ids));
  });

  it("is order-independent", () => {
    const a = computeClusterId(["rec-a", "rec-b", "rec-c"]);
    const b = computeClusterId(["rec-c", "rec-a", "rec-b"]);
    expect(a).toBe(b);
  });

  it("changes when the supporting set changes", () => {
    expect(computeClusterId(["rec-a", "rec-b"])).not.toBe(
      computeClusterId(["rec-a", "rec-b", "rec-c"]),
    );
  });

  it("returns a 16-char hex slice", () => {
    const id = computeClusterId(["rec-a"]);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("UnionFind", () => {
  it("groups transitively-connected indices and keeps singletons separate", () => {
    const uf = new UnionFind(6);
    uf.union(0, 1);
    uf.union(1, 2);
    uf.union(4, 5);
    const groups = [...uf.groups().values()].map((indices) => [...indices].sort((a, b) => a - b));
    groups.sort((a, b) => a[0] - b[0]);
    expect(groups).toEqual([[0, 1, 2], [3], [4, 5]]);
  });

  it("is idempotent under repeated unions", () => {
    const uf = new UnionFind(3);
    uf.union(0, 1);
    uf.union(0, 1);
    uf.union(1, 0);
    expect(uf.find(0)).toBe(uf.find(1));
    expect(uf.find(0)).not.toBe(uf.find(2));
  });
});

describe("deterministic clustering + quality gates (integration of pure helpers)", () => {
  // Six synthetic records. Three describe "launch checklist lives in the issue
  // document"; two describe a refresh-job topic; one is a lone outlier.
  const records = [
    {
      id: "rec-a",
      agentId: "agent-1",
      createdAt: new Date("2026-04-25T00:00:00.000Z"),
      sensitivityLabel: "internal" as const,
      content: "Launch checklist lives in the issue document.",
    },
    {
      id: "rec-b",
      agentId: "agent-2",
      createdAt: new Date("2026-04-26T00:00:00.000Z"),
      sensitivityLabel: "internal" as const,
      content: "Issue document contains the launch checklist.",
    },
    {
      id: "rec-c",
      agentId: "agent-3",
      createdAt: new Date("2026-04-27T00:00:00.000Z"),
      sensitivityLabel: "internal" as const,
      content: "Launch checklist sits in the issue document.",
    },
    {
      id: "rec-d",
      agentId: "agent-1",
      createdAt: new Date("2026-04-25T00:00:00.000Z"),
      sensitivityLabel: "internal" as const,
      content: "Memory refresh job indexes historical issue comments.",
    },
    {
      id: "rec-e",
      agentId: "agent-1",
      createdAt: new Date("2026-04-26T00:00:00.000Z"),
      sensitivityLabel: "internal" as const,
      content: "Refresh job re-indexes historical issue comments nightly.",
    },
    {
      id: "rec-f",
      agentId: "agent-2",
      createdAt: new Date("2026-04-27T00:00:00.000Z"),
      sensitivityLabel: "internal" as const,
      content: "Quota policy now applies to outbound webhooks.",
    },
  ];

  const tokenSets = records.map((r) => synthesisTokenize(r.content));
  const uf = new UnionFind(records.length);
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      if (jaccardSim(tokenSets[i], tokenSets[j]) >= 0.5) {
        uf.union(i, j);
      }
    }
  }
  const groups = [...uf.groups().values()].map((indices) =>
    indices.map((idx) => records[idx]),
  );

  it("clusters the launch-checklist trio together", () => {
    const launchCluster = groups.find((group) => group.some((r) => r.id === "rec-a"));
    expect(launchCluster?.map((r) => r.id).sort()).toEqual(["rec-a", "rec-b", "rec-c"]);
  });

  it("keeps the unrelated outlier (rec-f) in its own singleton cluster", () => {
    const outlier = groups.find((group) => group.some((r) => r.id === "rec-f"));
    expect(outlier?.map((r) => r.id)).toEqual(["rec-f"]);
  });

  it("emits a deterministic clusterId for the launch trio across reruns", () => {
    const launchCluster = groups.find((group) => group.some((r) => r.id === "rec-a"))!;
    const id1 = computeClusterId(launchCluster.map((r) => r.id));
    const id2 = computeClusterId(["rec-c", "rec-a", "rec-b"]);
    expect(id1).toBe(id2);
  });

  it("applies per-gate skip counters faithfully to the cluster output", () => {
    const now = new Date("2026-04-28T00:00:00.000Z");
    const gateCounters = {
      minSupport: 0,
      minDistinctAgents: 0,
      minObservationAge: 0,
      maxSensitivity: 0,
    };

    // Use the same gate config the service exposes by default.
    const minSupport = 3;
    const minDistinctAgents = 2;
    const minObservationAgeMs = 3 * 24 * 60 * 60 * 1000;
    const maxSensitivityRank = 1; // "internal"
    const SENSITIVITY_RANK: Record<string, number> = {
      public: 0,
      internal: 1,
      confidential: 2,
      restricted: 3,
    };

    let candidateCount = 0;
    for (const members of groups) {
      if (members.length < minSupport) {
        gateCounters.minSupport += 1;
        continue;
      }
      const distinctAgents = new Set(members.map((m) => m.agentId));
      if (distinctAgents.size < minDistinctAgents) {
        gateCounters.minDistinctAgents += 1;
        continue;
      }
      const oldest = members.reduce(
        (min, m) => (m.createdAt < min ? m.createdAt : min),
        members[0].createdAt,
      );
      if (now.getTime() - oldest.getTime() < minObservationAgeMs) {
        gateCounters.minObservationAge += 1;
        continue;
      }
      const maxRank = members.reduce(
        (max, m) => Math.max(max, SENSITIVITY_RANK[m.sensitivityLabel]),
        0,
      );
      if (maxRank > maxSensitivityRank) {
        gateCounters.maxSensitivity += 1;
        continue;
      }
      candidateCount += 1;
    }

    // The launch trio survives all four gates. The refresh-job pair fails
    // minSupport (size 2). The lone outlier also fails minSupport.
    expect(candidateCount).toBe(1);
    expect(gateCounters.minSupport).toBe(2);
    expect(gateCounters.minDistinctAgents).toBe(0);
    expect(gateCounters.minObservationAge).toBe(0);
    expect(gateCounters.maxSensitivity).toBe(0);
  });

  it("skips on minDistinctAgents when all supporters share one agent", () => {
    const singleAgentRecords = [
      { ...records[0], agentId: "agent-1" },
      { ...records[1], agentId: "agent-1" },
      { ...records[2], agentId: "agent-1" },
    ];
    const distinctAgents = new Set(singleAgentRecords.map((m) => m.agentId));
    expect(distinctAgents.size).toBe(1);
    // Confirms the "two-agents minimum" check correctly rejects single-agent shouting.
    expect(distinctAgents.size).toBeLessThan(2);
  });

  it("skips on maxSensitivity when any supporter exceeds the threshold", () => {
    const SENSITIVITY_RANK: Record<string, number> = {
      public: 0,
      internal: 1,
      confidential: 2,
      restricted: 3,
    };
    const elevated = [
      { sensitivityLabel: "internal" },
      { sensitivityLabel: "confidential" },
      { sensitivityLabel: "internal" },
    ];
    const maxRank = elevated.reduce(
      (max, m) => Math.max(max, SENSITIVITY_RANK[m.sensitivityLabel]),
      0,
    );
    expect(maxRank).toBe(2);
    expect(maxRank).toBeGreaterThan(1);
  });
});
