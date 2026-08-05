import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadCanonicalBlocks,
  discoverTargets,
  planTargetSync,
  planHasDrift,
  main,
} from './sync-agent-doctrine.mjs';

// ── In-memory fs stub ─────────────────────────────────────────────────────────

function makeStubFs(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles));
  const writes = [];
  const dirs = new Set();
  return {
    files,
    writes,
    async readdir(dir) {
      // Flat single-directory model: return basenames of any key under `dir/`.
      const prefix = dir.endsWith('/') ? dir : dir + '/';
      const names = [];
      for (const key of files.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
          names.push(key.slice(prefix.length));
        }
      }
      return names;
    },
    async readFile(p) {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p);
    },
    async writeFile(p, content) {
      files.set(p, content);
      writes.push({ path: p, content });
    },
    async mkdir(p) {
      dirs.add(p);
    },
  };
}

function makeStubApiGet(responses) {
  const calls = [];
  return {
    calls,
    async apiGet(path) {
      calls.push(path);
      if (!(path in responses)) throw new Error(`unexpected GET ${path}`);
      const value = responses[path];
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

const CANON_A = '<!-- BEGIN:doctrine-a v1 -->\nCanonical A body.\n<!-- END:doctrine-a -->\n';
const NON_MIRRORED = '# Just reference notes, no markers here.\n';

// ── loadCanonicalBlocks ────────────────────────────────────────────────────────

test('loadCanonicalBlocks: parses marked files, skips markerless ones', async () => {
  const fs = makeStubFs({
    '/doctrine/a.md': CANON_A,
    '/doctrine/notes.md': NON_MIRRORED,
  });
  const { blocks, skipped } = await loadCanonicalBlocks('/doctrine', fs);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].slug, 'doctrine-a');
  assert.deepEqual(skipped, ['notes.md']);
});

test('loadCanonicalBlocks: ignores non-.md files', async () => {
  const fs = makeStubFs({
    '/doctrine/a.md': CANON_A,
    '/doctrine/README.txt': 'not markdown',
  });
  const { blocks } = await loadCanonicalBlocks('/doctrine', fs);
  assert.equal(blocks.length, 1);
});

// ── discoverTargets ────────────────────────────────────────────────────────────

test('discoverTargets: resolves entryPath for every agent via instructions-bundle', async () => {
  const { apiGet, calls } = makeStubApiGet({
    '/api/companies/co1/agents': [
      { id: 'a1', name: 'Agent One' },
      { id: 'a2', name: 'Agent Two' },
    ],
    '/api/agents/a1/instructions-bundle': { resolvedEntryPath: '/agents/a1/AGENTS.md' },
    '/api/agents/a2/instructions-bundle': { resolvedEntryPath: '/agents/a2/AGENTS.md' },
  });
  const { targets, failures } = await discoverTargets('co1', { apiGet });
  assert.equal(targets.length, 2);
  assert.deepEqual(failures, []);
  assert.equal(targets[0].entryPath, '/agents/a1/AGENTS.md');
  assert.ok(calls.includes('/api/companies/co1/agents'));
});

test('discoverTargets: drops an agent with no resolvedEntryPath into failures, keeps going', async () => {
  const { apiGet } = makeStubApiGet({
    '/api/companies/co1/agents': [
      { id: 'a1', name: 'Agent One' },
      { id: 'a2', name: 'Agent Two' },
    ],
    '/api/agents/a1/instructions-bundle': { resolvedEntryPath: null },
    '/api/agents/a2/instructions-bundle': { resolvedEntryPath: '/agents/a2/AGENTS.md' },
  });
  const { targets, failures } = await discoverTargets('co1', { apiGet });
  assert.equal(targets.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].agentId, 'a1');
});

test('discoverTargets: a per-agent API error is caught into failures, not thrown', async () => {
  const { apiGet } = makeStubApiGet({
    '/api/companies/co1/agents': [{ id: 'a1', name: 'Agent One' }],
    '/api/agents/a1/instructions-bundle': new Error('GET .../instructions-bundle → 404 Not Found'),
  });
  const { targets, failures } = await discoverTargets('co1', { apiGet });
  assert.equal(targets.length, 0);
  assert.equal(failures.length, 1);
});

test('discoverTargets: agentIdFilter limits to a single agent', async () => {
  const { apiGet } = makeStubApiGet({
    '/api/companies/co1/agents': [
      { id: 'a1', name: 'Agent One' },
      { id: 'a2', name: 'Agent Two' },
    ],
    '/api/agents/a2/instructions-bundle': { resolvedEntryPath: '/agents/a2/AGENTS.md' },
  });
  const { targets } = await discoverTargets('co1', { apiGet, agentIdFilter: 'a2' });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].agentId, 'a2');
});

test('discoverTargets: accepts a {agents: [...]} wrapper shape as well as a bare array', async () => {
  const { apiGet } = makeStubApiGet({
    '/api/companies/co1/agents': { agents: [{ id: 'a1', name: 'Agent One' }] },
    '/api/agents/a1/instructions-bundle': { resolvedEntryPath: '/agents/a1/AGENTS.md' },
  });
  const { targets } = await discoverTargets('co1', { apiGet });
  assert.equal(targets.length, 1);
});

// ── planTargetSync / planHasDrift ───────────────────────────────────────────────

test('planTargetSync: missing block counts as a change; unchanged does not', () => {
  const blocks = [{ slug: 'doctrine-a', block: '<!-- BEGIN:doctrine-a v1 -->\nBLOCK-A\n<!-- END:doctrine-a -->' }];
  const missingPlan = planTargetSync('You are an agent.', blocks, 'safe');
  assert.equal(missingPlan.hasChanges, true);
  assert.equal(planHasDrift(missingPlan.verdicts), true);

  const unchangedPlan = planTargetSync(missingPlan.newContents, blocks, 'safe');
  assert.equal(unchangedPlan.hasChanges, false);
  assert.equal(planHasDrift(unchangedPlan.verdicts), false);
});

// ── main(): integration over stubbed fs + API ──────────────────────────────────

function baseApiResponses(entryContents) {
  return {
    '/api/companies/co1/agents': [{ id: 'a1', name: 'Agent One' }],
    '/api/agents/a1/instructions-bundle': { resolvedEntryPath: '/agents/a1/AGENTS.md' },
  };
}

test('main: --check exits 0 when every target already has every canonical block', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const p = url.replace('http://test', '');
    return { ok: true, status: 200, json: async () => baseApiResponses()[p] };
  };
  try {
    const entry = `You are an agent.\n\n${CANON_A}`;
    const fs = makeStubFs({
      '/doctrine/a.md': CANON_A,
      '/agents/a1/AGENTS.md': entry,
    });
    const code = await main({
      check: true,
      apply: false,
      tier: 'safe',
      doctrineDir: '/doctrine',
      backupDir: '/backup',
      apiUrl: 'http://test', apiKey: 'k', companyId: 'co1',
      fsImpl: fs,
    });
    assert.equal(code, 0);
    assert.equal(fs.writes.length, 0, '--check must never write');
  } finally {
    global.fetch = originalFetch;
  }
});

test('main: --check exits 1 and reports drift when a bundle is missing the block, without writing', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const p = url.replace('http://test', '');
    const responses = baseApiResponses();
    const body = responses[p];
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    const fs = makeStubFs({
      '/doctrine/a.md': CANON_A,
      '/agents/a1/AGENTS.md': 'You are an agent, no doctrine block yet.',
    });
    const code = await main({
      check: true,
      apply: false,
      tier: 'safe',
      doctrineDir: '/doctrine',
      backupDir: '/backup',
      apiUrl: 'http://test',
      apiKey: 'k',
      companyId: 'co1',
      fsImpl: fs,
    });
    assert.equal(code, 1);
    assert.equal(fs.writes.length, 0, '--check must never write');
  } finally {
    global.fetch = originalFetch;
  }
});

test('main: default dry-run plans a fix but writes nothing', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const p = url.replace('http://test', '');
    return { ok: true, status: 200, json: async () => baseApiResponses()[p] };
  };
  try {
    const fs = makeStubFs({
      '/doctrine/a.md': CANON_A,
      '/agents/a1/AGENTS.md': 'You are an agent.',
    });
    const code = await main({
      check: false,
      apply: false,
      tier: 'safe',
      doctrineDir: '/doctrine',
      backupDir: '/backup',
      apiUrl: 'http://test',
      apiKey: 'k',
      companyId: 'co1',
      fsImpl: fs,
    });
    assert.equal(code, 0);
    assert.equal(fs.writes.length, 0, 'dry-run must never write');
  } finally {
    global.fetch = originalFetch;
  }
});

test('main: --apply backs up then writes the repaired bundle; a second run is a clean no-op', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const p = url.replace('http://test', '');
    return { ok: true, status: 200, json: async () => baseApiResponses()[p] };
  };
  try {
    const fs = makeStubFs({
      '/doctrine/a.md': CANON_A,
      '/agents/a1/AGENTS.md': 'You are an agent.',
    });
    const code = await main({
      check: false,
      apply: true,
      tier: 'safe',
      doctrineDir: '/doctrine',
      backupDir: '/backup',
      apiUrl: 'http://test',
      apiKey: 'k',
      companyId: 'co1',
      fsImpl: fs,
    });
    assert.equal(code, 0);
    // One backup write + one real write.
    assert.equal(fs.writes.length, 2);
    const finalContents = fs.files.get('/agents/a1/AGENTS.md');
    assert.ok(finalContents.includes('BEGIN:doctrine-a'));
    const backupWrite = fs.writes.find(w => w.path !== '/agents/a1/AGENTS.md');
    assert.equal(backupWrite.content, 'You are an agent.');

    // Re-run --check against the now-repaired fleet: must be clean.
    const recheck = await main({
      check: true,
      apply: false,
      tier: 'safe',
      doctrineDir: '/doctrine',
      backupDir: '/backup',
      apiUrl: 'http://test',
      apiKey: 'k',
      companyId: 'co1',
      fsImpl: fs,
    });
    assert.equal(recheck, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('main: a corrupted (drifted) bundle is detected by --check and repaired by --apply', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const p = url.replace('http://test', '');
    return { ok: true, status: 200, json: async () => baseApiResponses()[p] };
  };
  try {
    const corrupted = 'You are an agent.\n\n<!-- BEGIN:doctrine-a v1 -->\nHAND-EDITED, WRONG.\n<!-- END:doctrine-a -->\n';
    const fs = makeStubFs({
      '/doctrine/a.md': CANON_A,
      '/agents/a1/AGENTS.md': corrupted,
    });
    const checkCode = await main({
      check: true, apply: false, tier: 'safe',
      doctrineDir: '/doctrine', backupDir: '/backup',
      apiUrl: 'http://test', apiKey: 'k', companyId: 'co1', fsImpl: fs,
    });
    assert.equal(checkCode, 1);
    assert.equal(fs.writes.length, 0);

    const applyCode = await main({
      check: false, apply: true, tier: 'safe',
      doctrineDir: '/doctrine', backupDir: '/backup',
      apiUrl: 'http://test', apiKey: 'k', companyId: 'co1', fsImpl: fs,
    });
    assert.equal(applyCode, 0);
    assert.ok(!fs.files.get('/agents/a1/AGENTS.md').includes('HAND-EDITED, WRONG'));

    const recheckCode = await main({
      check: true, apply: false, tier: 'safe',
      doctrineDir: '/doctrine', backupDir: '/backup',
      apiUrl: 'http://test', apiKey: 'k', companyId: 'co1', fsImpl: fs,
    });
    assert.equal(recheckCode, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('main: a write failure during --apply is reported and exits 2, not silently dropped', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const p = url.replace('http://test', '');
    return { ok: true, status: 200, json: async () => baseApiResponses()[p] };
  };
  try {
    const fs = makeStubFs({
      '/doctrine/a.md': CANON_A,
      '/agents/a1/AGENTS.md': 'You are an agent.',
    });
    const originalWriteFile = fs.writeFile.bind(fs);
    let calls = 0;
    fs.writeFile = async (p, content) => {
      calls++;
      if (calls === 2) throw new Error('EACCES: permission denied');
      return originalWriteFile(p, content);
    };
    const code = await main({
      check: false, apply: true, tier: 'safe',
      doctrineDir: '/doctrine', backupDir: '/backup',
      apiUrl: 'http://test', apiKey: 'k', companyId: 'co1', fsImpl: fs,
    });
    assert.equal(code, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('main: --tier all overwrites a pointer stub that --check (safe) would treat as clean', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const p = url.replace('http://test', '');
    return { ok: true, status: 200, json: async () => baseApiResponses()[p] };
  };
  try {
    const longCanon = '<!-- BEGIN:doctrine-a v1 -->\n' + 'x'.repeat(500) + '\n<!-- END:doctrine-a -->\n';
    const stub = '<!-- BEGIN:doctrine-a v1 -->\nsee canonical doc\n<!-- END:doctrine-a -->';
    const fs = makeStubFs({
      '/doctrine/a.md': longCanon,
      '/agents/a1/AGENTS.md': `preamble\n\n${stub}\n`,
    });
    const safeCheck = await main({
      check: true, apply: false, tier: 'safe',
      doctrineDir: '/doctrine', backupDir: '/backup',
      apiUrl: 'http://test', apiKey: 'k', companyId: 'co1', fsImpl: fs,
    });
    assert.equal(safeCheck, 0, 'a pointer stub is not drift under the default tier');

    const allApply = await main({
      check: false, apply: true, tier: 'all',
      doctrineDir: '/doctrine', backupDir: '/backup',
      apiUrl: 'http://test', apiKey: 'k', companyId: 'co1', fsImpl: fs,
    });
    assert.equal(allApply, 0);
    assert.ok(!fs.files.get('/agents/a1/AGENTS.md').includes('see canonical doc'));
  } finally {
    global.fetch = originalFetch;
  }
});
