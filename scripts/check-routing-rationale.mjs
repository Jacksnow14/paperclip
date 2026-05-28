#!/usr/bin/env node
/**
 * check-routing-rationale.mjs
 *
 * Detects high/critical priority issues that have an assigned agent but
 * are missing a routing/{issueId} rationale record in Paperclip Memory.
 *
 * Usage:
 *   node scripts/check-routing-rationale.mjs [--window-minutes N]
 *
 * Env vars required:
 *   PAPERCLIP_API_URL    Base URL (e.g. http://localhost:3000)
 *   PAPERCLIP_API_KEY    Bearer token
 *   PAPERCLIP_COMPANY_ID Company UUID
 *
 * Exit codes:
 *   0 — all high/critical assigned issues have routing records (clean)
 *   1 — one or more issues are missing routing records (flag)
 *   2 — configuration/API error
 */

import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    'window-minutes': { type: 'string', default: '60' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log('Usage: node scripts/check-routing-rationale.mjs [--window-minutes N]');
  console.log('  --window-minutes N  Only check issues updated in last N minutes (default: 60)');
  process.exit(0);
}

const API_URL = process.env.PAPERCLIP_API_URL;
const API_KEY = process.env.PAPERCLIP_API_KEY;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
const WINDOW_MINUTES = parseInt(args['window-minutes'], 10);

if (!API_URL || !API_KEY || !COMPANY_ID) {
  console.error('ERROR: PAPERCLIP_API_URL, PAPERCLIP_API_KEY, and PAPERCLIP_COMPANY_ID must be set.');
  process.exit(2);
}

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
};

async function apiGet(path) {
  const res = await fetch(`${API_URL}${path}`, { headers });
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function main() {
  const windowStart = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString();

  // Fetch all active assigned issues (API priority filter is not reliably enforced server-side)
  const issuesBatch = await apiGet(
    `/api/companies/${COMPANY_ID}/issues?status=todo,in_progress,in_review,blocked&limit=500`
  );
  const rawIssues = Array.isArray(issuesBatch) ? issuesBatch : (issuesBatch.issues ?? []);

  // Client-side: keep only high + critical, with an assignee, updated in the window
  const seen = new Set();
  const candidates = rawIssues.filter(issue => {
    if (!['high', 'critical'].includes(issue.priority)) return false;
    if (!issue.assigneeAgentId) return false;
    const key = issue.id ?? issue.identifier;
    if (seen.has(key)) return false;
    seen.add(key);
    const updated = issue.updatedAt ?? issue.assignedAt;
    if (!updated) return true; // include if no timestamp (conservative)
    return new Date(updated) >= new Date(windowStart);
  });

  if (candidates.length === 0) {
    console.log(`✓ No high/critical assigned issues updated in the last ${WINDOW_MINUTES} minutes.`);
    process.exit(0);
  }

  console.log(`Checking ${candidates.length} high/critical assigned issues for routing rationale records...\n`);

  // For each candidate, check if routing/{issueId} memory record exists
  const missing = [];
  const found = [];

  await Promise.all(candidates.map(async (issue) => {
    const id = issue.identifier ?? issue.id;
    const records = await apiGet(
      `/api/companies/${COMPANY_ID}/memory/records?titlePrefix=routing/${id}&limit=1`
    );
    const hasRecord = Array.isArray(records) ? records.length > 0 : false;
    if (hasRecord) {
      found.push(issue);
    } else {
      missing.push(issue);
    }
  }));

  if (found.length > 0) {
    console.log(`✓ ${found.length} issue(s) with routing rationale:`);
    for (const issue of found) {
      console.log(`  - ${issue.identifier ?? issue.id}: ${issue.title}`);
    }
    console.log();
  }

  if (missing.length === 0) {
    console.log('✓ All high/critical assigned issues have routing rationale records.');
    process.exit(0);
  }

  console.error(`⚠  ${missing.length} high/critical issue(s) MISSING routing rationale records:`);
  for (const issue of missing) {
    const assignee = issue.assigneeAgentId ?? 'unknown';
    console.error(`  - ${issue.identifier ?? issue.id} [${issue.priority}] → assignee: ${assignee}`);
    console.error(`    Title: ${issue.title}`);
    console.error(`    Missing record: routing/${issue.identifier ?? issue.id}`);
  }
  console.error();
  console.error('Routing rationale records must be captured by the manager that assigned these issues.');
  console.error('See AGENTS.md §12 for the convention and schema.');
  process.exit(1);
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(2);
});
