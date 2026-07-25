import assert from "node:assert/strict";
import test from "node:test";

import {
  ROUTER_READ_CATEGORY_PREFIXES,
  RECORD_LIST_LIMIT,
  fetchProjectScopedRouterReadRecords,
  alreadyBackfilled,
  buildBackfillPayload,
} from "./backfill-router-read-scope.mjs";

function makeStubApiGet(responses) {
  const calls = [];
  async function apiGet(path) {
    calls.push(path);
    if (Object.prototype.hasOwnProperty.call(responses, path)) return responses[path];
    throw new Error(`unexpected apiGet call: ${path}`);
  }
  return { apiGet, calls };
}

test("ROUTER_READ_CATEGORY_PREFIXES covers exactly the three router-read classes", () => {
  assert.deepEqual(ROUTER_READ_CATEGORY_PREFIXES, {
    routing_rationale: "routing/",
    performance_scorecard: "performance/",
    scorecard_adjusted: "scorecard-adjusted/",
  });
});

test("fetchProjectScopedRouterReadRecords: filters titlePrefix hits to the requested category", async () => {
  const { apiGet } = makeStubApiGet({
    [`/api/companies/c1/memory/records?titlePrefix=performance%2F&projectId=p1&limit=${RECORD_LIST_LIMIT}&offset=0`]: [
      { id: "r1", title: "performance/agent-a/feature/2026-07-20", metadata: { category: "performance_scorecard" } },
      { id: "r2", title: "performance/agent-a/other-thing", metadata: { category: "some_other_category" } },
    ],
  });

  const hits = await fetchProjectScopedRouterReadRecords({
    companyId: "c1",
    projectId: "p1",
    category: "performance_scorecard",
    prefix: "performance/",
    apiGet,
  });

  assert.deepEqual(hits.map((h) => h.id), ["r1"]);
});

test("fetchProjectScopedRouterReadRecords: paginates when a page is exactly full", async () => {
  const fullPage = Array.from({ length: RECORD_LIST_LIMIT }, (_, i) => ({
    id: `r${i}`,
    title: `routing/AUR-${i}`,
    metadata: { category: "routing_rationale" },
  }));
  const { apiGet, calls } = makeStubApiGet({
    [`/api/companies/c1/memory/records?titlePrefix=routing%2F&projectId=p1&limit=${RECORD_LIST_LIMIT}&offset=0`]: fullPage,
    [`/api/companies/c1/memory/records?titlePrefix=routing%2F&projectId=p1&limit=${RECORD_LIST_LIMIT}&offset=${RECORD_LIST_LIMIT}`]: [
      { id: "rLast", title: "routing/AUR-last", metadata: { category: "routing_rationale" } },
    ],
  });

  const hits = await fetchProjectScopedRouterReadRecords({
    companyId: "c1",
    projectId: "p1",
    category: "routing_rationale",
    prefix: "routing/",
    apiGet,
  });

  assert.equal(hits.length, RECORD_LIST_LIMIT + 1);
  assert.equal(calls.length, 2);
});

test("alreadyBackfilled: true only when an org record references this exact original id", async () => {
  const original = { id: "orig-1", title: "performance/agent-a/feature/2026-07-20" };
  const { apiGet } = makeStubApiGet({
    [`/api/companies/c1/memory/records?titlePrefix=${encodeURIComponent(original.title)}&limit=50`]: [
      { id: "org-copy", title: original.title, metadata: { backfilled_from_record_id: "orig-1" } },
    ],
  });

  const result = await alreadyBackfilled({ companyId: "c1", original, apiGet });
  assert.equal(result, true);
});

test("alreadyBackfilled: false when a same-titled org record exists but references a DIFFERENT original", async () => {
  // Title collision: don't let one original's backfill mask another's absence.
  const original = { id: "orig-2", title: "routing/AUR-100" };
  const { apiGet } = makeStubApiGet({
    [`/api/companies/c1/memory/records?titlePrefix=${encodeURIComponent(original.title)}&limit=50`]: [
      { id: "org-copy", title: original.title, metadata: { backfilled_from_record_id: "some-other-original" } },
    ],
  });

  const result = await alreadyBackfilled({ companyId: "c1", original, apiGet });
  assert.equal(result, false);
});

test("alreadyBackfilled: false (no query) when the record has no title", async () => {
  const { apiGet, calls } = makeStubApiGet({});
  const result = await alreadyBackfilled({ companyId: "c1", original: { id: "orig-3", title: null }, apiGet });
  assert.equal(result, false);
  assert.deepEqual(calls, []);
});

test("buildBackfillPayload: org-wide payload with no scope/scopeType, project id moved to metadata.project_id", () => {
  const original = {
    id: "orig-4",
    title: "scorecard-adjusted/agent-a/feature/2026-07-20",
    content: "score_adjusted computed",
    summary: null,
    metadata: { category: "scorecard_adjusted", score_adjusted: 1.5 },
    source: { kind: "issue", issueId: "aaaa" },
    owner: { type: "agent", id: "agent-a" },
    sensitivityLabel: "internal",
    citation: null,
  };

  const payload = buildBackfillPayload(original, "proj-1");

  assert.equal(payload.title, original.title);
  assert.equal(payload.content, original.content);
  assert.equal(payload.metadata.category, "scorecard_adjusted");
  assert.equal(payload.metadata.project_id, "proj-1");
  assert.equal(payload.metadata.backfilled_from_record_id, "orig-4");
  assert.equal(payload.scope, undefined);
  assert.equal(payload.scopeType, undefined);
  assert.deepEqual(payload.source, { kind: "issue", issueId: "aaaa" });
  assert.deepEqual(payload.owner, { type: "agent", id: "agent-a" });
});

test("buildBackfillPayload: falls back to manual_note source when original has none", () => {
  const original = { id: "orig-5", title: "routing/AUR-1", content: "c", metadata: {} };
  const payload = buildBackfillPayload(original, "proj-1");
  assert.deepEqual(payload.source, { kind: "manual_note" });
});

test("buildBackfillPayload: throws for a titleless record instead of silently mis-keying it", () => {
  assert.throws(() => buildBackfillPayload({ id: "orig-6", title: null, content: "c", metadata: {} }, "proj-1"));
});
