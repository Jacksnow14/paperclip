#!/usr/bin/env node
/**
 * Daily fleet model refresh (founder directive 2026-08-06).
 *
 * Keeps the fleet on the newest models without a human noticing releases:
 *   1. Updates the claude and codex CLIs (explicit, once daily, in the quiet
 *      morning window — the in-run autoupdater stays DISABLED because
 *      mid-flight version swaps caused the :00/:30 PATH races of 2026-07-06).
 *   2. Discovers newly released models by GROUND-TRUTH PROBE: generates
 *      version-bump candidates from the adapter catalogs (fable-5 → fable-6,
 *      opus-4-8 → opus-4-9/opus-5, gpt-5.5 → gpt-5.6/gpt-6 …) and runs a
 *      one-token live invocation for each unknown candidate. A model is
 *      "available" only if the provider actually serves it — never because a
 *      name pattern exists. Verdicts are cached; known-bad candidates are
 *      re-probed only after PROBE_TTL_DAYS, so an ordinary morning costs ~$0
 *      and a handful of cents at most when a release lands.
 *   3. Applies the model policy (scripts/fleet-model-policy.json — data, not
 *      code): CEO always on the frontier model at highest effort, Claude Code
 *      Max always on the latest fable, everyone else newest version within
 *      their current family/tier. Changes go through PATCH /agents/:id so the
 *      AUR-4689 config-time model validation gates every write.
 *   4. Budget-friendly judgment: the LLM part (re-evaluating effort and
 *      system prompts against each agent's actual task mix) is NOT run daily
 *      — it is dispatched as ONE issue to the reviewer agent, only when the
 *      model set changed or every `tuning.minDaysBetween` days.
 *
 * Exit codes: 0 = refreshed · 2 = could not measure/apply (loud; an
 * unreachable refresher must never read as "fleet is current").
 *
 * Requires: PAPERCLIP_API_KEY + PAPERCLIP_COMPANY_ID (same env file as the
 * PR dispatcher), `claude` and `codex` CLIs on PATH.
 *
 * Usage:
 *   node scripts/fleet-model-refresh.mjs [--dry-run] [--skip-cli-update]
 *     [--policy PATH] [--state-dir DIR] [--api-base URL] [--alert-cmd PATH]
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const DAY_MS = 24 * 60 * 60 * 1000;
const PROBE_TTL_DAYS = 7;

// ---------- pure: model id parsing and ranking ----------

const CLAUDE_FAMILY_RANK = { fable: 4, opus: 3, sonnet: 2, haiku: 1 };

/** claude-fable-5 → {family:'fable', ver:[5]}; claude-opus-4-8 → {family:'opus', ver:[4,8]} */
export function parseClaudeId(id) {
  const m = /^claude-([a-z]+)-(\d+(?:[-.]\d+)*)$/.exec(id ?? '');
  if (!m || !(m[1] in CLAUDE_FAMILY_RANK)) return null;
  return { family: m[1], ver: m[2].split(/[-.]/).map(Number) };
}

/** gpt-5.5 → {ver:[5,5], tier:'full'}; gpt-5.4-mini → {ver:[5,4], tier:'mini'} */
export function parseCodexId(id) {
  const m = /^gpt-(\d+(?:\.\d+)*)(?:-(mini|nano))?$/.exec(id ?? '');
  if (!m) return null;
  return { ver: m[1].split('.').map(Number), tier: m[2] ?? 'full' };
}

export function cmpVer(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Highest-ranked claude model overall: family rank first, then version. */
export function bestClaude(ids) {
  const parsed = ids.map((id) => ({ id, p: parseClaudeId(id) })).filter((x) => x.p);
  parsed.sort(
    (a, b) =>
      CLAUDE_FAMILY_RANK[b.p.family] - CLAUDE_FAMILY_RANK[a.p.family] || cmpVer(b.p.ver, a.p.ver),
  );
  return parsed[0]?.id ?? null;
}

export function latestClaudeFamily(ids, family) {
  const parsed = ids
    .map((id) => ({ id, p: parseClaudeId(id) }))
    .filter((x) => x.p && x.p.family === family);
  parsed.sort((a, b) => cmpVer(b.p.ver, a.p.ver));
  return parsed[0]?.id ?? null;
}

export function latestCodexTier(ids, tier) {
  const parsed = ids.map((id) => ({ id, p: parseCodexId(id) })).filter((x) => x.p && x.p.tier === tier);
  parsed.sort((a, b) => cmpVer(b.p.ver, a.p.ver));
  return parsed[0]?.id ?? null;
}

/** Candidate ids one step "up" from every known id — what a release would be named. */
export function bumpCandidates(ids) {
  const out = new Set();
  for (const id of ids) {
    const c = parseClaudeId(id);
    if (c) {
      const v = c.ver;
      if (v.length === 1) {
        out.add(`claude-${c.family}-${v[0] + 1}`);
        // A minor release off a single-version id could be spelled either way
        // (opus 5.1 → claude-opus-5-1 or claude-opus-5.1) — probe both.
        out.add(`claude-${c.family}-${v[0]}-1`);
        out.add(`claude-${c.family}-${v[0]}.1`);
      } else {
        out.add(`claude-${c.family}-${v[0]}-${v[1] + 1}`);
        out.add(`claude-${c.family}-${v[0] + 1}`);
      }
      continue;
    }
    const g = parseCodexId(id);
    if (g) {
      const suffix = g.tier === 'full' ? '' : `-${g.tier}`;
      const v = g.ver;
      if (v.length === 1) out.add(`gpt-${v[0]}.1${suffix}`);
      else out.add(`gpt-${v[0]}.${v[1] + 1}${suffix}`);
      out.add(`gpt-${v[0] + 1}${suffix}`);
    }
  }
  for (const id of ids) out.delete(id);
  return [...out].sort();
}

/** Resolve one agent's target model from the policy. Returns null if no change computable. */
export function resolveTarget(agent, policy, available) {
  const rule = policy.agents?.[agent.name] ?? policy.default ?? { rule: 'latest-same-tier' };
  const ids = available[agent.adapterType] ?? [];
  let model = null;
  if (rule.rule === 'best-overall') {
    model = agent.adapterType === 'claude_local' ? bestClaude(ids) : latestCodexTier(ids, 'full');
  } else if (rule.rule?.startsWith('latest-family:')) {
    model = latestClaudeFamily(ids, rule.rule.split(':')[1]);
  } else {
    const cur = agent.model;
    const c = parseClaudeId(cur);
    const g = parseCodexId(cur);
    if (c) model = latestClaudeFamily(ids, c.family);
    else if (g) model = latestCodexTier(ids, g.tier);
  }
  if (!model) return null;
  const effort = rule.effort && rule.effort !== 'keep' ? rule.effort : null;
  return { model, effort };
}

/** Decide whether to dispatch the (LLM) tuning issue today. */
export function shouldTune({ modelsChanged, lastTuningAt, nowMs, minDaysBetween }) {
  const last = lastTuningAt ? Date.parse(lastTuningAt) : 0;
  if (modelsChanged) return true;
  return nowMs - last >= minDaysBetween * DAY_MS;
}

// ---------- runtime ----------

function parseArgs(argv) {
  const here = dirname(fileURLToPath(import.meta.url));
  const args = {
    dryRun: false,
    skipCliUpdate: false,
    policy: join(here, 'fleet-model-policy.json'),
    stateDir: join(process.env.HOME ?? '/home/ievgen', '.paperclip', 'fleet-model-refresh'),
    apiBase: 'http://127.0.0.1:3100',
    alertCmd: '/home/ievgen/bot/telegram-alert.sh',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--skip-cli-update') args.skipCliUpdate = true;
    else if (a === '--policy') args.policy = argv[++i];
    else if (a === '--state-dir') args.stateDir = argv[++i];
    else if (a === '--api-base') args.apiBase = argv[++i];
    else if (a === '--alert-cmd') args.alertCmd = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function loadState(dir) {
  const f = join(dir, 'state.json');
  if (!existsSync(f)) return { probes: {}, lastTuningAt: null };
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return { probes: {}, lastTuningAt: null };
  }
}

function saveState(dir, state) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
}

function updateClis(alert) {
  const results = [];
  try {
    execFileSync('claude', ['update'], { encoding: 'utf8', timeout: 300_000 });
    results.push(`claude=${execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim()}`);
  } catch (err) {
    results.push(`claude update FAILED: ${err.message.slice(0, 120)}`);
    alert(`SEV3 fleet-refresh: claude CLI update failed — running on the previous version.`);
  }
  try {
    execFileSync(
      'npm',
      ['install', '-g', '@openai/codex@latest', '--registry=https://registry.yarnpkg.com'],
      { encoding: 'utf8', timeout: 600_000, env: { ...process.env, NODE_OPTIONS: '--dns-result-order=ipv4first' } },
    );
    results.push(`codex=${execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim()}`);
  } catch (err) {
    results.push(`codex update FAILED: ${err.message.slice(0, 120)}`);
    alert(`SEV3 fleet-refresh: codex CLI update failed — running on the previous version.`);
  }
  return results;
}

/** One-token live probe. True only if the provider actually served the model. */
function probeModel(adapterType, id) {
  try {
    if (adapterType === 'claude_local') {
      const out = execFileSync('claude', ['--model', id, '--print', 'Reply with exactly: ok'], {
        encoding: 'utf8',
        timeout: 180_000,
        env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
      });
      return out.toLowerCase().includes('ok');
    }
    const out = execFileSync('codex', ['exec', '-m', id, 'Reply with exactly: ok'], {
      encoding: 'utf8',
      timeout: 180_000,
    });
    return out.toLowerCase().includes('ok');
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const apiKey = process.env.PAPERCLIP_API_KEY;
  const companyId = process.env.PAPERCLIP_COMPANY_ID;
  if (!apiKey || !companyId) {
    console.error('FATAL: PAPERCLIP_API_KEY / PAPERCLIP_COMPANY_ID not set.');
    process.exit(2);
  }
  const policy = JSON.parse(readFileSync(args.policy, 'utf8'));
  const state = loadState(args.stateDir);
  // Founder directive 2026-08-06: telegram is immediate-attention only — fleet
  // housekeeping goes out as INFO (audit-logged, filtered from DMs).
  const alert = (msg) => {
    try {
      if (!args.dryRun) execFileSync(args.alertCmd, ['INFO', msg]);
    } catch {
      /* alerting is best-effort */
    }
  };
  const api = async (method, path, body) => {
    const res = await fetch(`${args.apiBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
    return res.json();
  };

  // 1. CLI updates
  if (!args.skipCliUpdate && !args.dryRun) {
    for (const line of updateClis(alert)) console.log(line);
  }

  // 2. Model discovery
  const agentsRaw = await api('GET', `/api/companies/${companyId}/agents`);
  const agents = (Array.isArray(agentsRaw) ? agentsRaw : agentsRaw.agents ?? [])
    .filter((a) => !['terminated'].includes(a.status ?? ''))
    .filter((a) => ['claude_local', 'codex_local'].includes(a.adapterType))
    .map((a) => ({
      id: a.id,
      name: a.name,
      status: a.status,
      adapterType: a.adapterType,
      model: a.adapterConfig?.model ?? null,
      adapterConfig: a.adapterConfig ?? {},
    }));

  const available = { claude_local: new Set(), codex_local: new Set() };
  for (const type of Object.keys(available)) {
    try {
      const cat = await api('GET', `/api/companies/${companyId}/adapters/${type}/models`);
      const list = Array.isArray(cat) ? cat : cat.models ?? [];
      for (const m of list) available[type].add(typeof m === 'string' ? m : m.id ?? m.model);
    } catch {
      /* catalog endpoint unavailable — fall back to configured models */
    }
    for (const a of agents) if (a.adapterType === type && a.model) available[type].add(a.model);
    for (const [id, p] of Object.entries(state.probes))
      if (p.ok && p.adapterType === type) available[type].add(id);
  }

  const nowMs = Date.now();
  let newModels = [];
  for (const type of Object.keys(available)) {
    for (const cand of bumpCandidates([...available[type]])) {
      const prev = state.probes[cand];
      if (prev && (prev.ok || nowMs - Date.parse(prev.at) < PROBE_TTL_DAYS * DAY_MS)) continue;
      if (args.dryRun) {
        console.log(`DRY-RUN: would probe ${type} candidate ${cand}`);
        continue;
      }
      const ok = probeModel(type, cand);
      state.probes[cand] = { ok, at: new Date().toISOString(), adapterType: type };
      saveState(args.stateDir, state);
      console.log(`probe ${cand} → ${ok ? 'SERVED' : 'not served'}`);
      if (ok) {
        available[type].add(cand);
        newModels.push(cand);
      }
    }
  }
  if (newModels.length) {
    alert(`fleet-refresh: NEW MODELS detected and verified live: ${newModels.join(', ')}. Applying policy.`);
  }

  // 3. Apply policy
  const availableIds = Object.fromEntries(
    Object.entries(available).map(([k, v]) => [k, [...v]]),
  );
  const changes = [];
  for (const agent of agents) {
    const target = resolveTarget(agent, policy, availableIds);
    if (!target) continue;
    const effortKey = agent.adapterType === 'claude_local' ? 'effort' : 'modelReasoningEffort';
    const wantEffort = target.effort ?? agent.adapterConfig[effortKey];
    const modelChanged = target.model !== agent.model;
    const effortChanged = target.effort && agent.adapterConfig[effortKey] !== target.effort;
    if (!modelChanged && !effortChanged) continue;
    const desc = `${agent.name}[${agent.status}]: ${agent.model}/${agent.adapterConfig[effortKey] ?? '-'} → ${target.model}/${wantEffort ?? '-'}`;
    if (args.dryRun) {
      console.log(`DRY-RUN: would update ${desc}`);
      continue;
    }
    const nextConfig = { ...agent.adapterConfig, model: target.model };
    if (target.effort) nextConfig[effortKey] = target.effort;
    try {
      await api('PATCH', `/api/agents/${agent.id}`, { adapterConfig: nextConfig });
      changes.push(desc);
      console.log(`updated ${desc}`);
    } catch (err) {
      // AUR-4689 validation rejecting a write is loud by design — surface it.
      console.error(`update REFUSED for ${desc}: ${err.message}`);
      alert(`SEV3 fleet-refresh: model update refused for ${agent.name}: ${err.message.slice(0, 140)}`);
    }
  }
  if (changes.length) alert(`fleet-refresh applied: ${changes.join(' | ')}`);

  // 4. Dispatch the (budgeted) tuning judgment
  const minDays = policy.tuning?.minDaysBetween ?? 6;
  if (shouldTune({ modelsChanged: newModels.length > 0, lastTuningAt: state.lastTuningAt, nowMs, minDaysBetween: minDays })) {
    const reviewerName = policy.tuning?.reviewer ?? 'Claude Code Max';
    const reviewer = agents.find(
      (a) => a.name === reviewerName && !['error', 'terminated'].includes(a.status),
    );
    if (reviewer && !args.dryRun) {
      const created = await api('POST', `/api/companies/${companyId}/issues`, {
        title: `fleet-tuning: re-evaluate agent models/effort/prompts vs recent task mix (${new Date().toISOString().slice(0, 10)})`,
        description: [
          'Filed by scripts/fleet-model-refresh.mjs (daily fleet refresh — judgment half, budget-capped to one pass).',
          '',
          newModels.length
            ? `Trigger: newly available model(s): ${newModels.join(', ')}.`
            : `Trigger: scheduled (every ${minDays} days).`,
          '',
          'In ONE pass (no per-task deep dives):',
          '1. Pull each active agent\'s last-7-days issue mix (titles + outcomes) from the board.',
          '2. For each agent decide whether its model TIER, effort, and system prompt still fit',
          '   the work it actually receives. scripts/fleet-model-policy.json pins CEO = frontier',
          '   model at highest effort and Claude Code Max = latest fable — do not violate those;',
          '   propose policy-file changes for anything else via a PR to fleet-model-policy.json.',
          '3. Apply effort/system-prompt adjustments directly via PATCH /agents/:id and the',
          '   instructions bundle API. Keep a one-line rationale per change in this issue.',
          '4. Budget rule: this is a routine calibration, not research — cap at one focused run.',
          '',
          'The founder does not review these decisions — your judgment is final within policy.',
        ].join('\n'),
        priority: 'medium',
        assigneeAgentId: reviewer.id,
      });
      state.lastTuningAt = new Date().toISOString();
      saveState(args.stateDir, state);
      console.log(`tuning issue filed: ${created.identifier ?? created.id}`);
    } else if (args.dryRun) {
      console.log('DRY-RUN: would file fleet-tuning issue');
    }
  }
  console.log(
    `done: agents=${agents.length} newModels=${newModels.length} changes=${changes.length}`,
  );
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`FATAL: ${err.message}`);
    process.exit(2);
  });
}
