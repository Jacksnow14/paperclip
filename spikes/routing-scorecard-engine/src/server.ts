/**
 * Thin HTTP layer implementing the OpenAPI spec (../openapi.yaml) against a
 * pluggable ScorecardStore. Built on node:http only — no framework
 * dependency — so `npm install` has nothing beyond typescript to fetch.
 */

import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { computeScoreAdjusted } from "./score";
import { evaluateBucket, StreakRecord } from "./streak";
import { aggregateRoi, ScorecardLike } from "./roi";
import { recommendCandidate, Candidate, CandidateRecord } from "./routing";
import { InMemoryScorecardStore, ScorecardRecord, ScorecardStore, newScorecardId } from "./store";
import { median } from "./util";

type Priority = "urgent" | "high" | "medium" | "low";

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function toStreakRecord(r: ScorecardRecord): StreakRecord {
  return { qualitySignal: r.qualitySignal, reworkRequired: r.reworkRequired, createdAt: r.createdAt };
}

function toScorecardLike(r: ScorecardRecord): ScorecardLike {
  return {
    valueSignal: r.valueSignal,
    qualitySignal: r.qualitySignal,
    tokenCost: r.tokenCost,
    reworkRequired: r.reworkRequired,
    outcome: r.outcome,
    priority: r.priority ?? null,
    excludeFromAggregates: r.excludeFromAggregates,
  };
}

function streakJson(evaluation: ReturnType<typeof evaluateBucket>) {
  return {
    skip: evaluation.skip ?? null,
    triggers: evaluation.triggers.map((t) => ({
      detector: t.detector,
      severity: t.severity,
      description: t.description,
    })),
    severity: evaluation.severity,
    most_recent_age_days: evaluation.mostRecentAgeDays,
  };
}

export function createServer(store: ScorecardStore = new InMemoryScorecardStore()) {
  return createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (req.method === "POST" && path === "/v1/score") {
        const body = await readJsonBody(req);
        const result = computeScoreAdjusted({
          taskType: body.task_type,
          tokenCost: Number(body.token_cost),
          qualitySignal: Number(body.quality_signal),
          valueSignal: Number(body.value_signal),
        });
        sendJson(res, 200, { score_adjusted: result.scoreAdjusted, reason: result.reason ?? null });
        return;
      }

      if (req.method === "POST" && path === "/v1/scorecards") {
        const body = await readJsonBody(req);
        if (!body.agent_id || !body.task_type) {
          sendJson(res, 400, { error: "agent_id and task_type are required" });
          return;
        }
        const scored = computeScoreAdjusted({
          tokenCost: Number(body.token_cost),
          qualitySignal: Number(body.quality_signal),
          valueSignal: Number(body.value_signal),
        });
        const record: ScorecardRecord = {
          id: newScorecardId(),
          agentId: String(body.agent_id),
          taskType: String(body.task_type),
          tokenCost: Number(body.token_cost) || 0,
          qualitySignal: Number(body.quality_signal),
          valueSignal: Number(body.value_signal),
          reworkRequired: body.rework_required === true,
          outcome: body.outcome ?? "success",
          priority: (body.priority as Priority) ?? null,
          scoreAdjusted: scored.scoreAdjusted,
          excludeFromAggregates: scored.scoreAdjusted === null,
          createdAt: body.timestamp ?? new Date().toISOString(),
        };
        store.append(record);

        const bucket = store.query({ agentId: record.agentId, taskType: record.taskType });
        const streak = evaluateBucket(bucket.map(toStreakRecord));

        sendJson(res, 201, {
          id: record.id,
          score_adjusted: record.scoreAdjusted,
          reason: scored.reason ?? null,
          exclude_from_aggregates: record.excludeFromAggregates,
          streak: streakJson(streak),
        });
        return;
      }

      if (req.method === "GET" && path.startsWith("/v1/scorecards/")) {
        const parts = path.split("/").filter(Boolean); // ["v1","scorecards",agent,type,"summary"]
        if (parts.length === 5 && parts[4] === "summary") {
          const agentId = decodeURIComponent(parts[2]);
          const taskType = decodeURIComponent(parts[3]);
          const records = store.query({ agentId, taskType });
          const scoreValues = records
            .map((r) => r.scoreAdjusted)
            .filter((v): v is number => typeof v === "number");
          const roi = aggregateRoi(records.map(toScorecardLike));
          const streak = evaluateBucket(records.map(toStreakRecord));

          sendJson(res, 200, {
            agent_id: agentId,
            task_type: taskType,
            sample_count: records.length,
            median_score_adjusted: scoreValues.length ? median(scoreValues) : null,
            roi: {
              lifetime_value: roi.lifetimeValue,
              lifetime_tokens: roi.lifetimeTokens,
              roi_ratio: roi.roiRatio,
              sample_count: roi.sampleCount,
              excluded_count: roi.excludedCount,
            },
            streak: streakJson(streak),
          });
          return;
        }
      }

      if (req.method === "POST" && path === "/v1/route") {
        const body = await readJsonBody(req);
        const rawCandidates: any[] = Array.isArray(body.candidates) ? body.candidates : [];
        const candidates: Candidate[] = rawCandidates.map((c) => {
          const records: CandidateRecord[] = Array.isArray(c.records)
            ? c.records.map((r: any) => ({
                scoreAdjusted: r.score_adjusted ?? null,
                qualitySignal: r.quality_signal ?? null,
                reworkRequired: r.rework_required === true,
                tokenCost: r.token_cost,
                excludeFromAggregates: r.exclude_from_aggregates === true,
                metricsLost: r.metrics_lost === true,
              }))
            : store
                .query({ agentId: c.agent_id, taskType: c.task_type })
                .map((r) => ({
                  scoreAdjusted: r.scoreAdjusted,
                  qualitySignal: r.qualitySignal,
                  reworkRequired: r.reworkRequired,
                  tokenCost: r.tokenCost,
                  excludeFromAggregates: r.excludeFromAggregates,
                }));
          return { id: c.id, records };
        });

        const recommendation = recommendCandidate(candidates);
        sendJson(res, 200, {
          chosen_candidate_id: recommendation.chosenCandidateId,
          data_available: recommendation.dataAvailable,
          rationale: recommendation.rationale,
          candidates: recommendation.candidates.map((c) => ({
            id: c.id,
            avg_score_adjusted: c.avgScoreAdjusted,
            avg_quality_signal: c.avgQualitySignal,
            usable_score_adjusted_samples: c.usableScoreAdjustedSamples,
            sample_count: c.sampleCount,
            rework_count: c.reworkCount,
            fell_back_to_quality: c.fellBackToQuality,
          })),
        });
        return;
      }

      sendJson(res, 404, { error: "not_found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal_error";
      const status = message === "invalid_json" ? 400 : 500;
      sendJson(res, status, { error: message });
    }
  });
}

export function startServer(port = Number(process.env.PORT) || 8787, store?: ScorecardStore) {
  const server = createServer(store);
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`routing-scorecard-engine listening on http://localhost:${port}`);
  });
  return server;
}

if (require.main === module) {
  startServer();
}
