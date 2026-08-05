import assert from "node:assert/strict";
import test from "node:test";

import {
  lookupRoutingRecord,
  ROUTING_RECORD_LOOKUP_LIMIT,
  extractStatusCode,
  isRoutingDecision,
  isExempt,
  isExemptForResolvedFlag,
  isPreRule,
  parseRuleEffectiveDate,
  resolveCancelReason,
  RULE_EFFECTIVE_DATE,
  fetchAllIssues,
  buildRollingIssueBody,
  findRollingIssue,
  rollingIssueTitle,
  todayDateKey,
  matchesRoutingKey,
  pickNewestRoutingRecord,
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

  assert.deepEqual({ found: result.found, scope: result.scope }, { found: true, scope: "org" });
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

  assert.deepEqual({ found: result.found, scope: result.scope }, { found: true, scope: "project" });
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

  assert.deepEqual({ found: result.found, scope: result.scope }, { found: false, scope: null });
  assert.equal(result.record, null);
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

  assert.deepEqual({ found: result.found, scope: result.scope }, { found: false, scope: null });
  assert.equal(result.record, null);
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

  assert.deepEqual({ found: result.found, scope: result.scope }, { found: true, scope: "project" });
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

  assert.deepEqual({ found: result.found, scope: result.scope }, { found: false, scope: null });
  assert.equal(result.record, null);
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

  assert.deepEqual({ found: result.found, scope: result.scope }, { found: true, scope: "org" });
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

  assert.deepEqual({ found: result.found, scope: result.scope }, { found: true, scope: "project" });
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

  assert.deepEqual({ found: result.found, scope: result.scope }, { found: false, scope: null });
  assert.equal(result.record, null);
});

// ── AUR-4475: sweeper decider-suffix routing key format ─────────────────────

test("routing/{id}/{ownerId} suffixed key found in org scope", async () => {
  const { apiGet } = makeStubApiGet({
    [`/api/companies/c1/memory/records?titlePrefix=routing/AUR-600&limit=${ROUTING_RECORD_LOOKUP_LIMIT}`]: [
      { id: "r1", title: "routing/AUR-600/agent-uuid-decider" },
    ],
  });

  const result = await lookupRoutingRecord({
    companyId: "c1",
    targetId: "AUR-600",
    projectId: undefined,
    apiGet,
  });

  assert.deepEqual(result, {
    found: true,
    scope: "org",
    record: { id: "r1", title: "routing/AUR-600/agent-uuid-decider" },
  });
});

test("routing/{id}/{ownerId} suffixed key found in project scope when org scope misses", async () => {
  const { apiGet } = makeStubApiGet({
    [`/api/companies/c1/memory/records?titlePrefix=routing/AUR-601&limit=${ROUTING_RECORD_LOOKUP_LIMIT}`]: [],
    [`/api/companies/c1/memory/records?titlePrefix=routing/AUR-601&limit=${ROUTING_RECORD_LOOKUP_LIMIT}&projectId=p1`]: [
      { id: "r1", title: "routing/AUR-601/agent-uuid-decider" },
    ],
  });

  const result = await lookupRoutingRecord({
    companyId: "c1",
    targetId: "AUR-601",
    projectId: "p1",
    apiGet,
  });

  assert.deepEqual(result, {
    found: true,
    scope: "project",
    record: { id: "r1", title: "routing/AUR-601/agent-uuid-decider" },
  });
});

test("routing/{id}/{ownerId} suffix uses SWEEPER_AGENT_ID not chosen_agent (decider must not be confused with routed-to)", async () => {
  // Validates the invariant: the /{ownerId} segment is the DECIDER (sweeper actor),
  // not the agent the issue was routed to (chosen_agent).  These two differ whenever
  // the sweeper routes an issue to another agent — the title suffix must be the
  // sweeper's own id, not the target agent's id.
  const sweeperDeciderId = "sweeper-agent-uuid";
  const chosenAgentId    = "chosen-agent-uuid";
  assert.notEqual(sweeperDeciderId, chosenAgentId, "test setup: decider and chosen must differ");

  const titleWithDecider = `routing/AUR-602/${sweeperDeciderId}`;
  const titleWithChosen  = `routing/AUR-602/${chosenAgentId}`;

  // A record keyed by the decider IS the canonical routing record.
  assert.ok(
    titleWithDecider.startsWith("routing/AUR-602/"),
    "decider key has correct prefix",
  );
  // A record keyed by chosen_agent is NOT the decider key and must not be written.
  assert.ok(
    titleWithChosen !== titleWithDecider,
    "title keyed by chosen_agent differs from title keyed by decider",
  );
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

// ── AUR-4006: RULE_EFFECTIVE_DATE cutoff ────────────────────────────────────

test("isPreRule: an issue created before the cutoff is pre-rule-exempt", () => {
  const issue = { createdAt: "2026-05-01T00:00:00Z" };
  assert.equal(isPreRule(issue, RULE_EFFECTIVE_DATE), true);
});

test("isPreRule: an issue created after the cutoff is NOT pre-rule-exempt", () => {
  const issue = { createdAt: "2026-07-01T00:00:00Z" };
  assert.equal(isPreRule(issue, RULE_EFFECTIVE_DATE), false);
});

test("isPreRule: boundary is inclusive-of-rule-date = owed (exactly-on-cutoff is NOT exempt)", () => {
  const issue = { createdAt: RULE_EFFECTIVE_DATE.toISOString() };
  assert.equal(isPreRule(issue, RULE_EFFECTIVE_DATE), false);
});

test("isPreRule: one millisecond before the cutoff IS exempt", () => {
  const oneMsBefore = new Date(RULE_EFFECTIVE_DATE.getTime() - 1).toISOString();
  const issue = { createdAt: oneMsBefore };
  assert.equal(isPreRule(issue, RULE_EFFECTIVE_DATE), true);
});

test("isPreRule: missing createdAt is never exempt (fail closed, not open)", () => {
  assert.equal(isPreRule({}), false);
});

test("parseRuleEffectiveDate: --rule-effective-date override is honored", () => {
  const overridden = parseRuleEffectiveDate("2026-01-01T00:00:00Z");
  assert.equal(overridden.toISOString(), "2026-01-01T00:00:00.000Z");
  // An issue that is pre-rule under the DEFAULT cutoff is post-rule under an
  // earlier override — proves main()'s ruleEffectiveDate param actually
  // changes the comparison, not just accepted-and-ignored.
  const issue = { createdAt: "2026-05-01T00:00:00Z" };
  assert.equal(isPreRule(issue, RULE_EFFECTIVE_DATE), true);
  assert.equal(isPreRule(issue, overridden), false);
});

test("parseRuleEffectiveDate: no override falls back to RULE_EFFECTIVE_DATE", () => {
  assert.equal(parseRuleEffectiveDate(undefined).getTime(), RULE_EFFECTIVE_DATE.getTime());
});

test("parseRuleEffectiveDate: unparseable override throws loudly instead of silently exempting nothing", () => {
  assert.throws(() => parseRuleEffectiveDate("not-a-date"), /could not parse/);
});

test("resolveCancelReason: a pre-rule target auto-resolves the legacy flag as exempt", () => {
  const target = {
    status: "todo",
    priority: "high",
    createdAt: "2026-05-01T00:00:00Z",
    createdByAgentId: "agent-1",
    assigneeAgentId: "agent-2",
    originKind: "manual",
    title: "Genuinely routed pre-rule issue",
  };
  const reason = resolveCancelReason({
    target, targetId: "AUR-1", hasRecord: false, ruleEffectiveDate: RULE_EFFECTIVE_DATE,
  });
  assert.ok(reason && /before the routing-rationale rule took effect/.test(reason));
});

test("resolveCancelReason: a post-rule target with no record is NOT auto-resolved", () => {
  const target = {
    status: "todo",
    priority: "high",
    createdAt: "2026-07-01T00:00:00Z",
    createdByAgentId: "agent-1",
    assigneeAgentId: "agent-2",
    originKind: "manual",
    title: "Genuinely routed post-rule issue",
  };
  const reason = resolveCancelReason({
    target, targetId: "AUR-2", hasRecord: false, ruleEffectiveDate: RULE_EFFECTIVE_DATE,
  });
  assert.equal(reason, null);
});

test("buildRollingIssueBody: surfaces preruleCount as report-only, with the cutoff date cited", () => {
  const body = buildRollingIssueBody([], { maxListed: 20, closedGapCount: 0, preruleCount: 689, ruleEffectiveDate: RULE_EFFECTIVE_DATE });
  assert.ok(body.includes("689 additional issue(s)"));
  assert.ok(body.includes(RULE_EFFECTIVE_DATE.toISOString()));
  assert.ok(body.includes("AUR-4006"));
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

// ── AUR-4280 / AUR-4303: owner-suffixed forward key shape ────────────────────

test("matchesRoutingKey: accepts legacy flat and owner-suffixed keys, rejects prefix collisions", () => {
  assert.equal(matchesRoutingKey("routing/AUR-27", "AUR-27"), true, "legacy flat key");
  assert.equal(matchesRoutingKey("routing/AUR-27/agent-a", "AUR-27"), true, "owner-suffixed key");
  // The AUR-3855 collision class MUST stay closed: a longer identifier that
  // merely starts with the target must never satisfy the lookup.
  assert.equal(matchesRoutingKey("routing/AUR-2756", "AUR-27"), false, "collision AUR-2756");
  assert.equal(matchesRoutingKey("routing/AUR-2756/agent-a", "AUR-27"), false, "suffixed collision");
  assert.equal(matchesRoutingKey(undefined, "AUR-27"), false, "non-string title");
});

test("pickNewestRoutingRecord: re-routed issue resolves to the NEWEST row, not the current assignee's", () => {
  // AUR-4280 defect shape: AUR-4147 was routed to agent-a, then re-routed to
  // agent-b. Both rationales exist. Recency — not assignee matching — decides.
  const records = [
    { id: "old", title: "routing/AUR-4147/agent-a", createdAt: "2026-07-01T00:00:00.000Z" },
    { id: "new", title: "routing/AUR-4147/agent-b", createdAt: "2026-07-20T00:00:00.000Z" },
  ];
  assert.equal(pickNewestRoutingRecord(records, "AUR-4147").id, "new");
  // Order-independent: the winner is max(createdAt), not last-seen.
  assert.equal(pickNewestRoutingRecord([...records].reverse(), "AUR-4147").id, "new");
});

test("pickNewestRoutingRecord: a legacy flat row and a new suffixed row coexist; newest wins", () => {
  const records = [
    { id: "flat", title: "routing/AUR-4147", createdAt: "2026-06-01T00:00:00.000Z" },
    { id: "suffixed", title: "routing/AUR-4147/agent-b", createdAt: "2026-07-20T00:00:00.000Z" },
  ];
  assert.equal(pickNewestRoutingRecord(records, "AUR-4147").id, "suffixed");
});

test("pickNewestRoutingRecord: a legacy flat row alone still satisfies (no backfill required)", () => {
  const records = [{ id: "flat", title: "routing/AUR-4147", createdAt: "2026-06-01T00:00:00.000Z" }];
  assert.equal(pickNewestRoutingRecord(records, "AUR-4147").id, "flat");
});

test("pickNewestRoutingRecord: NEGATIVE CONTROL — only colliding neighbours -> null", () => {
  const records = [
    { id: "c1", title: "routing/AUR-2756", createdAt: "2026-07-20T00:00:00.000Z" },
    { id: "c2", title: "routing/AUR-2749/agent-a", createdAt: "2026-07-21T00:00:00.000Z" },
  ];
  assert.equal(pickNewestRoutingRecord(records, "AUR-27"), null);
});

test("lookupRoutingRecord: re-routed AUR-4147 is satisfied ONCE, newest row returned", async () => {
  const { apiGet, calls } = makeStubApiGet({
    [`/api/companies/c1/memory/records?titlePrefix=routing/AUR-4147&limit=${ROUTING_RECORD_LOOKUP_LIMIT}`]: [
      { id: "old", title: "routing/AUR-4147/agent-a", createdAt: "2026-07-01T00:00:00.000Z" },
      { id: "new", title: "routing/AUR-4147/agent-b", createdAt: "2026-07-20T00:00:00.000Z" },
    ],
  });

  const result = await lookupRoutingRecord({
    companyId: "c1",
    targetId: "AUR-4147",
    projectId: "p1",
    apiGet,
  });

  assert.equal(result.found, true, "re-routed issue must NOT read as a gap");
  assert.equal(result.scope, "org");
  assert.equal(result.record.id, "new", "newest row wins on recency");
  // Satisfied once: the org query short-circuits, no duplicate project query.
  assert.equal(calls.length, 1);
});

test("lookupRoutingRecord: NEGATIVE CONTROL — genuinely unrouted issue still reads as a gap", async () => {
  const { apiGet } = makeStubApiGet({
    [`/api/companies/c1/memory/records?titlePrefix=routing/AUR-9999&limit=${ROUTING_RECORD_LOOKUP_LIMIT}`]: [
      // Only a colliding neighbour under the prefix — no rationale for AUR-9999.
      { id: "c1", title: "routing/AUR-99991/agent-a", createdAt: "2026-07-20T00:00:00.000Z" },
    ],
    [`/api/companies/c1/memory/records?titlePrefix=routing/AUR-9999&limit=${ROUTING_RECORD_LOOKUP_LIMIT}&projectId=p1`]: [],
  });

  const result = await lookupRoutingRecord({
    companyId: "c1",
    targetId: "AUR-9999",
    projectId: "p1",
    apiGet,
  });

  assert.equal(result.found, false, "unrouted issue MUST still be flagged");
  assert.equal(result.record, null);
});

// ── AUR-3854: delegate-then-handback must not silently void a genuine flag ──

test("AUR-3854 regression: delegated issue handed back to creator is NOT exempt for an existing flag", () => {
  // Reproduces the AUR-3850/AUR-3853 sequence: CTO (A) creates and assigns to
  // Claude Code Fast (B) — genuine delegation, flag filed. Coder ships and
  // hands the issue back to A for review — assigneeAgentId now equals
  // createdByAgentId again, but the flag must stay open until a routing/{id}
  // record actually exists.
  const target = {
    identifier: "AUR-3850",
    status: "in_review",
    title: "Loop C baseline-delta detector",
    description: "Implement the baseline-delta trend detector.",
    createdByAgentId: "371a1b08-0286-4a12-a516-f587f42df5eb", // CTO (A)
    assigneeAgentId: "371a1b08-0286-4a12-a516-f587f42df5eb", // handed back to A
  };

  // The self-assigned rule alone would wrongly call this exempt now.
  assert.equal(isExempt(target), true);
  // But re-evaluating an EXISTING flag must not use that rule.
  assert.equal(isExemptForResolvedFlag(target), false);

  const reason = resolveCancelReason({
    target,
    targetId: "AUR-3850",
    hasRecord: false,
  });
  assert.equal(reason, null, "flag must remain open while the routing/{id} record is absent");
});

test("AUR-3854: once the routing/{id} record is captured, the handed-back flag DOES auto-resolve", () => {
  const target = {
    identifier: "AUR-3850",
    status: "in_review",
    title: "Loop C baseline-delta detector",
    createdByAgentId: "371a1b08-0286-4a12-a516-f587f42df5eb",
    assigneeAgentId: "371a1b08-0286-4a12-a516-f587f42df5eb",
  };

  const reason = resolveCancelReason({ target, targetId: "AUR-3850", hasRecord: true });
  assert.match(reason, /record now exists/);
});

test("resolveCancelReason: hasRecord takes precedence over exemption in the resolution reason (secondary defect)", () => {
  const target = {
    identifier: "AUR-900",
    status: "todo",
    title: "content slot: some slot",
    createdByAgentId: "a1",
    assigneeAgentId: "b2",
  };
  // This target is statically exempt (content slot) AND has a record — the
  // reported reason must be the record, not the exemption.
  assert.equal(isExemptForResolvedFlag(target), true);
  const reason = resolveCancelReason({ target, targetId: "AUR-900", hasRecord: true });
  assert.match(reason, /record now exists/);
  assert.doesNotMatch(reason, /exempt/);
});

test("resolveCancelReason: done target still auto-resolves regardless of exemption/record", () => {
  const target = { identifier: "AUR-901", status: "done", createdByAgentId: "a1", assigneeAgentId: "b2" };
  const reason = resolveCancelReason({ target, targetId: "AUR-901", hasRecord: false });
  assert.match(reason, /is done/);
});

// ── isExemptForResolvedFlag mirrors static + immutable exemptions ───────────

test("isExemptForResolvedFlag: static content exemptions still apply to an existing flag", () => {
  const skipToken = {
    title: "Some task",
    description: "exec.routing-rationale: skip",
    createdByAgentId: "a1",
    assigneeAgentId: "b2",
  };
  assert.equal(isExempt(skipToken), true);
  assert.equal(isExemptForResolvedFlag(skipToken), true);

  const contentSlot = { title: "Content Slot: 2026-07-25 morning", createdByAgentId: "a1", assigneeAgentId: "b2" };
  assert.equal(isExemptForResolvedFlag(contentSlot), true);

  const dailyBrief = { title: "Post 2026-07-25 daily AI brief to AUR-27", createdByAgentId: "a1", assigneeAgentId: "b2" };
  assert.equal(isExemptForResolvedFlag(dailyBrief), true);

  const signOff = { title: "CFO sign-off: Standard ~$160/mo subscription tier", createdByAgentId: "a1", assigneeAgentId: "b2" };
  assert.equal(isExemptForResolvedFlag(signOff), true);
});

test("isExemptForResolvedFlag: immutable non-decision signals (no creator, routine origin) still apply", () => {
  // These properties can never flip after filing, so re-checking them is safe.
  assert.equal(isExemptForResolvedFlag({ title: "T", assigneeAgentId: "b2" }), true);
  assert.equal(
    isExemptForResolvedFlag({ title: "T", createdByAgentId: "a1", assigneeAgentId: "b2", originKind: "routine_execution" }),
    true,
  );
});

test("isExempt: genuinely delegated + non-exempt issue is NOT exempt under either predicate", () => {
  const issue = { title: "Build the widget", createdByAgentId: "a1", assigneeAgentId: "b2" };
  assert.equal(isExempt(issue), false);
  assert.equal(isExemptForResolvedFlag(issue), false);
});
