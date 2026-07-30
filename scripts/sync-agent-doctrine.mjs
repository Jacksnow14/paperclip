#!/usr/bin/env node
/**
 * sync-agent-doctrine.mjs
 *
 * Makes the routing-rationale doctrine (and the other canonical `doctrine/*.md`
 * blocks) self-propagating (AUR-4095). Paperclip has no include/transclusion
 * mechanism for instruction bundles (verified AUR-4089:
 * `server/src/services/agent-instructions.ts` injects exactly one file per
 * agent), so a doctrine block mirrored into an agent's AGENTS.md drifts unless
 * re-synced. This script reads every canonical `<!-- BEGIN:{slug} vN -->
 * ... <!-- END:{slug} -->` block under `--doctrine-dir` and syncs it into
 * every agent's resolved entry file.
 *
 * Target resolution goes through the read-only agent API
 * (`GET /agents/:id/instructions-bundle` → `resolvedEntryPath`), not a bare
 * filesystem scan of the managed directory, because some agents' bundles live
 * outside it (adapterConfig.instructionsRootPath/instructionsFilePath — e.g.
 * Content Manager and Video Editor live under /home/ievgen/vps_upload/agents).
 * Writes themselves are plain filesystem writes: `PATCH .../instructions-bundle`
 * requires a board actor (`assertCanManageInstructionsPath`), which an agent
 * API key can never satisfy — see `assertCanReadAgent` vs
 * `assertCanManageInstructionsPath` in server/src/routes/agents.ts.
 *
 * Tiering: a canonical block may be mirrored at two tiers — full text into
 * agents that act on it, and a short pointer stub into agents that merely need
 * to know it exists (see `doctrine/propagate.py`, POINTER_TIER_RATIO). An
 * existing block shorter than `--tier`-dependent thresholds is left alone by
 * default; pass `--tier all` to flatten every mirror to full text.
 *
 * Usage:
 *   node scripts/sync-agent-doctrine.mjs [--check] [--apply] [--tier safe|full|all]
 *                                        [--agent-id ID] [--doctrine-dir PATH]
 *                                        [--backup-dir PATH]
 *
 *   Without --check or --apply: dry-run — prints the plan, writes nothing, exit 0.
 *   --check:  read-only. Exits 1 and prints per-agent/per-slug drift if any
 *             bundle is missing or drifted from canon (stubs/skip-missing do
 *             not count as drift). Never writes, even if --apply is also passed.
 *   --apply:  backs up each changed bundle, then writes the synced contents.
 *
 * Env vars required:
 *   PAPERCLIP_API_URL    Base URL (e.g. http://localhost:3000)
 *   PAPERCLIP_API_KEY    Bearer token
 *   PAPERCLIP_COMPANY_ID Company UUID
 *
 * Exit codes:
 *   0 — clean, or dry-run/apply completed with nothing left to do
 *   1 — --check found drift or missing blocks (fix with a plain `--apply` run)
 *   2 — configuration/API/filesystem error
 */

import { parseArgs } from 'node:util';
import path from 'node:path';
import { resolveApiBase } from './lib/paperclip-api-base.mjs';
import { extractCanonicalBlock, applyAllBlocks } from './lib/doctrine-blocks.mjs';

const DEFAULT_DOCTRINE_DIR =
  '/home/ievgen/paperclip-data/instances/default/companies/b26d3647-3e6c-4a28-9c25-e9315696484d/doctrine';
const DEFAULT_BACKUP_DIR =
  '/home/ievgen/paperclip-data/backups/aur-4095-sync-agent-doctrine';

// ── Pure-ish helpers (I/O injected, so these are unit-testable) ──────────────

/**
 * Loads every canonical `{slug, block}` pair from `.md` files directly under
 * `doctrineDir`. Files with no line-anchored BEGIN/END marker (pure reference
 * notes with no fleet-wide mirroring obligation) are skipped, not errored —
 * `extractCanonicalBlock` throwing is the expected signal for "not a mirrored
 * doctrine file."
 */
export async function loadCanonicalBlocks(doctrineDir, { readdir, readFile }) {
  const files = (await readdir(doctrineDir)).filter(f => f.endsWith('.md')).sort();
  const blocks = [];
  const skipped = [];
  for (const file of files) {
    const raw = await readFile(path.join(doctrineDir, file), 'utf8');
    try {
      blocks.push({ ...extractCanonicalBlock(raw), sourceFile: file });
    } catch {
      skipped.push(file);
    }
  }
  return { blocks, skipped };
}

/**
 * Fetches every agent in the company and resolves each one's entry file via
 * the read-only `instructions-bundle` route. Agents whose bundle can't be
 * resolved (deleted/misconfigured) are dropped with a warning, not fatal.
 */
export async function discoverTargets(companyId, { apiGet, agentIdFilter } = {}) {
  const agentsResponse = await apiGet(`/api/companies/${companyId}/agents`);
  const agents = Array.isArray(agentsResponse) ? agentsResponse : agentsResponse.agents ?? [];
  const targets = [];
  const failures = [];
  for (const agent of agents) {
    if (agentIdFilter && agent.id !== agentIdFilter) continue;
    try {
      const bundle = await apiGet(`/api/agents/${agent.id}/instructions-bundle`);
      if (!bundle.resolvedEntryPath) {
        failures.push({ agentId: agent.id, name: agent.name, reason: 'no resolvedEntryPath' });
        continue;
      }
      targets.push({ agentId: agent.id, name: agent.name, entryPath: bundle.resolvedEntryPath });
    } catch (err) {
      failures.push({ agentId: agent.id, name: agent.name, reason: err.message });
    }
  }
  return { targets, failures };
}

/**
 * Diffs one target's on-disk AGENTS.md against every canonical block and
 * returns the plan: `{ verdicts: [{slug, verdict}], hasChanges, newContents }`.
 * `hasChanges` is true only when applying the plan would write something
 * different (drifted/missing under the given tier) — a stub or skip-missing
 * verdict never counts as a change.
 */
export function planTargetSync(contents, blocks, tier) {
  const { contents: newContents, results } = applyAllBlocks(contents, blocks, { tier });
  const hasChanges = results.some(r => r.verdict === 'drifted' || r.verdict === 'missing');
  return { verdicts: results, hasChanges, newContents };
}

/** True if any verdict in a plan represents real drift (not stub/skip-missing). */
export function planHasDrift(verdicts) {
  return verdicts.some(v => v.verdict === 'drifted' || v.verdict === 'missing');
}

// ── Main routine ──────────────────────────────────────────────────────────────

export async function main({
  check,
  apply,
  tier,
  doctrineDir,
  backupDir,
  agentId,
  apiUrl,
  apiKey,
  companyId,
  fsImpl,
}) {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  async function apiGet(p) {
    const res = await fetch(`${apiUrl}${p}`, { headers });
    if (!res.ok) throw new Error(`GET ${p} → ${res.status} ${res.statusText}`);
    return res.json();
  }

  const { blocks, skipped } = await loadCanonicalBlocks(doctrineDir, fsImpl);
  if (blocks.length === 0) {
    console.error(`ERROR: no canonical doctrine blocks found under ${doctrineDir}`);
    return 2;
  }
  console.log(`Canonical blocks (${blocks.length}): ${blocks.map(b => b.slug).join(', ')}`);
  if (skipped.length > 0) {
    console.log(`Skipped (no BEGIN/END marker): ${skipped.join(', ')}`);
  }

  const { targets, failures } = await discoverTargets(companyId, { apiGet, agentIdFilter: agentId });
  if (failures.length > 0) {
    for (const f of failures) console.log(`WARN: could not resolve bundle for ${f.name ?? f.agentId}: ${f.reason}`);
  }
  if (targets.length === 0) {
    console.error('ERROR: no agent targets resolved.');
    return 2;
  }

  let driftedAgents = 0;
  let changedAgents = 0;
  let writeFailures = 0;

  for (const target of targets) {
    let contents;
    try {
      contents = await fsImpl.readFile(target.entryPath, 'utf8');
    } catch (err) {
      console.log(`WARN: cannot read ${target.name} (${target.entryPath}): ${err.message}`);
      continue;
    }

    const plan = planTargetSync(contents, blocks, tier);
    const drift = plan.verdicts.filter(v => v.verdict === 'drifted' || v.verdict === 'missing');

    if (drift.length > 0) {
      driftedAgents++;
      for (const d of drift) {
        console.log(`${check ? 'DRIFT' : 'PLAN'}: ${target.name} (${target.agentId}) — ${d.slug}: ${d.verdict}`);
      }
    }

    if (check) continue;

    if (!plan.hasChanges) continue;

    if (!apply) {
      console.log(`[DRY-RUN] Would update ${target.name}: ${JSON.stringify(drift)}`);
      changedAgents++;
      continue;
    }

    try {
      const backupPath = path.join(backupDir, target.agentId, `AGENTS.md.${Date.now()}.bak`);
      await fsImpl.mkdir(path.dirname(backupPath), { recursive: true });
      await fsImpl.writeFile(backupPath, contents, 'utf8');
      await fsImpl.writeFile(target.entryPath, plan.newContents, 'utf8');
      console.log(`APPLIED: ${target.name} (${target.agentId}) — backup at ${backupPath}`);
      changedAgents++;
    } catch (err) {
      writeFailures++;
      console.log(`ERROR: failed to write ${target.name} (${target.agentId}): ${err.message}`);
    }
  }

  console.log('── Summary ──');
  console.log(`Targets: ${targets.length}, drifted/missing: ${driftedAgents}, changed: ${changedAgents}, write failures: ${writeFailures}`);

  if (check) {
    return driftedAgents > 0 ? 1 : 0;
  }
  if (writeFailures > 0) return 2;
  if (!apply && changedAgents > 0) {
    console.log('\n[DRY-RUN] Pass --apply to write the above changes.');
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
      check: { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      tier: { type: 'string', default: 'safe' },
      'agent-id': { type: 'string' },
      'doctrine-dir': { type: 'string', default: DEFAULT_DOCTRINE_DIR },
      'backup-dir': { type: 'string', default: DEFAULT_BACKUP_DIR },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (args.help) {
    console.log('Usage: node scripts/sync-agent-doctrine.mjs [--check] [--apply] [--tier safe|full|all] [--agent-id ID] [--doctrine-dir PATH] [--backup-dir PATH]');
    console.log('  --check         Read-only. Exit 1 if any bundle is drifted/missing a canonical block.');
    console.log('  --apply         Back up then write synced contents (default: dry-run plan only).');
    console.log('  --tier T        safe (default): append missing, replace full-tier drift, skip stubs.');
    console.log('                  full: only replace existing full-tier blocks. all: overwrite everything.');
    console.log('  --agent-id ID   Limit to a single agent (for testing/repair of one bundle).');
    process.exit(0);
  }

  if (!['safe', 'full', 'all'].includes(args.tier)) {
    console.error(`ERROR: --tier must be one of safe|full|all, got "${args.tier}"`);
    process.exit(2);
  }

  const API_KEY = process.env.PAPERCLIP_API_KEY;
  const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;

  if (!API_KEY || !COMPANY_ID) {
    console.error('ERROR: PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID must be set.');
    process.exit(2);
  }

  const fs = await import('node:fs/promises');

  resolveApiBase().then(API_URL => main({
    check: args.check,
    apply: args.apply,
    tier: args.tier,
    doctrineDir: args['doctrine-dir'],
    backupDir: args['backup-dir'],
    agentId: args['agent-id'],
    apiUrl: API_URL,
    apiKey: API_KEY,
    companyId: COMPANY_ID,
    fsImpl: fs,
  })).then(code => process.exit(code)).catch(err => {
    console.error('FATAL:', err.message);
    process.exit(2);
  });
}
