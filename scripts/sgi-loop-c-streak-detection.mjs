#!/usr/bin/env node
/**
 * SGI Loop C — Scorecard Streak Detection (Prompt Self-Edit detector)
 *
 * Fetches all `performance_scorecard` memory records, groups them by
 * {agent_id}/{task_type}, and inspects the 3 most-recent closed/successful
 * runs per bucket. A bucket triggers a self-edit issue when either:
 *   - declining quality:  q1 > q2 > q3 (strict monotone decrease), OR
 *   - rework streak:      all 3 have rework_required === true
 *
 * For each triggered bucket with no existing open self-edit issue, it files a
 * "Prompt self-edit required — {agent_id} / {task_type}" issue assigned back to
 * the offending agent (Loop C § 13 protocol).
 *
 * titlePrefix= is ignored server-side, so records are filtered client-side.
 *
 * Usage:
 *   node scripts/sgi-loop-c-streak-detection.mjs            # detect + create issues
 *   node scripts/sgi-loop-c-streak-detection.mjs --dry-run  # print only, no writes
 */

const API_URL = process.env.PAPERCLIP_API_URL;
const API_KEY = process.env.PAPERCLIP_API_KEY;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
const AGENT_ID = process.env.PAPERCLIP_AGENT_ID;
const RUN_ID = process.env.PAPERCLIP_RUN_ID;

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');

// Loop C parent issue (AUR-1395) and the SGI project.
const PARENT_IDENTIFIER = process.env.LOOP_C_PARENT || 'AUR-1395';
const PROJECT_ID = process.env.LOOP_C_PROJECT_ID || '593af91d-6e65-47fe-9db2-cd39469548f8';

const SCAN_LIMIT = 1000;

function headers() {
  return {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
    ...(RUN_ID ? { 'X-Paperclip-Run-Id': RUN_ID } : {}),
  };
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${API_URL}${path}`, { headers: headers(), ...opts });
  if (res.status === 404) return { _notFound: true };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${opts.method || 'GET'} ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

const asArray = (d, key) => (Array.isArray(d) ? d : (d && d[key]) || []);

async function fetchAllRecords() {
  // Paginate via offset until a short page is returned, deduping by record id
  // (offset paging can repeat a row if records are inserted mid-scan).
  // NOTE: this deployment's memory API caps `limit` at 1000, IGNORES `offset`,
  // and returns records newest-first with no cursor. Offset paging therefore
  // yields the SAME newest page every time — the old `page.length < SCAN_LIMIT`
  // break condition never fires once the corpus exceeds 1000, causing an
  // infinite loop. We instead stop as soon as a page adds ZERO new records
  // (dedup by id). This is correct for Loop C: records are newest-first and we
  // only ever need the 3 most-recent scorecards per bucket, all of which live
  // in the newest page. It also still terminates correctly if a future API
  // build starts honoring `offset`. Tracked as an infra gap (see retro/memory).
  const byId = new Map();
  let offset = 0;
  let guard = 0;
  for (;;) {
    const data = await apiFetch(
      `/api/companies/${COMPANY_ID}/memory/records?limit=${SCAN_LIMIT}&offset=${offset}`,
    );
    if (data._notFound) break;
    const page = asArray(data, 'records');
    let added = 0;
    for (const r of page) {
      const id = r.id ?? r._id ?? `${r.title}|${r.createdAt || r.created_at || ''}`;
      if (!byId.has(id)) { byId.set(id, r); added += 1; }
    }
    // Stop on a short page (offset honored, corpus exhausted) OR when a full
    // page contributed nothing new (offset ignored → same newest page again).
    if (page.length < SCAN_LIMIT) break;
    if (added === 0) break;
    offset += SCAN_LIMIT;
    if (++guard > 100) break; // hard backstop against any runaway
  }
  return [...byId.values()];
}

function parseTitle(title) {
  // performance/{agent_id}/{task_type}/{date}
  const parts = (title || '').split('/');
  if (parts.length >= 4 && parts[0] === 'performance') {
    return { agent_id: parts[1], task_type: parts[2] };
  }
  return { agent_id: null, task_type: null };
}

async function main() {
  for (const [k, v] of Object.entries({ API_URL, API_KEY, COMPANY_ID, AGENT_ID })) {
    if (!v) throw new Error(`Missing env ${k}`);
  }

  const records = await fetchAllRecords();
  const scorecards = records.filter((r) => {
    const m = r.metadata || {};
    if (m.category !== 'performance_scorecard') return false;
    if (m.outcome === 'blocked' || m.outcome === 'failed') return false;
    return (r.title || '').startsWith('performance/');
  });

  // Verification: paginated fetch should see the full corpus, not a capped 200.
  console.log(`Records fetched (deduped): ${records.length}, performance scorecards: ${scorecards.length}`);

  // Group into {agent_id}/{task_type} buckets.
  const buckets = new Map();
  for (const r of scorecards) {
    const m = r.metadata || {};
    const fromTitle = parseTitle(r.title);
    const agent_id = m.agent_id || fromTitle.agent_id;
    const task_type = m.task_type || fromTitle.task_type;
    if (!agent_id || !task_type) continue;
    const key = `${agent_id}/${task_type}`;
    if (!buckets.has(key)) buckets.set(key, { agent_id, task_type, recs: [] });
    buckets.get(key).recs.push({
      title: r.title,
      quality_signal: typeof m.quality_signal === 'number' ? m.quality_signal : null,
      rework_required: m.rework_required === true,
      createdAt: r.createdAt || r.created_at || '',
    });
  }

  // Resolve which agents still exist.
  const agentsData = await apiFetch(`/api/companies/${COMPANY_ID}/agents`);
  const liveAgents = new Set(asArray(agentsData, 'agents').map((a) => a.id));

  const triggered = [];
  const skippedNoAgent = [];
  let evaluated = 0;

  for (const [key, b] of buckets) {
    const recs = b.recs
      .slice()
      .sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)))
      .slice(0, 3);
    if (recs.length < 3) continue;
    evaluated += 1;

    const [r1, r2, r3] = recs; // r1 = most recent
    const q = recs.map((r) => r.quality_signal);
    const allQ = q.every((v) => typeof v === 'number');
    // Declining: most-recent should be lowest. r3 is oldest → q3 > q2 > q1.
    const declining = allQ && r3.quality_signal > r2.quality_signal && r2.quality_signal > r1.quality_signal;
    const reworkStreak = recs.every((r) => r.rework_required === true);

    if (!declining && !reworkStreak) continue;

    if (!liveAgents.has(b.agent_id)) {
      skippedNoAgent.push(key);
      continue;
    }

    const patternDesc = [
      declining ? `declining quality (oldest→newest: ${r3.quality_signal}→${r2.quality_signal}→${r1.quality_signal})` : null,
      reworkStreak ? 'rework required on all 3 most-recent runs' : null,
    ].filter(Boolean).join('; ');

    triggered.push({ key, ...b, recs, patternDesc });
  }

  console.log(`Buckets total: ${buckets.size}, evaluated (≥3 recs): ${evaluated}, triggered: ${triggered.length}`);
  for (const t of triggered) console.log(`  TRIGGER ${t.key} — ${t.patternDesc}`);
  if (skippedNoAgent.length) console.log(`  skipped (agent gone): ${skippedNoAgent.join(', ')}`);

  // Dedup: existing open self-edit issues.
  const openData = await apiFetch(
    `/api/companies/${COMPANY_ID}/issues?status=todo,in_progress,in_review,blocked&limit=200&q=${encodeURIComponent('self-edit required')}`,
  );
  const openIssues = asArray(openData, 'issues');

  // Resolve parent issue UUID.
  const parentData = await apiFetch(
    `/api/companies/${COMPANY_ID}/issues?identifier=${encodeURIComponent(PARENT_IDENTIFIER)}`,
  );
  const parentIssue = asArray(parentData, 'issues')[0];
  const parentId = parentIssue ? parentIssue.id : null;

  const created = [];
  const skippedExisting = [];

  for (const t of triggered) {
    const exists = openIssues.some((iss) => {
      const title = (iss.title || '');
      return title.includes('self-edit required') && title.includes(t.agent_id);
    });
    if (exists) {
      skippedExisting.push(t.key);
      continue;
    }

    const recList = t.recs
      .map((r, i) => `${i + 1}. \`${r.title}\` — quality=${r.quality_signal ?? 'n/a'}, rework=${r.rework_required}, ${r.createdAt}`)
      .join('\n');

    const description = [
      '## Self-Edit Triggered',
      '',
      `**Agent:** ${t.agent_id}`,
      `**Task type:** ${t.task_type}`,
      `**Pattern detected:** ${t.patternDesc}`,
      '',
      '### Scorecard streak (last 3):',
      recList,
      '',
      '---',
      '',
      '## What you must do in this heartbeat',
      '',
      'See **Section 13 of root `AGENTS.md`** for the complete self-edit protocol.',
      '',
      'TLDR:',
      '1. Read your `AGENTS.md` (your `instructions-path` file)',
      `2. Identify the section governing \`${t.task_type}\` work`,
      `3. POST a \`prompt-improvement-proposal/${t.agent_id}/{YYYY-MM-DD}\` memory record`,
      '4. POST a `request_board_approval` linking this issue',
      '5. Set this issue `in_review`, assigned to CEO',
      '',
      '**Safety boundary:** propose edits to YOUR file ONLY.',
    ].join('\n');

    const payload = {
      title: `Prompt self-edit required — ${t.agent_id} / ${t.task_type}`,
      description,
      assigneeAgentId: t.agent_id,
      projectId: PROJECT_ID,
      priority: 'high',
      ...(parentId ? { parentId } : {}),
    };

    if (DRY_RUN) {
      console.log(`  [dry-run] would create: ${payload.title}`);
      created.push({ ...t, identifier: '(dry-run)' });
      continue;
    }

    const res = await apiFetch(`/api/companies/${COMPANY_ID}/issues`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const iss = res.issue || res;
    created.push({ ...t, identifier: iss.identifier || iss.id, id: iss.id });
    console.log(`  created ${iss.identifier || iss.id}: ${payload.title}`);
  }

  // Emit a machine-readable summary for the calling heartbeat.
  console.log('\n=== SUMMARY JSON ===');
  console.log(JSON.stringify({
    evaluated,
    bucketsTotal: buckets.size,
    triggered: triggered.map((t) => ({ key: t.key, pattern: t.patternDesc })),
    created: created.map((c) => ({ key: c.key, identifier: c.identifier })),
    skippedExisting,
    skippedNoAgent,
    parentResolved: !!parentId,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
