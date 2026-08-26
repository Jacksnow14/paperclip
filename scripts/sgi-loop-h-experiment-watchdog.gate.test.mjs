// node --test scripts/sgi-loop-h-experiment-watchdog.gate.test.mjs
//
// AUR-5354 — end-to-end runs of the real watchdog against a stub control plane.
// The negative control (a prompt_edit hypothesis no longer nags the board) is
// only meaningful next to the positive control (a genuine founder decision
// still does), so both run against the same code path and the same stub.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'sgi-loop-h-experiment-watchdog.mjs');
const COMPANY_ID = 'co-test';
const TASK_ID = 'issue-test';
const AGENT = 'agent-under-test';
// AUR-6215: mirrors PLATFORM_LABEL_ID exported by sgi-loop-h-experiment-watchdog.mjs.
// Not imported because this test execs the script as a subprocess.
const PLATFORM_LABEL_ID = '83062a2e-aec5-4de2-9541-02d05641c246';

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

const experiment = (id, metadata) => ({
  id: `rec-${id}`,
  title: `experiment/${id}`,
  content: '',
  metadata: { category: 'experiment', id, target_agent_id: AGENT, task_type: 'bug', horizon_tasks: 20, expected_metric: 'quality_signal', expected_delta: '+10%', ...metadata },
});

const gateVerdict = (diffHash, v) => ({
  id: `verdict-${diffHash}`,
  title: 'prompt-edit-verdict/agent-under-test/2026-08-07',
  content: '',
  metadata: { category: 'prompt_improvement_proposal', kind: 'prompt_edit_verdict', diff_hash: diffHash, verdict: v },
});

/** Stub control plane. `records` is a map of titlePrefix → rows. */
async function startStub(records, approvals = {}) {
  const calls = { issues: [], interactions: [], comments: [], patches: [], captures: [] };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const [path, query = ''] = req.url.split('?');
      const json = (payload) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (path === '/api/health') return json({ ok: true });
      if (path === `/api/companies/${COMPANY_ID}/memory/records`) {
        const prefix = decodeURIComponent((query.match(/titlePrefix=([^&]*)/) || [, ''])[1]);
        const offset = Number((query.match(/offset=(\d+)/) || [, '0'])[1]);
        return json({ records: offset > 0 ? [] : (records[prefix] ?? []) });
      }
      if (path.startsWith('/api/approvals/')) {
        const id = path.split('/').pop();
        return approvals[id] ? json(approvals[id]) : (res.writeHead(404), res.end('{}'));
      }
      if (path === `/api/companies/${COMPANY_ID}/memory/capture`) { calls.captures.push(JSON.parse(body)); return json({ records: [{ id: 'new-rec' }] }); }
      if (path.startsWith(`/api/companies/${COMPANY_ID}/memory/records/`)) { calls.patches.push({ id: path.split('/').pop(), body: JSON.parse(body) }); return json({ id: 'patched' }); }
      if (path === `/api/companies/${COMPANY_ID}/issues`) { calls.issues.push(JSON.parse(body)); return json({ id: 'new-issue', identifier: 'AUR-9001' }); }
      if (path === `/api/issues/${TASK_ID}/interactions`) { calls.interactions.push(JSON.parse(body)); return json({ id: 'int-1' }); }
      if (path === `/api/issues/${TASK_ID}/comments`) { calls.comments.push(JSON.parse(body)); return json({ id: 'cmt-1' }); }
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

function runWatchdog(apiUrl) {
  return new Promise((resolve, reject) => {
    execFile('node', [SCRIPT], {
      env: {
        ...process.env,
        PAPERCLIP_API_URL: apiUrl, PAPERCLIP_API_KEY: 'test-key',
        PAPERCLIP_COMPANY_ID: COMPANY_ID, PAPERCLIP_AGENT_ID: 'ag-test',
        PAPERCLIP_TASK_ID: TASK_ID, PAPERCLIP_RUN_ID: '',
      },
      timeout: 60_000,
    }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(JSON.parse(stdout))));
  });
}

test('negative control: a prompt_edit hypothesis asks for a gate run, never nags the board', async () => {
  // Exactly the shape of the two live rows (1015ee05, 534e44ab): proposed, a
  // board approval pending well past the 7d escalation threshold.
  const stub = await startStub({
    'experiment/': [experiment('exp-prompt', {
      status: 'proposed', change_type: 'prompt_edit',
      hypothesis: 'A shorter retro template raises quality.',
      change: 'Trim the retrospective section of the agent AGENTS.md to five bullets.',
      board_approval_id: 'appr-stale',
    })],
    'experiment-conclusions/': [], 'performance/': [], 'scorecard-adjusted/': [], 'prompt-edit-verdict/': [],
  }, { 'appr-stale': { id: 'appr-stale', status: 'pending', createdAt: daysAgo(30) } });
  try {
    const result = await runWatchdog(stub.url);
    assert.equal(stub.calls.interactions.length, 0, 'no board escalation may be filed for a prompt edit');
    assert.equal(result.counts.pendingApproval, 0, 'a prompt edit must not be counted as a pending board ask');
    assert.equal(result.counts.gateRequested, 1);
    assert.equal(stub.calls.issues.length, 1, 'exactly one gate-run issue');
    assert.match(stub.calls.issues[0].title, /prompt-edit gate/);
    assert.equal(stub.calls.issues[0].assigneeAgentId, AGENT);
    assert.match(stub.calls.issues[0].description, /prompt-edit-gate\.mjs/);
    // AUR-6215: gate-run issues are self-improvement work, never critical —
    // must file as backlog + platform label, not the default todo.
    assert.equal(stub.calls.issues[0].status, 'backlog');
    assert.deepEqual(stub.calls.issues[0].labelIds, [PLATFORM_LABEL_ID]);
    const patched = stub.calls.patches.find((p) => p.id === 'rec-exp-prompt');
    assert.equal(patched.body.metadata.status, 'needs_gate');
    assert.equal(patched.body.metadata.gate_issue_id, 'new-issue');
  } finally { await stub.close(); }
});

test('positive control: a genuine founder decision still escalates to the board', async () => {
  const stub = await startStub({
    'experiment/': [experiment('exp-spend', {
      status: 'proposed', change_type: 'spend',
      hypothesis: 'A larger paid plan unblocks the codex lane.',
      change: 'Purchase additional API credits for the codex lane.',
      board_approval_id: 'appr-stale',
    })],
    'experiment-conclusions/': [], 'performance/': [], 'scorecard-adjusted/': [], 'prompt-edit-verdict/': [],
    // 8 days: past the 7d escalation threshold, short of the 14d founder Telegram.
  }, { 'appr-stale': { id: 'appr-stale', status: 'pending', createdAt: daysAgo(8) } });
  try {
    const result = await runWatchdog(stub.url);
    assert.equal(result.counts.pendingApproval, 1);
    assert.equal(stub.calls.interactions.length, 1, 'the board escalation path must still work');
    assert.equal(stub.calls.interactions[0].kind, 'request_confirmation');
    assert.equal(stub.calls.issues.length, 0, 'a founder decision does not go through the prompt-edit gate');
    assert.equal(result.counts.gateRequested, 0);
  } finally { await stub.close(); }
});

test('an ACCEPTED gate verdict arms the experiment and activates it in the same pass', async () => {
  const stub = await startStub({
    'experiment/': [experiment('exp-armed', {
      status: 'needs_gate', change_type: 'prompt_edit',
      change: 'Add a pre-commit staged-path check to the agent instructions.',
      gate_issue_id: 'iss-earlier', gate_diff_hash: 'deadbeef12345678',
    })],
    'experiment-conclusions/': [], 'performance/': [], 'scorecard-adjusted/': [],
    'prompt-edit-verdict/': [gateVerdict('deadbeef12345678', 'accepted')],
  });
  try {
    const result = await runWatchdog(stub.url);
    assert.equal(result.counts.gateArmed, 1);
    assert.equal(result.counts.activated, 1, 'gate-armed experiments must not wait for a board approval');
    assert.equal(stub.calls.issues.length, 0, 'no second gate issue for an already-armed experiment');
    const statuses = stub.calls.patches.map((p) => p.body.metadata.status);
    assert.deepEqual(statuses.slice(0, 2), ['approved', 'running']);
  } finally { await stub.close(); }
});

test('a REJECTED gate verdict concludes the experiment without a board round-trip', async () => {
  const stub = await startStub({
    'experiment/': [experiment('exp-rejected', {
      status: 'needs_gate', change_type: 'prompt_edit',
      change: 'Rewrite the whole AGENTS.md.',
      gate_issue_id: 'iss-earlier', gate_diff_hash: 'badbadbad0000000',
    })],
    'experiment-conclusions/': [], 'performance/': [], 'scorecard-adjusted/': [],
    'prompt-edit-verdict/': [gateVerdict('badbadbad0000000', 'rejected')],
  });
  try {
    const result = await runWatchdog(stub.url);
    assert.equal(result.counts.gateRejected, 1);
    assert.equal(stub.calls.interactions.length, 0);
    const conclusion = stub.calls.captures.find((c) => c.title.startsWith('experiment-conclusions/'));
    assert.equal(conclusion.metadata.rejection_reason, 'gate_rejected');
  } finally { await stub.close(); }
});
