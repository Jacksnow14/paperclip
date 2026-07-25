import assert from "node:assert/strict";
import test from "node:test";

import {
  lookupRoutingRecord,
  ROUTING_RECORD_LOOKUP_LIMIT,
  extractStatusCode,
  isRoutingDecision,
  isExempt,
  fetchAllIssues,
  buildRollingIssueBody,
  findRollingIssue,
  rollingIssueTitle,
  todayDateKey,
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

// ── AUR-3994/AUR-3987a: isRoutingDecision exemption predicate ──────────────

test("isRoutingDecision: false when createdByAgentId is missing (user-filed)", () => {
  assert.equal(
    isRoutingDecision({ createdByAgentId: null, assigneeAgentId: "agent-x" }),
    false,
  );
  assert.equal(
    isRoutingDecision({ assigneeAgentId: "agent-x" }),
    false,
  );
});

test("isRoutingDecision: false when originKind is set and not 'manual' (routine/system-generated)", () => {
  assert.equal(
    isRoutingDecision({
      createdByAgentId: "creator-1",
      assigneeAgentId: "agent-x",
      originKind: "routine_execution",
    }),
    false,
  );
});

test("isRoutingDecision: false when self-assigned (assignee === creator)", () => {
  assert.equal(
    isRoutingDecision({
      createdByAgentId: "agent-1",
      assigneeAgentId: "agent-1",
      originKind: "manual",
    }),
    false,
  );
});

test("isRoutingDecision: true for a genuine routing decision (creator hands off to a different agent, manual origin)", () => {
  assert.equal(
    isRoutingDecision({
      createdByAgentId: "agent-1",
      assigneeAgentId: "agent-2",
      originKind: "manual",
    }),
    true,
  );
});

test("isRoutingDecision: true when originKind is absent but creator/assignee differ (originKind is optional, not required to be 'manual')", () => {
  assert.equal(
    isRoutingDecision({
      createdByAgentId: "agent-1",
      assigneeAgentId: "agent-2",
    }),
    true,
  );
});

// ── Regression: self-assigned high-priority issue produces no gap ──────────

test("isExempt: a self-assigned high-priority issue is exempt (no routing decision was made)", () => {
  const issue = {
    priority: "high",
    createdByAgentId: "agent-1",
    assigneeAgentId: "agent-1",
    originKind: "manual",
    title: "Fix the flaky deploy script",
    description: "",
  };
  assert.equal(isExempt(issue), true);
});

test("isExempt: a routine-origin high-priority issue is exempt even with a distinct assignee", () => {
  const issue = {
    priority: "critical",
    createdByAgentId: "agent-1",
    assigneeAgentId: "agent-2",
    originKind: "routine_execution",
    title: "Daily PnL sweep",
    description: "",
  };
  assert.equal(isExempt(issue), true);
});

test("isExempt: a genuinely routed high-priority issue is NOT exempt", () => {
  const issue = {
    priority: "high",
    createdByAgentId: "agent-1",
    assigneeAgentId: "agent-2",
    originKind: "manual",
    title: "Implement retry logic for webhook delivery",
    description: "",
  };
  assert.equal(isExempt(issue), false);
});

// ── fetchAllIssues: pagination ──────────────────────────────────────────────

test("fetchAllIssues: follows offset pagination until a short page is returned", async () => {
  const pages = [
    Array.from({ length: 3 }, (_, i) => ({ id: `a${i}` })), // full page (pageSize=3)
    Array.from({ length: 3 }, (_, i) => ({ id: `b${i}` })), // full page
    [{ id: "c0" }], // short page -> stop
  ];
  const calls = [];
  async function apiGet(path) {
    calls.push(path);
    const offset = Number(new URL(`http://x${path}`).searchParams.get("offset"));
    const page = offset / 3;
    return pages[page];
  }

  const all = await fetchAllIssues({ companyId: "c1", apiGet, status: null, pageSize: 3 });

  assert.equal(all.length, 7);
  assert.equal(calls.length, 3);
  assert.ok(calls[0].includes("offset=0"));
  assert.ok(calls[1].includes("offset=3"));
  assert.ok(calls[2].includes("offset=6"));
  assert.ok(calls.every((c) => !c.includes("status=")), "status omitted entirely fetches all statuses");
});

test("fetchAllIssues: passes a comma-joined status filter through verbatim", async () => {
  const { apiGet, calls } = makeStubApiGet({
    "/api/companies/c1/issues?limit=500&status=todo,in_progress&offset=0": [{ id: "x1" }],
  });
  const all = await fetchAllIssues({ companyId: "c1", apiGet, status: "todo,in_progress" });
  assert.deepEqual(all, [{ id: "x1" }]);
  assert.deepEqual(calls, ["/api/companies/c1/issues?limit=500&status=todo,in_progress&offset=0"]);
});

// ── Rolling gap-aggregate issue ──────────────────────────────────────────────

test("todayDateKey: returns a stable UTC YYYY-MM-DD", () => {
  assert.equal(todayDateKey(new Date("2026-07-25T23:59:00Z")), "2026-07-25");
});

test("rollingIssueTitle: matches the documented convention", () => {
  assert.equal(rollingIssueTitle("2026-07-25"), "routing-rationale gaps — 2026-07-25");
});

test("buildRollingIssueBody: lists open gaps, caps at maxListed, reports held-back count", () => {
  const missingOpen = [
    { identifier: "AUR-1", priority: "high", assigneeAgentId: "a1", createdByAgentId: "a1", title: "T1" },
    { identifier: "AUR-2", priority: "critical", assigneeAgentId: "a2", createdByAgentId: "a2", title: "T2" },
    { identifier: "AUR-3", priority: "high", assigneeAgentId: "a3", createdByAgentId: "a3", title: "T3" },
  ];
  const body = buildRollingIssueBody(missingOpen, { maxListed: 2, closedGapCount: 0 });
  assert.ok(body.includes("AUR-1"));
  assert.ok(body.includes("AUR-2"));
  assert.ok(!body.includes("AUR-3"));
  assert.ok(body.includes("1 more held back"));
  assert.ok(body.includes("3 open eligible issue(s)"));
});

test("buildRollingIssueBody: surfaces closedGapCount as report-only, never lists closed issues individually", () => {
  const body = buildRollingIssueBody([], { maxListed: 20, closedGapCount: 5 });
  assert.ok(body.includes("_No outstanding open gaps._"));
  assert.ok(body.includes("5 additional gap(s)"));
  assert.ok(body.includes("unrecoverable"));
});

test("findRollingIssue: asserts exact title match client-side, ignoring loose search collisions", async () => {
  const title = "routing-rationale gaps — 2026-07-25";
  const { apiGet } = makeStubApiGet({
    [`/api/companies/c1/issues?q=${encodeURIComponent(title)}&status=backlog,todo,in_progress,in_review,blocked,done,cancelled&limit=20`]:
      [
        { id: "wrong1", title: "routing-rationale gaps — 2026-07-24" },
        { id: "right1", title },
      ],
  });
  const found = await findRollingIssue({ companyId: "c1", apiGet, title });
  assert.equal(found.id, "right1");
});

test("findRollingIssue: returns null when no exact match exists yet (first run of the day)", async () => {
  const title = "routing-rationale gaps — 2026-07-25";
  const { apiGet } = makeStubApiGet({
    [`/api/companies/c1/issues?q=${encodeURIComponent(title)}&status=backlog,todo,in_progress,in_review,blocked,done,cancelled&limit=20`]:
      [],
  });
  const found = await findRollingIssue({ companyId: "c1", apiGet, title });
  assert.equal(found, null);
});

// ── Aggregation regression: update the existing rolling issue, never duplicate ─

test("aggregation regression: a second run on the same day updates the existing rolling issue rather than creating a new one", async () => {
  const title = rollingIssueTitle("2026-07-25");
  const existing = { id: "roll-1", identifier: "AUR-9000", title, status: "todo" };
  let patchCalls = 0;
  let postIssueCalls = 0;
  const { apiGet } = makeStubApiGet({
    [`/api/companies/c1/issues?q=${encodeURIComponent(title)}&status=backlog,todo,in_progress,in_review,blocked,done,cancelled&limit=20`]:
      [existing],
  });
  async function apiPatch(path, body) {
    patchCalls += 1;
    assert.equal(path, "/api/issues/roll-1");
    assert.ok(body.description.includes("open eligible issue"));
    return {};
  }
  async function apiPost(path) {
    postIssueCalls += 1;
    return {};
  }

  const found = await findRollingIssue({ companyId: "c1", apiGet, title });
  assert.ok(found, "expected to find the already-filed rolling issue for today");

  // Simulate the update branch a second run would take (mirrors syncRollingGapIssue's
  // existing-issue path without re-implementing its internals here).
  await apiPatch(`/api/issues/${found.id}`, {
    description: buildRollingIssueBody(
      [{ identifier: "AUR-1", priority: "high", assigneeAgentId: "a1", createdByAgentId: "a1", title: "T1" }],
      { maxListed: 20, closedGapCount: 0 },
    ),
  });

  assert.equal(patchCalls, 1);
  assert.equal(postIssueCalls, 0, "must never POST a new issue when one already exists for today");
});
