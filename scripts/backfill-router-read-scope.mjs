#!/usr/bin/env node
/**
 * backfill-router-read-scope.mjs (AUR-3925)
 *
 * Router-read memory classes — `routing/*` (routing_rationale), `performance/*`
 * (performance_scorecard), `scorecard-adjusted/*` (scorecard_adjusted) — are
 * queried ORG-WIDE by titlePrefix sweeps (the routing-rationale watchdog,
 * scorecard-based routing decisions). An agent-authenticated GET
 * /memory/records query only returns project-scoped records when the caller
 * passes an explicit `?projectId=`, so a record captured with `scope.projectId`
 * set is invisible to every org-wide sweep — it exists, but no watchdog or
 * routing query will ever see it (the AUR-3849 failure class).
 *
 * This script:
 *   1. Enumerates every project in the company (an agent-authenticated org
 *      query can't discover project-scoped records without already knowing
 *      the project id — see buildLocalBasicConditions in services/memory.ts).
 *   2. For each project x each router-read title prefix, lists the
 *      project-scoped records under that prefix.
 *   3. For every hit whose metadata.category is a router-read category,
 *      re-captures the SAME content org-wide (no scope/scopeType), preserving
 *      the project id in metadata.project_id and a back-reference in
 *      metadata.backfilled_from_record_id.
 *
 * The project-scoped originals are NEVER deleted, revoked, or modified —
 * `promote` (which supersedes-in-place) is board-only (assertBoard) and not
 * reachable by an agent actor, so this script always re-captures instead.
 *
 * Idempotent: before capturing a backfill, it checks for an existing org-wide
 * record with the same exact title carrying
 * metadata.backfilled_from_record_id === <original id>, and skips if found.
 * Safe to re-run.
 *
 * Usage:
 *   node scripts/backfill-router-read-scope.mjs [--apply] [--project-id UUID]
 *
 *   Without --apply: dry-run — prints every invisible record found and the
 *                     backfill it would create, writes nothing.
 *   With --apply:    executes the backfill captures (idempotent).
 *   --project-id:    restrict the sweep to a single project (default: all).
 *
 * Env vars required:
 *   PAPERCLIP_API_URL    Base URL (e.g. http://localhost:3000)
 *   PAPERCLIP_API_KEY    Bearer token
 *   PAPERCLIP_COMPANY_ID Company UUID
 *
 * Exit codes:
 *   0 — clean (no invisible records found, or all pending backfills applied —
 *       a partial run where SOME mutations failed still exits 0; see Failed)
 *   1 — dry-run with pending backfills (pass --apply to execute)
 *   2 — configuration/API error
 *   4 — every intended mutation this run failed
 */

import { parseArgs } from 'node:util';
import { resolveApiBase } from './lib/paperclip-api-base.mjs';

// ── Router-read category → title prefix map (AUR-3925) ─────────────────────
//
// These are the ONLY categories this script treats as router-read/org-wide.
// Project-local insight records (`retrospective/*`, `lesson`, etc.) are
// intentionally excluded — they are meant to stay project-scoped and must
// NOT be swept up by this backfill.
export const ROUTER_READ_CATEGORY_PREFIXES = {
  routing_rationale: 'routing/',
  performance_scorecard: 'performance/',
  scorecard_adjusted: 'scorecard-adjusted/',
};

export const RECORD_LIST_LIMIT = 1000;

function extractRecords(response) {
  return Array.isArray(response) ? response : (response?.records ?? []);
}

// ── Discovery ────────────────────────────────────────────────────────────────

/**
 * Fetch every project-scoped record under `prefix` for one project,
 * paginating past RECORD_LIST_LIMIT if needed, then filter to records whose
 * metadata.category matches `category` (a titlePrefix match alone isn't
 * enough — the prefix convention is a human naming convention, not a
 * server-enforced contract, so a stray record with a colliding title but a
 * different category must not be swept up).
 */
export async function fetchProjectScopedRouterReadRecords({ companyId, projectId, category, prefix, apiGet }) {
  const hits = [];
  let offset = 0;
  for (;;) {
    const res = await apiGet(
      `/api/companies/${companyId}/memory/records?titlePrefix=${encodeURIComponent(prefix)}&projectId=${projectId}&limit=${RECORD_LIST_LIMIT}&offset=${offset}`,
    );
    const records = extractRecords(res);
    for (const record of records) {
      if (record.metadata?.category === category) hits.push(record);
    }
    if (records.length < RECORD_LIST_LIMIT) break;
    offset += RECORD_LIST_LIMIT;
  }
  return hits;
}

/**
 * True if an org-wide backfill for `original` already exists (idempotency
 * guard). Matches on metadata.backfilled_from_record_id === original.id
 * rather than title alone, since a title collision under the same prefix
 * (two different originals sharing a title) must not be mistaken for "already
 * backfilled".
 */
export async function alreadyBackfilled({ companyId, original, apiGet }) {
  if (!original.title) return false;
  const res = await apiGet(
    `/api/companies/${companyId}/memory/records?titlePrefix=${encodeURIComponent(original.title)}&limit=50`,
  );
  const records = extractRecords(res);
  return records.some(
    (r) => r.title === original.title && r.metadata?.backfilled_from_record_id === original.id,
  );
}

/**
 * Builds the org-wide capture payload for a backfill of `original`. No
 * scope/scopeType is set — omitting both is what makes the resulting record
 * org-wide and therefore visible to titlePrefix sweeps run without a
 * projectId.
 */
export function buildBackfillPayload(original, projectId) {
  if (!original.title) {
    throw new Error(`record ${original.id} has no title — cannot safely backfill (title is the dedupe key)`);
  }
  return {
    title: original.title,
    content: original.content,
    summary: original.summary ?? undefined,
    metadata: {
      ...(original.metadata ?? {}),
      project_id: projectId,
      backfilled_from_record_id: original.id,
      backfilled_reason: 'AUR-3925: router-read category was project-scoped and invisible to org-wide sweeps',
    },
    source: original.source ?? { kind: 'manual_note' },
    owner: original.owner ?? undefined,
    sensitivityLabel: original.sensitivityLabel ?? undefined,
    citation: original.citation ?? undefined,
  };
}

// ── API helpers ───────────────────────────────────────────────────────────────

function makeApiHelpers(API_URL, headers) {
  async function apiGet(path) {
    const res = await fetch(`${API_URL}${path}`, { headers });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
    return res.json();
  }

  async function apiPost(path, body) {
    const res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`POST ${path} → ${res.status} ${res.statusText} ${text}`);
    }
    return res.json();
  }

  return { apiGet, apiPost };
}

function extractStatusCode(errorMessage) {
  const match = /→\s*(\d+)/.exec(errorMessage ?? '');
  return match ? match[1] : 'unknown';
}

async function runMutation(label, fn, failures) {
  try {
    await fn();
    return true;
  } catch (err) {
    const status = extractStatusCode(err.message);
    console.error(`    FAILED (${status}): ${label} — ${err.message}`);
    failures.push({ label, status, message: err.message });
    return false;
  }
}

// ── Main routine ──────────────────────────────────────────────────────────────

export async function main({ apply, apiUrl, apiKey, companyId, onlyProjectId }) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const { apiGet, apiPost } = makeApiHelpers(apiUrl, headers);

  if (!apply) {
    console.log('[DRY-RUN] No changes will be written. Pass --apply to execute.\n');
  }

  const projectsRes = await apiGet(`/api/companies/${companyId}/projects`);
  const allProjects = Array.isArray(projectsRes) ? projectsRes : (projectsRes?.projects ?? []);
  const projects = onlyProjectId ? allProjects.filter((p) => p.id === onlyProjectId) : allProjects;

  console.log(`Scanning ${projects.length} project(s) x ${Object.keys(ROUTER_READ_CATEGORY_PREFIXES).length} router-read categories...\n`);

  const invisible = []; // { project, category, prefix, record }
  const alreadyDone = [];
  const noTitle = [];

  for (const project of projects) {
    for (const [category, prefix] of Object.entries(ROUTER_READ_CATEGORY_PREFIXES)) {
      const hits = await fetchProjectScopedRouterReadRecords({
        companyId, projectId: project.id, category, prefix, apiGet,
      });
      for (const record of hits) {
        if (!record.title) {
          noTitle.push({ project, category, record });
          continue;
        }
        const done = await alreadyBackfilled({ companyId, original: record, apiGet });
        if (done) {
          alreadyDone.push({ project, category, record });
        } else {
          invisible.push({ project, category, prefix, record });
        }
      }
    }
  }

  if (noTitle.length > 0) {
    console.log(`  SKIPPED — no title, cannot safely dedupe/backfill (${noTitle.length}):`);
    for (const { project, category, record } of noTitle) {
      console.log(`    - ${record.id} [${category}] in project ${project.id} (${project.name ?? ''})`);
    }
    console.log();
  }

  if (alreadyDone.length > 0) {
    console.log(`  ALREADY BACKFILLED (${alreadyDone.length}):`);
    for (const { project, record } of alreadyDone) {
      console.log(`    - ${record.title} (project ${project.id})`);
    }
    console.log();
  }

  if (invisible.length === 0) {
    console.log('No invisible router-read records found across all scanned projects. 0 to backfill.\n');
  } else {
    console.log(`INVISIBLE — project-scoped router-read records with no org-wide copy (${invisible.length}):`);
    for (const { project, category, record } of invisible) {
      console.log(`    - [${category}] "${record.title}" (id ${record.id}, project ${project.id} / ${project.name ?? ''})`);
    }
    console.log();
  }

  const failedMutations = [];
  let backfilled = 0;

  if (apply && invisible.length > 0) {
    console.log('── Applying backfills ──');
    for (const { project, record } of invisible) {
      const payload = buildBackfillPayload(record, project.id);
      const ok = await runMutation(
        `backfill "${record.title}" (from ${record.id})`,
        async () => {
          await apiPost(`/api/companies/${companyId}/memory/capture`, payload);
        },
        failedMutations,
      );
      if (ok) {
        backfilled += 1;
        console.log(`    → backfilled org-wide: "${record.title}"`);
      }
    }
    console.log();
  }

  console.log('── Summary ──');
  console.log(`  Projects scanned:      ${projects.length}`);
  console.log(`  Invisible found:       ${invisible.length}`);
  console.log(`  Already backfilled:    ${alreadyDone.length}`);
  console.log(`  Skipped (no title):    ${noTitle.length}`);
  console.log(`  Backfilled this run:   ${backfilled}`);
  console.log(`  Failed:                ${failedMutations.length}`);
  if (failedMutations.length > 0) {
    for (const { label, status } of failedMutations) {
      console.log(`    - ${label} → ${status}`);
    }
    console.log('  Re-run with --apply to retry the above (idempotent).');
  }

  if (!apply && invisible.length > 0) {
    console.log('\n[DRY-RUN] Pass --apply to execute the above backfills.');
    return 1;
  }

  if (invisible.length > 0 && failedMutations.length === invisible.length) {
    console.log('\nERROR: every intended backfill failed this run — see Failed list above.');
    return 4;
  }

  return 0;
}

// ── Entry point ───────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url.endsWith(
  process.argv[1].replace(/\\/g, '/').split('/').pop()
);

if (isMain) {
  const { values: args } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      'project-id': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (args.help) {
    console.log('Usage: node scripts/backfill-router-read-scope.mjs [--apply] [--project-id UUID]');
    console.log('  --apply        Execute changes (default: dry-run, exit 1 if backfills pending)');
    console.log('  --project-id   Restrict the sweep to a single project (default: all projects)');
    process.exit(0);
  }

  const API_KEY = process.env.PAPERCLIP_API_KEY;
  const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;

  if (!API_KEY || !COMPANY_ID) {
    console.error('ERROR: PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID must be set.');
    process.exit(2);
  }

  resolveApiBase().then((API_URL) => main({
    apply: args.apply,
    apiUrl: API_URL,
    apiKey: API_KEY,
    companyId: COMPANY_ID,
    onlyProjectId: args['project-id'],
  })).then((code) => process.exit(code)).catch((err) => {
    console.error('FATAL:', err.message);
    process.exit(2);
  });
}
