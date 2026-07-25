import assert from "node:assert/strict";
import test from "node:test";

import {
  lookupRoutingRecord,
  ROUTING_RECORD_LOOKUP_LIMIT,
  extractStatusCode,
} from "./check-routing-rationale.mjs";

// A stub apiGet that records every query string it receives and returns a
// canned response per query, keyed by exact match.
function makeStubApiGet(responses) {
  const calls = [];
  async function apiGet(path) {
    calls.push(path);
    if (Object.prototype.hasOwnProperty.call(responses, path)) return responses[path];
    throw new Error(`unexpected apiGet call: ${path}`);
  }
  return { apiGet, calls };
}

test("org-scoped hit: found true, scope org, no project query issued", async () => {
  const { apiGet, calls } = makeStubApiGet({
    [`/api/companies/c1/memory/records?titlePrefix=routing/AUR-100&limit=${ROUTING_RECORD_LOOKUP_LIMIT}`]:
      [{ id: "rec1", title: "routing/AUR-100" }],
  });

  const result = await lookupRoutingRecord({
    companyId: "c1",
    targetId: "AUR-100",
    projectId: "p1",
    apiGet,
  });

  assert.deepEqual(result, { found: true, scope: "org" });
  assert.deepEqual(calls, [
    `/api/companies/c1/memory/records?titlePrefix=routing/AUR-100&limit=${ROUTING_RECORD_LOOKUP_LIMIT}`,
  ]);
});

test("project-scoped-only hit: org query returns [], project query hits", async () => {
  const { apiGet, calls } = makeStubApiGet({
    [`/api/companies/c1/memory/records?titlePrefix=routing/AUR-200&limit=${ROUTING_RECORD_LOOKUP_LIMIT}`]: [],
    [`/api/companies/c1/memory/records?titlePrefix=routing/AUR-200&limit=${ROUTING_RECORD_LOOKUP_LIMIT}&projectId=p1`]:
      [{ id: "rec2", title: "routing/AUR-200" }],
  });

  const result = await lookupRoutingRecord({
    companyId: "c1",
    targetId: "AUR-200",
    projectId: "p1",
    apiGet,
  });

  assert.deepEqual(result, { found: true, scope: "project" });
  assert.deepEqual(calls, [
    `/api/companies/c1/memory/records?titlePrefix=routing/AUR-200&limit=${ROUTING_RECORD_LOOKUP_LIMIT}`,
    `/api/companies/c1/memory/records?titlePrefix=routing/AUR-200&limit=${ROUTING_RECORD_LOOKUP_LIMIT}&projectId=p1`,
  ]);
});

test("genuinely missing in both scopes: found false, scope null", async () => {
  const { apiGet, calls } = makeStubApiGet({
    [`/api/companies/c1/memory/records?titlePrefix=routing/AUR-300&limit=${ROUTING_RECORD_LOOKUP_LIMIT}`]: [],
    [`/api/companies/c1/memory/records?titlePrefix=routing/AUR-300&limit=${ROUTING_RECORD_LOOKUP_LIMIT}&projectId=p1`]: [],
  });

  const result = await lookupRoutingRecord({
    companyId: "c1",
    targetId: "AUR-300",
    projectId: "p1",
    apiGet,
  });

  assert.deepEqual(result, { found: false, scope: null });
  assert.deepEqual(calls, [
    `/api/companies/c1/memory/records?titlePrefix=routing/AUR-300&limit=${ROUTING_RECORD_LOOKUP_LIMIT}`,
    `/api/companies/c1/memory/records?titlePrefix=routing/AUR-300&limit=${ROUTING_RECORD_LOOKUP_LIMIT}&projectId=p1`,
  ]);
});

test("no projectId: exactly one org query, never fabricates projectId=undefined", async () => {
  const { apiGet, calls } = makeStubApiGet({
    [`/api/companies/c1/memory/records?titlePrefix=routing/AUR-400&limit=${ROUTING_RECORD_LOOKUP_LIMIT}`]: [],
  });

  const result = await lookupRoutingRecord({
    companyId: "c1",
    targetId: "AUR-400",
    projectId: undefined,
    apiGet,
  });

  assert.deepEqual(result, { found: false, scope: null });
  assert.deepEqual(calls, [
    `/api/companies/c1/memory/records?titlePrefix=routing/AUR-400&limit=${ROUTING_RECORD_LOOKUP_LIMIT}`,
  ]);
  assert.ok(calls.every((c) => !c.includes("projectId=undefined")));
});

test("tolerant response parsing: {records:[...]} wrapper shape works for both scopes", async () => {
  const { apiGet } = makeStubApiGet({
    [`/api/companies/c1/memory/records?titlePrefix=routing/AUR-500&limit=${ROUTING_RECORD_LOOKUP_LIMIT}`]:
      { records: [] },
    [`/api/companies/c1/memory/records?titlePrefix=routing/AUR-500&limit=${ROUTING_RECORD_LOOKUP_LIMIT}&projectId=p1`]:
      { records: [{ id: "rec3", title: "routing/AUR-500" }] },
  });

  const result = await lookupRoutingRecord({
    companyId: "c1",
    targetId: "AUR-500",
    projectId: "p1",
    apiGet,
  });

  assert.deepEqual(result, { found: true, scope: "project" });
});

// ── AUR-3855: titlePrefix collision must not produce a false positive ──────

test("collision (org scope): only routing/AUR-2756 exists for prefix AUR-27 -> found false", async () => {
  const { apiGet } = makeStubApiGet({
    [`/api/companies/c1/memory/records?titlePrefix=routing/AUR-27&limit=${ROUTING_RECORD_LOOKUP_LIMIT}`]: [
      { id: "r1", title: "routing/AUR-2756" },
      { id: "r2", title: "routing/AUR-2749" },
      { id: "r3", title: "routing/AUR-2732" },
    ],
    // no projectId passed in this test — org-only lookup
  });

  const result = await lookupRoutingRecord({
    companyId: "c1",
    targetId: "AUR-27",
    projectId: undefined,
    apiGet,
  });

  assert.deepEqual(result, { found: false, scope: null });
});

test("collision (org scope): exact hit still found true even with colliding neighbors present", async () => {
  const { apiGet } = makeStubApiGet({
    [`/api/companies/c1/memory/records?titlePrefix=routing/AUR-159&limit=${ROUTING_RECORD_LOOKUP_LIMIT}`]: [
      { id: "r1", title: "routing/AUR-1595" },
      { id: "r2", title: "routing/AUR-1590" },
      { id: "r3", title: "routing/AUR-159" },
    ],
  });

  const result = await lookupRoutingRecord({
    companyId: "c1",
    targetId: "AUR-159",
    projectId: undefined,
    apiGet,
  });

  assert.deepEqual(result, { found: true, scope: "org" });
});

test("collision (project scope): real record only present project-scoped, alongside collisions", async () => {
  const { apiGet } = makeStubApiGet({
    [`/api/companies/c1/memory/records?titlePrefix=routing/AUR-802&limit=${ROUTING_RECORD_LOOKUP_LIMIT}`]: [
      { id: "r1", title: "routing/AUR-8021" },
      { id: "r2", title: "routing/AUR-8025" },
    ],
    [`/api/companies/c1/memory/records?titlePrefix=routing/AUR-802&limit=${ROUTING_RECORD_LOOKUP_LIMIT}&projectId=p1`]: [
      { id: "r3", title: "routing/AUR-8029" },
      { id: "r4", title: "routing/AUR-802" },
    ],
  });

  const result = await lookupRoutingRecord({
    companyId: "c1",
    targetId: "AUR-802",
    projectId: "p1",
    apiGet,
  });

  assert.deepEqual(result, { found: true, scope: "project" });
});

test("collision (project scope): only collisions in both scopes -> found false, not a false positive", async () => {
  const { apiGet } = makeStubApiGet({
    [`/api/companies/c1/memory/records?titlePrefix=routing/AUR-802&limit=${ROUTING_RECORD_LOOKUP_LIMIT}`]: [
      { id: "r1", title: "routing/AUR-8021" },
    ],
    [`/api/companies/c1/memory/records?titlePrefix=routing/AUR-802&limit=${ROUTING_RECORD_LOOKUP_LIMIT}&projectId=p1`]: [
      { id: "r2", title: "routing/AUR-8029" },
      { id: "r3", title: "routing/AUR-8025" },
    ],
  });

  const result = await lookupRoutingRecord({
    companyId: "c1",
    targetId: "AUR-802",
    projectId: "p1",
    apiGet,
  });

  assert.deepEqual(result, { found: false, scope: null });
});

// ── AUR-3855: per-mutation status-code extraction ───────────────────────────

test("extractStatusCode: pulls the numeric status out of an apiPatch/apiPost error message", () => {
  assert.equal(
    extractStatusCode("PATCH /api/issues/abc → 409 Conflict"),
    "409",
  );
  assert.equal(
    extractStatusCode("POST /api/companies/c1/issues → 500 Internal Server Error"),
    "500",
  );
});

test("extractStatusCode: falls back to 'unknown' for messages without a status", () => {
  assert.equal(extractStatusCode("fetch failed: ECONNRESET"), "unknown");
  assert.equal(extractStatusCode(undefined), "unknown");
});
