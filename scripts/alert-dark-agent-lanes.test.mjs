import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { tickCompany, sendFounderAlert } from './alert-dark-agent-lanes.mjs';
import { DEFAULT_DARK_LANE_STATE } from './lib/dark-lane-transition.mjs';

const NOW = new Date('2026-08-05T12:00:00.000Z');
const FAR = '2026-08-11T00:00:00.000Z';

function makeAgent(overrides = {}) {
  return { id: 'a1', name: 'CTO Ops', urlKey: 'cto-ops', adapterType: 'codex', metadata: null, ...overrides };
}

function darkRuns(agentId = 'a1') {
  return [
    { agentId, status: 'scheduled_retry', scheduledRetryAt: FAR, contextSnapshot: { issueId: 'AUR-1' } },
    { agentId, status: 'failed', scheduledRetryAt: null },
  ];
}

test('newly dark agent: sends exactly one alert and patches metadata.darkLane', async () => {
  const sent = [];
  const patched = [];
  const { results, localState } = await tickCompany({
    agents: [makeAgent()],
    runs: darkRuns(),
    now: NOW,
    issuePrefix: 'aur',
    sendAlert: async (msg) => {
      sent.push(msg);
      return 'confirmed';
    },
    patchAgent: async (id, metadata) => {
      patched.push({ id, metadata });
    },
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0], /Lane dark: CTO Ops/);
  assert.equal(patched.length, 1);
  assert.equal(patched[0].metadata.darkLane.active, true);
  assert.equal(patched[0].metadata.darkLane.alertedAt, NOW.toISOString());
  assert.equal(results.length, 1);
  assert.equal(results[0].alert, 'opened');
  assert.equal(results[0].patched, true);
  // AUR-5027: local state agrees with what was (successfully) patched.
  assert.equal(localState.a1.alertedAt, NOW.toISOString());
});

test('AC2: still dark on the next tick sends zero further alerts and does not re-patch', async () => {
  const agent = makeAgent({
    metadata: {
      darkLane: {
        ...DEFAULT_DARK_LANE_STATE,
        active: true,
        since: NOW.toISOString(),
        adapterType: 'codex',
        reason: 'provider_reset_park',
        resetAt: FAR,
        alertedAt: NOW.toISOString(),
      },
    },
  });

  let sendCount = 0;
  let patchCount = 0;
  const later = new Date(NOW.getTime() + 15 * 60 * 1000);
  const { results } = await tickCompany({
    agents: [agent],
    runs: darkRuns(),
    now: later,
    issuePrefix: 'aur',
    sendAlert: async () => {
      sendCount += 1;
      return 'confirmed';
    },
    patchAgent: async () => {
      patchCount += 1;
    },
  });

  assert.equal(sendCount, 0);
  assert.equal(patchCount, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].alert, null);
});

test('AC3: recovery sends exactly one alert and clears darkLane metadata', async () => {
  const agent = makeAgent({
    metadata: {
      unrelatedKey: 'keep-me',
      darkLane: {
        ...DEFAULT_DARK_LANE_STATE,
        active: true,
        since: NOW.toISOString(),
        adapterType: 'codex',
        alertedAt: NOW.toISOString(),
      },
    },
  });

  const sent = [];
  const patched = [];
  // No runs at all this tick: the agent has live continuation again (nothing
  // scheduled_retry, nothing parked) — not dark.
  const { results, localState } = await tickCompany({
    agents: [agent],
    runs: [{ agentId: 'a1', status: 'succeeded', scheduledRetryAt: null }],
    now: new Date(NOW.getTime() + 30 * 60 * 1000),
    issuePrefix: 'aur',
    sendAlert: async (msg) => {
      sent.push(msg);
      return 'confirmed';
    },
    patchAgent: async (id, metadata) => {
      patched.push({ id, metadata });
    },
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0], /Lane recovered: CTO Ops/);
  assert.equal(patched.length, 1);
  assert.equal(patched[0].metadata.darkLane, undefined);
  assert.equal(patched[0].metadata.unrelatedKey, 'keep-me');
  assert.equal(results[0].alert, 'recovered');
  assert.equal(localState.a1, undefined);
});

test('AC4: rate-window refusal ("blocked") leaves the guard unset for retry, never re-sends same tick', async () => {
  let sendCalls = 0;
  const patched = [];
  const { results, localState } = await tickCompany({
    agents: [makeAgent()],
    runs: darkRuns(),
    now: NOW,
    issuePrefix: 'aur',
    sendAlert: async () => {
      sendCalls += 1;
      return 'blocked';
    },
    patchAgent: async (id, metadata) => {
      patched.push({ id, metadata });
    },
  });

  assert.equal(sendCalls, 1);
  assert.equal(results[0].sendResult, 'blocked');
  // Patched (since state moved from null -> active/unalerted), but alertedAt
  // must remain null so the next tick retries instead of treating this as handled.
  assert.equal(patched.length, 1);
  assert.equal(patched[0].metadata.darkLane.alertedAt, null);
  assert.equal(patched[0].metadata.darkLane.active, true);
  // AUR-5027 (AC8): the authoritative local state carries the same
  // unconfirmed-so-unset guard — a blocked send must not read as suppressed.
  assert.equal(localState.a1.alertedAt, null);
  assert.equal(localState.a1.active, true);
});

test('a patchAgent failure (e.g. cross-agent write permission gate) is surfaced, not thrown, and does not block other agents', async () => {
  const sent = [];
  const { results } = await tickCompany({
    agents: [makeAgent({ id: 'a1', name: 'Dark One' }), makeAgent({ id: 'a2', name: 'Dark Two' })],
    runs: [...darkRuns('a1'), ...darkRuns('a2')],
    now: NOW,
    issuePrefix: 'aur',
    sendAlert: async (msg) => {
      sent.push(msg);
      return 'confirmed';
    },
    patchAgent: async (id) => {
      if (id === 'a1') throw new Error('403 Forbidden');
      // a2 succeeds
    },
  });

  assert.equal(sent.length, 2); // both alerts still went out
  const a1 = results.find((r) => r.agentId === 'a1');
  const a2 = results.find((r) => r.agentId === 'a2');
  assert.equal(a1.patched, false);
  assert.match(a1.patchError, /403 Forbidden/);
  assert.equal(a2.patched, true);
  assert.equal(a2.patchError, null);
});

test('healthy idle agent with no metadata and no parked runs produces zero candidates', async () => {
  const { results } = await tickCompany({
    agents: [makeAgent()],
    runs: [{ agentId: 'a1', status: 'succeeded', scheduledRetryAt: null }],
    now: NOW,
    issuePrefix: 'aur',
    sendAlert: async () => 'confirmed',
    patchAgent: async () => {
      throw new Error('should not patch a healthy agent');
    },
  });
  assert.deepEqual(results, []);
});

test('dry-run computes the plan but never calls sendAlert or patchAgent', async () => {
  const { results } = await tickCompany({
    agents: [makeAgent()],
    runs: darkRuns(),
    now: NOW,
    issuePrefix: 'aur',
    dryRun: true,
    sendAlert: async () => {
      throw new Error('dry-run must not send');
    },
    patchAgent: async () => {
      throw new Error('dry-run must not patch');
    },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].alert, 'opened');
  assert.equal(results[0].sendResult, null);
  assert.equal(results[0].patched, false);
});

// ── AUR-5027: AC2 dedup guard must survive a failed metadata PATCH ──────────

function alwaysFailingPatchAgent() {
  return async () => {
    throw new Error('403 Forbidden');
  };
}

test('AUR-5027 req6: two consecutive dark ticks with the metadata PATCH forced to fail still send exactly one alert', async () => {
  const sent = [];
  const patchAgent = alwaysFailingPatchAgent();

  const tick1 = await tickCompany({
    agents: [makeAgent()],
    runs: darkRuns(),
    now: NOW,
    issuePrefix: 'aur',
    sendAlert: async (msg) => {
      sent.push(msg);
      return 'confirmed';
    },
    patchAgent,
  });

  // The PATCH failed — the old implementation left agent.metadata.darkLane
  // untouched, so a second tick reading only metadata would see prevState
  // null again and re-plan the same "opened" alert. Feed the SAME
  // (unpatched) agent metadata into tick 2, but carry the returned
  // localState forward — that is the fix under test.
  const tick2 = await tickCompany({
    agents: [makeAgent()], // metadata still null: PATCH never landed
    runs: darkRuns(),
    now: new Date(NOW.getTime() + 15 * 60 * 1000),
    issuePrefix: 'aur',
    sendAlert: async (msg) => {
      sent.push(msg);
      return 'confirmed';
    },
    patchAgent,
    localState: tick1.localState,
  });

  assert.equal(sent.length, 1, 'exactly one alert across two ticks despite every PATCH failing');
  assert.equal(tick1.results[0].alert, 'opened');
  assert.equal(tick2.results[0].alert, null);
  assert.equal(tick1.results[0].patched, false);
  assert.equal(tick2.results[0].patched, false);
  assert.equal(tick1.localState.a1.alertedAt, NOW.toISOString());
});

test('AUR-5027 req5: a metadata PATCH failure is surfaced via patchError but never thrown', async () => {
  const results = await tickCompany({
    agents: [makeAgent()],
    runs: darkRuns(),
    now: NOW,
    issuePrefix: 'aur',
    sendAlert: async () => 'confirmed',
    patchAgent: alwaysFailingPatchAgent(),
  });
  // Resolving (not rejecting) is the contract main() relies on to degrade
  // this to a warning instead of an error exit.
  assert.equal(results.results[0].patchError, '403 Forbidden');
});

test('AUR-5027 req7: dark -> recovered -> exactly one recovery alert, with the PATCH still failing throughout', async () => {
  const sent = [];
  const patchAgent = alwaysFailingPatchAgent();

  const tick1 = await tickCompany({
    agents: [makeAgent()],
    runs: darkRuns(),
    now: NOW,
    issuePrefix: 'aur',
    sendAlert: async (msg) => {
      sent.push(msg);
      return 'confirmed';
    },
    patchAgent,
  });
  assert.equal(tick1.results[0].alert, 'opened');

  // Second tick: still dark, metadata PATCH never landed so metadata is
  // still null — must rely on localState, not send again.
  const tick2 = await tickCompany({
    agents: [makeAgent()],
    runs: darkRuns(),
    now: new Date(NOW.getTime() + 15 * 60 * 1000),
    issuePrefix: 'aur',
    sendAlert: async (msg) => {
      sent.push(msg);
      return 'confirmed';
    },
    patchAgent,
    localState: tick1.localState,
  });
  assert.equal(tick2.results[0].alert, null);

  // Third tick: recovered (no parked runs at all).
  const tick3 = await tickCompany({
    agents: [makeAgent()],
    runs: [{ agentId: 'a1', status: 'succeeded', scheduledRetryAt: null }],
    now: new Date(NOW.getTime() + 30 * 60 * 1000),
    issuePrefix: 'aur',
    sendAlert: async (msg) => {
      sent.push(msg);
      return 'confirmed';
    },
    patchAgent,
    localState: tick2.localState,
  });

  assert.equal(sent.length, 2, 'exactly one opened + one recovered alert');
  assert.match(sent[1], /Lane recovered/);
  assert.equal(tick3.results[0].alert, 'recovered');
  assert.deepEqual(tick3.localState, {}, 'fully quiescent again once the recovery alert confirms');
});

test('AUR-5027 req8: send blocked by the rate window leaves the local guard unset so the next tick retries', async () => {
  const sent = [];
  let call = 0;
  const sendAlert = async (msg) => {
    call += 1;
    sent.push(msg);
    return call === 1 ? 'blocked' : 'confirmed';
  };
  const patchAgent = alwaysFailingPatchAgent();

  const tick1 = await tickCompany({
    agents: [makeAgent()],
    runs: darkRuns(),
    now: NOW,
    issuePrefix: 'aur',
    sendAlert,
    patchAgent,
  });
  assert.equal(tick1.results[0].alert, 'opened');
  assert.equal(tick1.results[0].sendResult, 'blocked');
  assert.equal(tick1.localState.a1.alertedAt, null, 'unconfirmed send must not set the guard');

  const tick2 = await tickCompany({
    agents: [makeAgent()],
    runs: darkRuns(),
    now: new Date(NOW.getTime() + 15 * 60 * 1000),
    issuePrefix: 'aur',
    sendAlert,
    patchAgent,
    localState: tick1.localState,
  });

  assert.equal(sent.length, 2, 'the next tick legitimately retries the still-unconfirmed alert');
  assert.equal(tick2.results[0].alert, 'opened');
  assert.equal(tick2.results[0].sendResult, 'confirmed');
  assert.equal(tick2.localState.a1.alertedAt, new Date(NOW.getTime() + 15 * 60 * 1000).toISOString());
});

test('AUR-5027: local state is authoritative even when agent.metadata.darkLane still shows the stale unpatched value', async () => {
  // Simulates the real production shape: metadata never moved off null
  // because every PATCH 403s, but localState correctly tracked the guard.
  const alertedAt = NOW.toISOString();
  let sendCalls = 0;
  const { results } = await tickCompany({
    agents: [makeAgent({ metadata: null })],
    runs: darkRuns(),
    now: new Date(NOW.getTime() + 60 * 60 * 1000),
    issuePrefix: 'aur',
    localState: {
      a1: { ...DEFAULT_DARK_LANE_STATE, active: true, since: NOW.toISOString(), alertedAt },
    },
    sendAlert: async () => {
      sendCalls += 1;
      return 'confirmed';
    },
    patchAgent: alwaysFailingPatchAgent(),
  });

  assert.equal(sendCalls, 0, 'localState alertedAt suppresses the repeat alert even though metadata is still null');
  assert.equal(results[0].alert, null);
});

// ── sendFounderAlert: real subprocess exec against fake notify_founder.sh stand-ins ──

function makeFakeScript(dir, name, body) {
  const p = path.join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

test('sendFounderAlert classifies stdout starting with "sent" as confirmed', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aur4532-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cmd = makeFakeScript(dir, 'notify-ok.sh', 'echo "sent (telegram ok)"\nexit 0');
  const result = await sendFounderAlert('test message', { cmd });
  assert.equal(result, 'confirmed');
});

test('sendFounderAlert classifies exit code 2 as blocked (rate window / policy refusal)', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aur4532-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cmd = makeFakeScript(dir, 'notify-blocked.sh', 'echo "rate limited"\nexit 2');
  const result = await sendFounderAlert('test message', { cmd });
  assert.equal(result, 'blocked');
});

test('sendFounderAlert classifies a non-"sent" success exit as failed (401-style silent failure)', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aur4532-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cmd = makeFakeScript(dir, 'notify-silent-fail.sh', 'echo "Mobile push not sent (Remote Control inactive)"\nexit 0');
  const result = await sendFounderAlert('test message', { cmd });
  assert.equal(result, 'failed');
});

test('sendFounderAlert classifies exit code 1 as failed', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aur4532-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cmd = makeFakeScript(dir, 'notify-fail.sh', 'echo "usage error"\nexit 1');
  const result = await sendFounderAlert('test message', { cmd });
  assert.equal(result, 'failed');
});

test('sendFounderAlert invokes notify_founder.sh with INFO, not SEV2 (AUR-5355)', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aur4532-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const echoArgsPath = path.join(dir, 'first-arg.txt');
  const cmd = makeFakeScript(
    dir,
    'notify-echo-args.sh',
    `printf '%s' "$1" > "${echoArgsPath}"\necho "sent (info-logged)"\nexit 0`
  );
  const result = await sendFounderAlert('test message', { cmd });
  assert.equal(result, 'confirmed');
  assert.equal(readFileSync(echoArgsPath, 'utf8'), 'INFO');
});
