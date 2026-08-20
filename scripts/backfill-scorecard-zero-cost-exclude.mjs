#!/usr/bin/env node
/**
 * Backfill exclude_from_aggregates/metrics_lost on pre-fix zero-cost scorecard rows (AUR-5410).
 *
 * Background:
 *   Before AUR-5410, `buildCloseTimeScorecardCaptures()` clamped an unmeasured
 *   `token_cost: 0` close to a divisor of 1, so every unmeasured close scored
 *   `score_adjusted: 9.0` — the single best score obtainable in the registry.
 *   The fix (server/src/services/close-time-scorecard.ts) stops writing new
 *   corrupt rows, but the existing ones are still live in the registry and
 *   still poison routing/ROI/retire reads that don't know to skip them.
 *
 *   Per the scorecard-title-schema doctrine's no-backfill rule, these rows are
 *   MARKED, not rewritten: we never fabricate a token count for a close that
 *   was never measured. This script only ever adds
 *   `metadata.exclude_from_aggregates: true` + `metadata.metrics_lost: true`
 *   via PATCH (which merges metadata) — it never touches token_cost,
 *   score_adjusted, or any other field.
 *
 * Permission boundary (discovered while writing this script):
 *   PATCH /memory/records/:id restricts performance_scorecard and
 *   scorecard_adjusted to the record's OWNER agent (server/src/routes/memory.ts,
 *   AGENT_MUTABLE_CATEGORIES minus SHARED_CONTRIBUTOR_CATEGORIES) — there is no
 *   agent-level bulk/admin path. This script can only patch rows owned by the
 *   agent whose PAPERCLIP_API_KEY it runs with. It reports (but cannot patch)
 *   corrupt rows owned by other agents, broken down by owner, so each owning
 *   agent can run this same script themselves.
 *
 * Usage:
 *   node scripts/backfill-scorecard-zero-cost-exclude.mjs            # dry-run, report only
 *   node scripts/backfill-scorecard-zero-cost-exclude.mjs --apply    # patch this agent's own corrupt rows
 *   node scripts/backfill-scorecard-zero-cost-exclude.mjs --verify   # exit 1 if any UNOWNED-by-me corrupt rows remain company-wide
 */

import { resolveApiBase } from './lib/paperclip-api-base.mjs';

const API_KEY = process.env.PAPERCLIP_API_KEY;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
const AGENT_ID = process.env.PAPERCLIP_AGENT_ID;

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const VERIFY_MODE = argv.includes('--verify');

async function apiGet(path) {
  const base = await resolveApiBase();
  const r = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
  });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}: ${await r.text()}`);
  return r.json();
}

async function apiPatch(path, body) {
  const base = await resolveApiBase();
  const r = await fetch(`${base}${path}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PATCH ${path} -> ${r.status}: ${await r.text()}`);
  return r.json();
}

async function fetchAllByPrefix(titlePrefix) {
  const out = [];
  let offset = 0;
  const limit = 1000;
  for (;;) {
    const res = await apiGet(
      `/api/companies/${COMPANY_ID}/memory/records?titlePrefix=${encodeURIComponent(titlePrefix)}&limit=${limit}&offset=${offset}`,
    );
    const rows = Array.isArray(res) ? res : res.records ?? res.data ?? [];
    out.push(...rows);
    if (rows.length < limit) break;
    offset += limit;
    if (offset > 50000) {
      console.error('safety cap (50000) hit while paging — stopping early');
      break;
    }
  }
  return out;
}

function isCorrupt(r) {
  const m = r.metadata || {};
  if (m.exclude_from_aggregates === true || m.metrics_lost === true) return false; // already flagged
  return Number(m.token_cost) === 0 && (m.category === 'performance_scorecard' || m.category === 'scorecard_adjusted');
}

async function main() {
  if (!API_KEY || !COMPANY_ID || !AGENT_ID) {
    console.error('ERROR: PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID, and PAPERCLIP_AGENT_ID must be set');
    process.exit(1);
  }

  console.log('AUR-5410 Zero-Cost Scorecard Backfill Sweep');
  console.log('============================================');
  console.log(`Company: ${COMPANY_ID}`);
  console.log(`Running as agent: ${AGENT_ID}`);
  console.log(`Mode: ${APPLY ? 'APPLY (patch own rows)' : VERIFY_MODE ? 'VERIFY' : 'DRY-RUN (report only)'}`);
  console.log('');

  console.log('Fetching performance/* and scorecard-adjusted/* records...');
  const [perf, adj] = await Promise.all([
    fetchAllByPrefix('performance/'),
    fetchAllByPrefix('scorecard-adjusted/'),
  ]);
  console.log(`  performance/*: ${perf.length} total`);
  console.log(`  scorecard-adjusted/*: ${adj.length} total`);
  console.log('');

  const corrupt = [...perf, ...adj].filter(isCorrupt);
  console.log(`Corrupt (token_cost: 0, unflagged) rows company-wide: ${corrupt.length}`);

  const byOwner = new Map();
  for (const r of corrupt) {
    const oid = r.owner?.type === 'agent' ? r.owner.id : 'non-agent-owner';
    byOwner.set(oid, (byOwner.get(oid) || 0) + 1);
  }
  console.log('By owner:');
  for (const [oid, count] of byOwner) {
    console.log(`  ${oid}${oid === AGENT_ID ? '  <- me' : ''}: ${count}`);
  }
  console.log('');

  const mine = corrupt.filter((r) => r.owner?.type === 'agent' && r.owner.id === AGENT_ID);
  const othersCount = corrupt.length - mine.length;
  console.log(`Patchable by this run (owned by me): ${mine.length}`);
  console.log(`Requires the owning agent to self-run this script: ${othersCount}`);
  console.log('');

  if (VERIFY_MODE) {
    if (mine.length > 0) {
      console.error(`VERIFICATION FAILED: ${mine.length} of my own corrupt rows are still unflagged. Run with --apply.`);
      process.exit(1);
    }
    console.log('VERIFICATION PASSED: none of my own corrupt rows remain unflagged.');
    if (othersCount > 0) {
      console.log(`NOTE: ${othersCount} corrupt rows owned by other agents remain — this run cannot patch them.`);
    }
    return;
  }

  if (!APPLY) {
    console.log('Dry run only — no writes made. Re-run with --apply to patch this agent\'s own rows.');
    return;
  }

  console.log(`Patching ${mine.length} own rows...`);
  let patched = 0;
  let failed = 0;
  for (const r of mine) {
    try {
      await apiPatch(`/api/companies/${COMPANY_ID}/memory/records/${r.id}`, {
        metadata: { exclude_from_aggregates: true, metrics_lost: true },
      });
      patched += 1;
    } catch (e) {
      failed += 1;
      console.error(`  FAILED ${r.id} (${r.title}): ${e.message}`);
    }
  }
  console.log('');
  console.log(`Patched: ${patched}`);
  console.log(`Failed: ${failed}`);
  console.log('');
  console.log('Summary for issue thread:');
  console.log(`  Corrupt rows company-wide (before this run): ${corrupt.length}`);
  console.log(`  Patched by this run (own rows): ${patched}`);
  console.log(`  Remaining, owned by other agents (need their own --apply run): ${othersCount}`);
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
