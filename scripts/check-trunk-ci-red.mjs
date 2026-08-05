#!/usr/bin/env node
/**
 * Trunk-red CI detector (AUR-4675).
 *
 * The failure mode this guards is not "a test broke" — it is "nobody could
 * tell that the merge gate stopped working" (AUR-4555). Trunk `test` went red
 * across consecutive master commits in July 2026 and the only detection was a
 * human manually gating a PR merge. There is no branch protection on master
 * (verified 2026-07-30: GET /branches/master/protection → 404), so the gate
 * is convention, and convention rots silently.
 *
 * What it does: reads GitHub Actions check-run conclusions for the required
 * CI jobs on the last N commits of the trunk branch, decides a trunk verdict,
 * and — when trunk is red — files a high-priority Paperclip issue and sends a
 * Telegram alert, deduped per deciding sha so a standing red does not page on
 * every run.
 *
 * Verdict semantics (per commit, per required job):
 *   success                        → green
 *   failure/timed_out/action_required/stale → red
 *   skipped                        → red   (ci.yml has no conditionals; a
 *                                           skipped required job IS gate rot)
 *   neutral                        → green (annotation-only tools)
 *   cancelled                      → inconclusive (ci.yml uses a shared
 *     concurrency group with cancel-in-progress on the trunk branch, so an
 *     older push is legitimately cancelled when superseded by a newer one)
 *   missing / not completed        → pending while the commit is younger than
 *     the grace window; RED once older ("gate not reporting" is exactly the
 *     silent-rot mode this detector exists for)
 *
 * Trunk verdict: walk commits newest → oldest; the first commit that is
 * conclusively green or red decides. Pending/inconclusive commits are walked
 * past. If nothing in the window is conclusive and the newest commit has
 * outlived the grace window, that is red (gate silent), not unknown.
 *
 * Exit codes: 0 = trunk green (or still pending inside grace) · 1 = trunk
 * RED · 2 = detector could not measure (transport/API failure). 2 is loud
 * and distinct because an unreachable sensor reads UNKNOWN, never "no news
 * is good news".
 *
 * Requires: `gh` CLI authenticated (v2.4.0-compatible — uses `gh api` only,
 * never `gh run list --branch`). Issue filing needs PAPERCLIP_API_KEY and
 * PAPERCLIP_COMPANY_ID in the environment.
 *
 * Usage:
 *   node scripts/check-trunk-ci-red.mjs                  # evaluate trunk, act if red
 *   node scripts/check-trunk-ci-red.mjs --dry-run        # evaluate, never file/alert
 *   node scripts/check-trunk-ci-red.mjs --sha <sha>      # evaluate ONE commit (discrimination proofs)
 *   --drill             label the filed issue + alert as a drill (end-to-end proof runs)
 *   --repo owner/name   (default Jacksnow14/paperclip)
 *   --branch name       (default master)
 *   --jobs a,b,c        (default test,typecheck,scripts-test)
 *   --commits N         (default 5)
 *   --grace-minutes M   (default 90)
 *   --state-dir DIR     (default $HOME/.paperclip/trunk-ci-red)
 *   --alert-cmd PATH    (default /home/ievgen/bot/telegram-alert.sh)
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'stale']);
const GREEN_CONCLUSIONS = new Set(['success', 'neutral']);

/** Latest check-run per name — reruns leave several runs sharing one name. */
export function latestRunsByName(checkRuns) {
  const byName = new Map();
  for (const run of checkRuns) {
    const prev = byName.get(run.name);
    if (!prev) { byName.set(run.name, run); continue; }
    const prevKey = prev.started_at ?? '';
    const key = run.started_at ?? '';
    if (key > prevKey || (key === prevKey && (run.id ?? 0) > (prev.id ?? 0))) {
      byName.set(run.name, run);
    }
  }
  return byName;
}

/**
 * Classify one commit against the required job list.
 * Returns { verdict: 'green'|'red'|'pending'|'inconclusive', jobs: [{name, state, reason}] }.
 */
export function classifyCommit(checkRuns, requiredJobs, { ageMinutes, graceMinutes }) {
  const latest = latestRunsByName(checkRuns);
  const pastGrace = ageMinutes > graceMinutes;
  const jobs = [];
  for (const name of requiredJobs) {
    const run = latest.get(name);
    if (!run) {
      jobs.push({
        name,
        state: pastGrace ? 'red' : 'pending',
        reason: pastGrace ? `no check-run after ${graceMinutes}min — gate not reporting` : 'not yet reported',
      });
    } else if (run.status !== 'completed') {
      jobs.push({
        name,
        state: pastGrace ? 'red' : 'pending',
        reason: pastGrace ? `still ${run.status} after ${graceMinutes}min — gate not reporting` : run.status,
      });
    } else if (run.conclusion === 'cancelled') {
      jobs.push({ name, state: 'inconclusive', reason: 'cancelled (superseded by newer trunk push)' });
    } else if (run.conclusion === 'skipped') {
      jobs.push({ name, state: 'red', reason: 'required job skipped — gate rot' });
    } else if (RED_CONCLUSIONS.has(run.conclusion)) {
      jobs.push({ name, state: 'red', reason: run.conclusion });
    } else if (GREEN_CONCLUSIONS.has(run.conclusion)) {
      jobs.push({ name, state: 'green', reason: run.conclusion });
    } else {
      // Unknown conclusion value: fail closed — an unrecognized state must
      // surface, not silently read as healthy.
      jobs.push({ name, state: 'red', reason: `unrecognized conclusion "${run.conclusion}"` });
    }
  }
  let verdict;
  if (jobs.some((j) => j.state === 'red')) verdict = 'red';
  else if (jobs.every((j) => j.state === 'green')) verdict = 'green';
  else if (jobs.some((j) => j.state === 'pending')) verdict = 'pending';
  else verdict = 'inconclusive';
  return { verdict, jobs };
}

/**
 * Decide the trunk verdict from per-commit classifications, newest first.
 * Returns { verdict, decidingSha, redJobs, redStreak }.
 */
export function trunkVerdict(classified) {
  let deciding = null;
  for (const c of classified) {
    if (c.verdict === 'green' || c.verdict === 'red') { deciding = c; break; }
  }
  if (!deciding) {
    const newest = classified[0];
    return { verdict: newest ? newest.verdict : 'pending', decidingSha: null, redJobs: [], redStreak: 0 };
  }
  let redStreak = 0;
  if (deciding.verdict === 'red') {
    for (const c of classified.slice(classified.indexOf(deciding))) {
      if (c.verdict === 'red') redStreak += 1;
      else if (c.verdict === 'green') break;
      // pending/inconclusive in the middle of a streak: walk past
    }
  }
  return {
    verdict: deciding.verdict,
    decidingSha: deciding.sha,
    redJobs: deciding.jobs.filter((j) => j.state === 'red').map((j) => `${j.name} (${j.reason})`),
    redStreak,
  };
}

function ghApi(path) {
  return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
}

function parseArgs(argv) {
  const args = {
    repo: 'Jacksnow14/paperclip',
    branch: 'master',
    jobs: ['test', 'typecheck', 'scripts-test'],
    commits: 5,
    graceMinutes: 90,
    sha: null,
    dryRun: false,
    drill: false,
    stateDir: join(process.env.HOME ?? '/tmp', '.paperclip', 'trunk-ci-red'),
    alertCmd: '/home/ievgen/bot/telegram-alert.sh',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--drill') args.drill = true;
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--branch') args.branch = argv[++i];
    else if (a === '--jobs') args.jobs = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--commits') args.commits = Number(argv[++i]);
    else if (a === '--grace-minutes') args.graceMinutes = Number(argv[++i]);
    else if (a === '--sha') args.sha = argv[++i];
    else if (a === '--state-dir') args.stateDir = argv[++i];
    else if (a === '--alert-cmd') args.alertCmd = argv[++i];
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  return args;
}

async function fileIssue(args, verdict, table) {
  const apiKey = process.env.PAPERCLIP_API_KEY;
  const companyId = process.env.PAPERCLIP_COMPANY_ID;
  if (!apiKey || !companyId) {
    return { ok: false, detail: 'PAPERCLIP_API_KEY / PAPERCLIP_COMPANY_ID not set — cannot file' };
  }
  const short = verdict.decidingSha.slice(0, 9);
  const body = {
    title: `${args.drill ? '[DRILL AUR-4675] ' : ''}Trunk CI is RED: ${args.branch}@${short} — ${verdict.redJobs.join(', ')}`,
    description: [
      `Filed automatically by scripts/check-trunk-ci-red.mjs (AUR-4675 detector).`,
      '',
      `Trunk \`${args.branch}\` of ${args.repo} is RED at the merge gate. Deciding commit: \`${verdict.decidingSha}\`.`,
      `Failing required job(s): ${verdict.redJobs.join(', ')}. Consecutive red trunk commits in window: ${verdict.redStreak}.`,
      '',
      '**Do not merge PRs over a red trunk.** Fix or revert the breaking commit, then re-verify at job level.',
      '',
      'Last-N window at detection time:',
      '',
      table,
      '',
      `Reproduce: \`node scripts/check-trunk-ci-red.mjs --dry-run --repo ${args.repo} --branch ${args.branch}\``,
    ].join('\n'),
    priority: 'high',
  };
  const res = await fetch(`http://127.0.0.1:3100/api/companies/${companyId}/issues`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { ok: false, detail: `POST issues → ${res.status}` };
  const created = await res.json();
  // 201 is not proof — read the row back before claiming the issue exists.
  const readBack = await fetch(`http://127.0.0.1:3100/api/issues/${created.id}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!readBack.ok) return { ok: false, detail: `filed ${created.identifier ?? created.id} but read-back → ${readBack.status}` };
  return { ok: true, detail: created.identifier ?? created.id };
}

function sendAlert(args, verdict, issueRef) {
  if (!existsSync(args.alertCmd)) return { ok: false, detail: `alert cmd ${args.alertCmd} not present` };
  const msg = `${args.drill ? '[DRILL AUR-4675 — historical sha, trunk is fine] ' : ''}Trunk CI RED: ${args.repo} ${args.branch}@${verdict.decidingSha.slice(0, 9)} — ${verdict.redJobs.join(', ')} — streak ${verdict.redStreak}. Issue: ${issueRef}. Do not merge over red trunk.`;
  try {
    const out = execFileSync(args.alertCmd, ['SEV2', msg], { encoding: 'utf8' });
    // The transport prints "sent" only on Telegram's own ok:true (AUR-3930).
    return { ok: true, detail: out.trim() };
  } catch (err) {
    return { ok: false, detail: `delivery failed: ${err.message}` };
  }
}

function renderTable(classified) {
  const lines = ['| commit | verdict | jobs |', '|---|---|---|'];
  for (const c of classified) {
    const jobs = c.jobs.map((j) => `${j.name}=${j.state}(${j.reason})`).join(' · ');
    lines.push(`| \`${c.sha.slice(0, 9)}\` | ${c.verdict} | ${jobs} |`);
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const nowMs = Date.now();

  let commits;
  try {
    if (args.sha) {
      const c = ghApi(`repos/${args.repo}/commits/${args.sha}`);
      commits = [c];
    } else {
      commits = ghApi(`repos/${args.repo}/commits?sha=${args.branch}&per_page=${args.commits}`);
    }
  } catch (err) {
    console.error(`UNKNOWN: cannot list commits for ${args.repo}@${args.branch}: ${err.message}`);
    process.exit(2);
  }

  const classified = [];
  for (const c of commits) {
    let runs;
    try {
      runs = ghApi(`repos/${args.repo}/commits/${c.sha}/check-runs?per_page=100`).check_runs ?? [];
    } catch (err) {
      console.error(`UNKNOWN: cannot read check-runs for ${c.sha}: ${err.message}`);
      process.exit(2);
    }
    const committedAt = c.commit?.committer?.date ?? c.commit?.author?.date;
    const ageMinutes = committedAt ? (nowMs - Date.parse(committedAt)) / 60000 : Infinity;
    classified.push({ sha: c.sha, ...classifyCommit(runs, args.jobs, { ageMinutes, graceMinutes: args.graceMinutes }) });
  }

  const verdict = trunkVerdict(classified);
  const table = renderTable(classified);

  console.log(`provenance: repo=${args.repo} branch=${args.branch} jobs=${args.jobs.join(',')} window=${classified.length} evaluated-head=${classified[0]?.sha ?? 'none'} via=gh-api-check-runs`);
  console.log(table);
  console.log(`trunk verdict: ${verdict.verdict}${verdict.decidingSha ? ` (deciding ${verdict.decidingSha}, red streak ${verdict.redStreak})` : ''}`);

  if (verdict.verdict !== 'red') {
    process.exit(0);
  }

  if (args.dryRun) {
    console.log(`DRY-RUN: would file high-priority issue + SEV2 alert for ${verdict.decidingSha} (${verdict.redJobs.join(', ')})`);
    process.exit(1);
  }

  mkdirSync(args.stateDir, { recursive: true });
  const stateFile = join(args.stateDir, `fired-${verdict.decidingSha}.json`);
  let state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;

  if (state?.issue && state?.alerted) {
    console.log(`already fired for ${verdict.decidingSha}: issue ${state.issue}, alerted ${state.alertedAt} — not re-paging`);
    process.exit(1);
  }

  state = state ?? { sha: verdict.decidingSha, issue: null, alerted: false };
  if (!state.issue) {
    const filed = await fileIssue(args, verdict, table);
    if (filed.ok) {
      state.issue = filed.detail;
      console.log(`filed issue: ${filed.detail}`);
    } else {
      console.log(`DELIVERY-FAILURE issue-filing: ${filed.detail}`);
    }
  }
  if (!state.alerted) {
    const alerted = sendAlert(args, verdict, state.issue ?? 'FILING FAILED — check board');
    if (alerted.ok) {
      state.alerted = true;
      state.alertedAt = new Date().toISOString();
      console.log(`alert delivered: ${alerted.detail}`);
    } else {
      console.log(`DELIVERY-FAILURE alert: ${alerted.detail}`);
    }
  }
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  if (!state.issue || !state.alerted) {
    console.log('RED with undelivered escalation — next run will retry the failed channel.');
  }
  process.exit(1);
}

const invokedDirectly = process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => { console.error(`UNKNOWN: ${err.stack ?? err}`); process.exit(2); });
}
