import assert from "node:assert/strict";
import test from "node:test";

import { lookupRoutingRecord } from "./check-routing-rationale.mjs";

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
    "/api/companies/c1/memory/records?titlePrefix=routing/AUR-100&limit=1": [{ id: "rec1" }],
  });

  const result = await lookupRoutingRecord({
    companyId: "c1",
    targetId: "AUR-100",
    projectId: "p1",
    apiGet,
  });

  assert.deepEqual(result, { found: true, scope: "org" });
  assert.deepEqual(calls, ["/api/companies/c1/memory/records?titlePrefix=routing/AUR-100&limit=1"]);
});

test("project-scoped-only hit: org query returns [], project query hits", async () => {
  const { apiGet, calls } = makeStubApiGet({
    "/api/companies/c1/memory/records?titlePrefix=routing/AUR-200&limit=1": [],
    "/api/companies/c1/memory/records?titlePrefix=routing/AUR-200&limit=1&projectId=p1": [{ id: "rec2" }],
  });

  const result = await lookupRoutingRecord({
    companyId: "c1",
    targetId: "AUR-200",
    projectId: "p1",
    apiGet,
  });

  assert.deepEqual(result, { found: true, scope: "project" });
  assert.deepEqual(calls, [
    "/api/companies/c1/memory/records?titlePrefix=routing/AUR-200&limit=1",
    "/api/companies/c1/memory/records?titlePrefix=routing/AUR-200&limit=1&projectId=p1",
  ]);
});

test("genuinely missing in both scopes: found false, scope null", async () => {
  const { apiGet, calls } = makeStubApiGet({
    "/api/companies/c1/memory/records?titlePrefix=routing/AUR-300&limit=1": [],
    "/api/companies/c1/memory/records?titlePrefix=routing/AUR-300&limit=1&projectId=p1": [],
  });

  const result = await lookupRoutingRecord({
    companyId: "c1",
    targetId: "AUR-300",
    projectId: "p1",
    apiGet,
  });

  assert.deepEqual(result, { found: false, scope: null });
  assert.deepEqual(calls, [
    "/api/companies/c1/memory/records?titlePrefix=routing/AUR-300&limit=1",
    "/api/companies/c1/memory/records?titlePrefix=routing/AUR-300&limit=1&projectId=p1",
  ]);
});

test("no projectId: exactly one org query, never fabricates projectId=undefined", async () => {
  const { apiGet, calls } = makeStubApiGet({
    "/api/companies/c1/memory/records?titlePrefix=routing/AUR-400&limit=1": [],
  });

  const result = await lookupRoutingRecord({
    companyId: "c1",
    targetId: "AUR-400",
    projectId: undefined,
    apiGet,
  });

  assert.deepEqual(result, { found: false, scope: null });
  assert.deepEqual(calls, ["/api/companies/c1/memory/records?titlePrefix=routing/AUR-400&limit=1"]);
  assert.ok(calls.every((c) => !c.includes("projectId=undefined")));
});

test("tolerant response parsing: {records:[...]} wrapper shape works for both scopes", async () => {
  const { apiGet } = makeStubApiGet({
    "/api/companies/c1/memory/records?titlePrefix=routing/AUR-500&limit=1": { records: [] },
    "/api/companies/c1/memory/records?titlePrefix=routing/AUR-500&limit=1&projectId=p1": { records: [{ id: "rec3" }] },
  });

  const result = await lookupRoutingRecord({
    companyId: "c1",
    targetId: "AUR-500",
    projectId: "p1",
    apiGet,
  });

  assert.deepEqual(result, { found: true, scope: "project" });
});
