#!/usr/bin/env node
/**
 * Backfill tombstones for historically deleted issues referenced by live scorecards (AUR-4508).
 *
 * Background:
 *   PR #142 (aur-4091-registry-referential-integrity) added `issue_tombstones` and taught the
 *   memory-capture guard to resolve issue_id against tombstones for deleted issues. It only
 *   creates tombstones going forward (at delete time). This script handles the historical gap:
 *   scorecards that reference issue_ids which no longer resolve to a live issue and have no
 *   tombstone yet.
 *
 * What this script does:
 *   1. Sweeps all live scorecards (performance_scorecard + scorecard_adjusted) whose
 *      metadata.issue_id is present.
 *   2. For each, asks the Paperclip API to resolve the issue_id (which now checks
 *      live issues AND tombstones).
 *   3. Identifies any that still can't resolve — these are the gap candidates.
 *   4. Reports them. We cannot fabricate tombstones for issues that never existed, so
 *      any truly unresolvable issue_id must be reviewed manually.
 *
 * Pre-conditions:
 *   - PR #142 must be MERGED (issue_tombstones table must exist in the running DB).
 *   - PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID must be set.
 *
 * Usage:
 *   node scripts/backfill-scorecard-tombstones.mjs            # dry-run, report only
 *   node scripts/backfill-scorecard-tombstones.mjs --verify   # post-backfill verification mode
 *
 * Verification mode (--verify):
 *   Runs the sweep and exits 0 if the orphaned count is 0, exits 1 otherwise.
 *   Use this as a post-deployment gate.
 */

import { resolveApiBase } from './lib/paperclip-api-base.mjs';

const API_KEY = process.env.PAPERCLIP_API_KEY;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;

const argv = process.argv.slice(2);
const VERIFY_MODE = argv.includes('--verify');

async function apiGet(path) {
  const base = await resolveApiBase();
  const r = await fetch(`${base}${path}`, {
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
  });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function fetchAllScorecards() {
  const categories = ['performance_scorecard', 'scorecard_adjusted'];
  const records = [];
  for (const category of categories) {
    let offset = 0;
    const limit = 100;
    while (true) {
      const res = await apiGet(
        `/api/companies/${COMPANY_ID}/memory/records?category=${category}&limit=${limit}&offset=${offset}`
      );
      const batch = res.records ?? res ?? [];
      records.push(...batch);
      if (batch.length < limit) break;
      offset += limit;
    }
  }
  return records;
}

async function resolveIssueId(issueId) {
  // The memory capture endpoint validates issue_id during a capture attempt,
  // but we can also check directly via the issues API.
  // Try identifier lookup first, then UUID.
  try {
    const res = await apiGet(`/api/companies/${COMPANY_ID}/issues?search=${encodeURIComponent(issueId)}&limit=5`);
    const issues = res.issues ?? res ?? [];
    const match = issues.find(i => i.identifier === issueId || i.id === issueId);
    if (match) return { resolved: true, via: 'live_issue', issueId: match.id };
  } catch (_) {}

  // Check tombstones — GET /api/companies/:companyId/issues/tombstones/:identifier
  try {
    const res = await apiGet(`/api/companies/${COMPANY_ID}/issues/tombstones/${encodeURIComponent(issueId)}`);
    if (res && res.issueId) return { resolved: true, via: 'tombstone', issueId: res.issueId };
  } catch (e) {
    if (!e.message.includes('404')) throw e;
  }

  return { resolved: false, via: null, issueId: issueId };
}

async function main() {
  if (!API_KEY || !COMPANY_ID) {
    console.error('ERROR: PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID must be set');
    process.exit(1);
  }

  console.log('AUR-4508 Scorecard Tombstone Backfill Sweep');
  console.log('===========================================');
  console.log(`Company: ${COMPANY_ID}`);
  console.log(`Mode: ${VERIFY_MODE ? 'VERIFY (exit non-zero if any orphaned)' : 'DRY-RUN (report only)'}`);
  console.log('');

  console.log('Step 1: Fetching all live scorecards with issue_id...');
  const allRecords = await fetchAllScorecards();
  const withIssueId = allRecords.filter(r => r.metadata?.issue_id);
  console.log(`  Total scorecards: ${allRecords.length}`);
  console.log(`  With issue_id field: ${withIssueId.length}`);
  console.log('');

  if (withIssueId.length === 0) {
    console.log('No scorecards have issue_id. Nothing to sweep.');
    process.exit(0);
  }

  console.log('Step 2: Resolving each issue_id against live issues + tombstones...');
  const orphaned = [];
  const resolved = [];

  for (const record of withIssueId) {
    const issueId = record.metadata.issue_id;
    const result = await resolveIssueId(issueId);
    if (result.resolved) {
      resolved.push({ record, result });
    } else {
      orphaned.push({ record, issueId });
    }
  }

  console.log(`  Resolved: ${resolved.length}`);
  console.log(`  Orphaned (unresolvable): ${orphaned.length}`);
  console.log('');

  if (orphaned.length > 0) {
    console.log('ORPHANED SCORECARDS (issue_id resolves to neither live issue nor tombstone):');
    for (const { record, issueId } of orphaned) {
      console.log(`  - ${record.title} | issue_id=${issueId} | record_id=${record.id}`);
    }
    console.log('');
    console.log('ACTION NEEDED: These scorecards reference issue_ids that are unresolvable.');
    console.log('Options:');
    console.log('  a) If the issue was genuinely deleted, insert a tombstone row directly via DB.');
    console.log('  b) If the issue_id is fabricated/erroneous, the scorecard is invalid.');
    console.log('  c) Review each case manually and take targeted action.');
    console.log('');
    console.log('Tombstone insert SQL (run for each known-real deleted issue):');
    console.log("  INSERT INTO issue_tombstones (id, company_id, issue_id, identifier, title, deleted_at)");
    console.log("  VALUES (gen_random_uuid(), '<company_uuid>', '<issue_uuid>', '<AUR-NNNN>', '<title>', now())");
    console.log("  ON CONFLICT DO NOTHING;");

    if (VERIFY_MODE) {
      console.error('\nVERIFICATION FAILED: orphaned_count=' + orphaned.length);
      process.exit(1);
    }
  } else {
    console.log('✓ SWEEP CLEAN: All scorecards with issue_id resolve to a live issue or tombstone.');
    console.log('  No backfill rows are needed.');
    if (VERIFY_MODE) {
      console.log('\nVERIFICATION PASSED: orphaned_count=0');
    }
  }

  // Summary table for issue thread
  console.log('');
  console.log('Summary for issue thread:');
  console.log(`  Before sweep (live-issue check only): ${withIssueId.length} scorecards with issue_id`);
  console.log(`  Orphaned after full resolution (live+tombstone): ${orphaned.length}`);
  console.log(`  Backfill rows inserted: 0 (all already resolve or are unresolvable)`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
