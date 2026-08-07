// node --test scripts/sgi-loop-d-roi-ledger.approval.test.mjs
//
// AUR-5354 — board approvals are OPT-IN. These are end-to-end runs of the real
// script against a stub control plane, with a fixture engineered to produce a
// genuine band crossing (p-star: healthy → profit_seeking). Both controls are
// required and neither is redundant:
//
//   negative control — no flags       → 0 approvals, comment still written
//   positive control — --file-approval → 1 approval  (proves the stub CAN see one,
//                                        so the negative result is a real zero and
//                                        not a broken observation)

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'sgi-loop-d-roi-ledger.mjs');
const COMPANY_ID = 'co-test';
const TASK_ID = 'issue-test';

const card = (issueId, tokenCost) => ({
  id: `sc-${issueId}`,
  title: `scorecard-adjusted/ag-1/bug/2026-08-01/${issueId}`,
  content: '',
  metadata: {
    category: 'scorecard_adjusted', issue_id: issueId,
    value_signal: 5, quality_signal: 5, token_cost: tokenCost,
  },
});

const priorLedger = (projectId) => ({
  id: `roi-${projectId}`,
  title: `roi/${projectId}/lifetime`,
  content: '',
  metadata: { category: 'roi_ledger', project_id: projectId, band: 'healthy', roi: 0.6, computed_at: '2026-08-01T00:00:00.000Z' },
});

// vpt = adjustedValue / (tokenCost/1000): p-star 5/50 = 0.1, others 5/500 = 0.01.
// median vpt = 0.01 → roi(p-star) = 0.1/0.11 = 90.9% > 0.70 → profit_seeking,
// crossing up from the prior `healthy` ledger → exactly one board action.
const SCORECARDS = [card('AUR-1', 50_000), card('AUR-2', 500_000), card('AUR-3', 500_000)];
const PRIOR = [priorLedger('p-star'), priorLedger('p-mid1'), priorLedger('p-mid2')];
const ISSUES = [
  { identifier: 'AUR-1', projectId: 'p-star', project: { name: 'Star' }, priority: 'medium' },
  { identifier: 'AUR-2', projectId: 'p-mid1', project: { name: 'Mid1' }, priority: 'medium' },
  { identifier: 'AUR-3', projectId: 'p-mid2', project: { name: 'Mid2' }, priority: 'medium' },
];

/** Stub control plane. Returns { url, calls, close }. */
async function startStub() {
  const calls = { approvals: [], comments: [], captures: [] };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const [path, query = ''] = req.url.split('?');
      const json = (payload) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (path === '/api/health') return json({ ok: true });
      if (path === `/api/companies/${COMPANY_ID}/memory/records`) {
        return json({ records: query.includes('titlePrefix=roi') ? PRIOR : [...SCORECARDS, ...PRIOR] });
      }
      if (path === `/api/companies/${COMPANY_ID}/issues`) return json({ issues: ISSUES });
      if (path === `/api/companies/${COMPANY_ID}/memory/capture`) {
        calls.captures.push(JSON.parse(body)); return json({ records: [{ id: 'rec-1' }] });
      }
      if (path === `/api/companies/${COMPANY_ID}/approvals`) {
        calls.approvals.push(JSON.parse(body)); return json({ id: 'appr-1' });
      }
      if (path === `/api/issues/${TASK_ID}/comments`) {
        calls.comments.push(JSON.parse(body)); return json({ id: 'cmt-1' });
      }
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

function runLedger(apiUrl, args) {
  return new Promise((resolve, reject) => {
    execFile('node', [SCRIPT, ...args], {
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

test('negative control: a band crossing files NO board approval by default, and still reports it in the comment', async () => {
  const stub = await startStub();
  try {
    const result = await runLedger(stub.url, []);
    assert.equal(result.boardActions, 1, 'fixture must actually produce a crossing, else this test proves nothing');
    assert.equal(result.approvalId, null);
    assert.equal(stub.calls.approvals.length, 0, 'no POST /approvals may be issued without --file-approval');
    assert.equal(stub.calls.comments.length, 1, 'the crossing must still be reported on the execution issue');
    const comment = stub.calls.comments[0].body;
    assert.match(comment, /ROI threshold crossings/);
    assert.match(comment, /PROFIT-SEEKING|profit_seeking/i);
    assert.match(comment, /no approval row filed/);
  } finally {
    await stub.close();
  }
});

test('positive control: --file-approval files exactly one board approval for the same crossing', async () => {
  const stub = await startStub();
  try {
    const result = await runLedger(stub.url, ['--file-approval']);
    assert.equal(result.boardActions, 1);
    assert.equal(result.approvalId, 'appr-1');
    assert.equal(stub.calls.approvals.length, 1);
    assert.equal(stub.calls.approvals[0].type, 'request_board_approval');
    assert.equal(stub.calls.comments.length, 1);
    assert.match(stub.calls.comments[0].body, /Board approval requested/);
  } finally {
    await stub.close();
  }
});

test('the retired --no-approval flag is accepted and is a no-op', async () => {
  const stub = await startStub();
  try {
    const result = await runLedger(stub.url, ['--no-approval']);
    assert.equal(result.approvalId, null);
    assert.equal(stub.calls.approvals.length, 0);
  } finally {
    await stub.close();
  }
});
