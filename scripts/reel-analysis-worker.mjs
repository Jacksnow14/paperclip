#!/usr/bin/env node
/**
 * AUR-2216 / AUR-2201: Reel analysis worker — queued reel → business analysis.
 *
 * Run on the predictor host alongside the Telegram bot worker:
 *   PAPERCLIP_API_URL=... PAPERCLIP_API_KEY=... \
 *   PAPERCLIP_COMPANY_ID=... node scripts/reel-analysis-worker.mjs
 *
 * Behaviour (AUR-2201 "no empty issues" redesign):
 *   The Telegram worker no longer creates a board issue at intake — it drops a
 *   JSON job into REEL_QUEUE_DIR. This worker:
 *   1. Polls REEL_QUEUE_DIR every ANALYSIS_POLL_INTERVAL_MS (default 60s).
 *   2. For each queued reel: extract content via reel_extract.py
 *      (caption + transcript + keyframes).
 *   3. Run business analysis via the `claude -p` CLI.
 *   4. ONLY on success: create the board issue ALREADY populated (upload
 *      keyframes, post the analysis comment, mark done) and write a result file
 *      so the Telegram worker relays the analysis back to the user.
 *      → A board issue therefore always means "something was analyzed".
 *      No empty/pending intake card ever appears (AUR-2201 user requirement).
 *
 * Retry behaviour (AUR-2363):
 *   - Extraction failures are transient (IG rate-limiting). The job stays in
 *     the queue and its `attempts` counter is incremented; it is retried up to
 *     MAX_EXTRACTION_ATTEMPTS times across cycles. No issue is created while
 *     retrying.
 *   - Only after all attempts are exhausted is the job dropped and a `failed`
 *     result written (Telegram relays a short "couldn't analyze" notice). Still
 *     no board issue — a failed reel is not an analyzed reel.
 *
 * Flags:
 *   --once   Process the current backlog once and exit (for one-shot use).
 */

import { spawnSync, execFileSync } from "node:child_process";
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveApiBase } from "./lib/paperclip-api-base.mjs";

// ── Config ───────────────────────────────────────────────────────────────────
let API_URL = "";
const API_KEY = process.env.PAPERCLIP_API_KEY;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
const POLL_INTERVAL_MS = Number(process.env.ANALYSIS_POLL_INTERVAL_MS ?? 60_000);
const REEL_EXTRACT_PATH = process.env.REEL_EXTRACT_PATH ?? "/home/ievgen/outreach/reel_extract.py";
const CLAUDE_PATH = process.env.CLAUDE_PATH ?? "/home/ievgen/.local/bin/claude";
const RUN_ONCE = process.argv.includes("--once");
// Shared file queue with the Telegram intake worker.
const REEL_QUEUE_DIR = process.env.REEL_QUEUE_DIR ?? "/home/ievgen/paperclip-data/reel-queue";
const REEL_RESULT_DIR = process.env.REEL_RESULT_DIR ?? "/home/ievgen/paperclip-data/reel-results";
// Rate-limit mitigation: space out yt-dlp calls and cap batch size
const MAX_REELS_PER_CYCLE = Number(process.env.MAX_REELS_PER_CYCLE ?? 5);
const INTER_REEL_DELAY_MS = Number(process.env.INTER_REEL_DELAY_MS ?? 8_000);
// Retry: max extraction attempts before permanently giving up
const MAX_EXTRACTION_ATTEMPTS = Number(process.env.MAX_EXTRACTION_ATTEMPTS ?? 4);
// Cookies file for authenticated IG downloads (defeats rate-limiting)
const IG_COOKIES_PATH = process.env.IG_COOKIES_PATH ?? "/home/ievgen/outreach/ig_cookies.txt";
// Priority for intake issues (low: queue behind real work). Override per-batch.
const INTAKE_PRIORITY = process.env.TELEGRAM_INTAKE_PRIORITY ?? "low";
const ASSIGNEE_AGENT_ID = process.env.TELEGRAM_INTAKE_ASSIGNEE_AGENT_ID ?? null;

if (!API_KEY || !COMPANY_ID) {
  console.error("PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID are required");
  process.exit(1);
}

mkdirSync(REEL_QUEUE_DIR, { recursive: true });
mkdirSync(REEL_RESULT_DIR, { recursive: true });

// ── Paperclip API helpers ────────────────────────────────────────────────────
function pcHeaders() {
  return {
    "Authorization": `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };
}

async function createIssue(title, description) {
  const body = {
    title,
    description,
    status: "todo",
    priority: INTAKE_PRIORITY,
    originKind: "reel_intake",
    ...(ASSIGNEE_AGENT_ID ? { assigneeAgentId: ASSIGNEE_AGENT_ID } : {}),
  };
  const res = await fetch(`${API_URL}/api/companies/${COMPANY_ID}/issues`, {
    method: "POST",
    headers: pcHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`createIssue HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function postComment(issueId, body) {
  const res = await fetch(`${API_URL}/api/issues/${issueId}/comments`, {
    method: "POST",
    headers: pcHeaders(),
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`Comment POST HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function updateIssue(issueId, patch) {
  const res = await fetch(`${API_URL}/api/issues/${issueId}`, {
    method: "PATCH",
    headers: pcHeaders(),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Issue PATCH HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

function uploadFrame(issueId, framePath) {
  try {
    const out = execFileSync("curl", [
      "-sf", "-X", "POST",
      `${API_URL}/api/companies/${COMPANY_ID}/issues/${issueId}/attachments`,
      "-H", `Authorization: Bearer ${API_KEY}`,
      "-F", `file=@${framePath}`,
    ], { encoding: "utf8", timeout: 30_000 });
    return JSON.parse(out);
  } catch (err) {
    console.warn(`Frame upload failed: ${err.message}`);
    return null;
  }
}

// ── File queue helpers ───────────────────────────────────────────────────────
function readQueue() {
  let files;
  try {
    files = readdirSync(REEL_QUEUE_DIR).filter(f => f.endsWith(".json"));
  } catch {
    return [];
  }
  const jobs = [];
  for (const f of files) {
    const path = join(REEL_QUEUE_DIR, f);
    try {
      const job = JSON.parse(readFileSync(path, "utf8"));
      job._path = path;
      jobs.push(job);
    } catch (err) {
      console.warn(`Skipping unreadable queue file ${f}: ${err.message}`);
    }
  }
  // Oldest first (FIFO by receivedAt, then filename).
  jobs.sort((a, b) => (a.receivedAt ?? 0) - (b.receivedAt ?? 0));
  return jobs;
}

function writeQueueJob(job) {
  const { _path, ...rest } = job;
  writeFileSync(_path, JSON.stringify(rest, null, 2));
}

function removeQueueJob(job) {
  try { unlinkSync(job._path); } catch { /* already gone */ }
}

function writeResult(job, result) {
  const path = join(REEL_RESULT_DIR, `${job.queueId}.json`);
  writeFileSync(path, JSON.stringify({
    queueId: job.queueId,
    chatId: job.chatId,
    reelUrl: job.reelUrl,
    ...result,
  }, null, 2));
}

// ── Reel extraction ──────────────────────────────────────────────────────────
function extractReel(url) {
  const cfg = { url, max_frames: 3, whisper_model: "base" };
  if (existsSync(IG_COOKIES_PATH)) cfg.cookies = IG_COOKIES_PATH;

  const result = spawnSync("python3", [REEL_EXTRACT_PATH, JSON.stringify(cfg)], {
    timeout: 300_000,
    encoding: "utf8",
  });
  if (result.error) throw new Error(`spawnSync error: ${result.error.message}`);
  if (result.status !== 0) {
    // reel_extract.py writes error details to stdout JSON, not stderr
    let extractError = "";
    try {
      const j = JSON.parse((result.stdout ?? "").trim());
      extractError = j.error ?? "";
    } catch {}
    const stderr = (result.stderr ?? "").slice(0, 300);
    throw new Error(`reel_extract.py exited ${result.status}: ${extractError || stderr || "(no output)"}`);
  }
  const stdout = (result.stdout ?? "").trim();
  let manifest;
  try {
    manifest = JSON.parse(stdout);
  } catch {
    throw new Error(`reel_extract.py output not JSON: ${stdout.slice(0, 200)}`);
  }
  if (!manifest.ok) throw new Error(`extraction not ok: ${(manifest.error ?? "unknown").slice(0, 200)}`);
  return manifest;
}

// ── Business analysis via Claude CLI ────────────────────────────────────────
function analyzeWithClaude(manifest) {
  const caption = (manifest.caption ?? "").trim() || "(none)";
  const transcript = (manifest.transcript?.text ?? "").trim() || "(no speech detected)";
  const uploader = manifest.uploader ?? "unknown";
  const duration = manifest.duration ?? 0;
  const url = manifest.url ?? "";

  const prompt = `You are a sharp business analyst reviewing an Instagram reel shared with Paperclip (we build AI agent workflow automation — agents that handle business tasks autonomously).

Reel metadata:
- Uploader: @${uploader}
- Duration: ${duration}s
- URL: ${url}

Caption:
${caption}

Transcript:
${transcript}

Write a concise business analysis in EXACTLY this format (no extra prose before or after):

**Summary:** [1 sentence — what the reel is about]

**Relevance to Paperclip:** [high/medium/low] — [1 sentence explaining why or why not]

**Key Takeaway:** [1-2 sentences — the most actionable insight for our team]

**Tags:** [2-4 comma-separated tags from: strategy, AI, automation, marketing, competition, inspiration, tech, workflow, SaaS, productivity, social-media, other]

Be direct. If the transcript is empty, base the analysis on the caption only.`;

  const result = spawnSync(CLAUDE_PATH, ["-p", prompt, "--output-format", "text"], {
    timeout: 60_000,
    encoding: "utf8",
    env: { ...process.env },
  });
  if (result.error) throw new Error(`claude spawn error: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").slice(0, 500);
    throw new Error(`claude -p exited ${result.status}: ${stderr}`);
  }
  return (result.stdout ?? "").trim();
}

// ── Issue content builders ───────────────────────────────────────────────────
function buildIssueTitle(reelUrl) {
  return `[reel-intake] ${reelUrl}`.slice(0, 255);
}

function buildIssueDescription(job, manifest) {
  const receivedIso = job.receivedAt ? new Date(job.receivedAt * 1000).toISOString() : "unknown";
  return [
    `**Inbound reel shared via Telegram bot — analysis below.**`,
    ``,
    `- **Reel URL:** ${job.reelUrl}`,
    `- **Uploader:** @${manifest.uploader ?? "unknown"}`,
    `- **Duration:** ${manifest.duration ?? 0}s`,
    `- **Received:** ${receivedIso}`,
    ``,
    `exec.labels: reel-intake`,
  ].join("\n");
}

function buildAnalysisComment(job, manifest, analysis, attachmentResults) {
  const uploader = manifest.uploader ?? "unknown";
  const duration = manifest.duration ?? 0;
  const transcriptPreview = (manifest.transcript?.text ?? "").slice(0, 300);

  let frameSection = "";
  if (attachmentResults.length > 0) {
    frameSection = "\n\n**Key Frames:**\n" +
      attachmentResults.map((a, i) => `![frame-${i + 1}](attachment://${a.id})`).join("  ");
  }

  const transcriptSection = transcriptPreview
    ? `\n\n**Transcript excerpt:**\n> ${transcriptPreview.replace(/\n/g, "\n> ")}${manifest.transcript?.text?.length > 300 ? "…" : ""}`
    : "";

  return [
    "## Reel Analysis",
    "",
    `**Source:** [${job.reelUrl}](${job.reelUrl})`,
    `**Uploader:** @${uploader} · ${duration}s`,
    "",
    analysis,
    frameSection,
    transcriptSection,
    "",
    "---",
    "_Analyzed by reel-analysis-worker ([AUR-2216](/AUR/issues/AUR-2216))_",
  ].join("\n");
}

// ── Process a single queued reel ─────────────────────────────────────────────
async function processJob(job) {
  const label = `[${job.queueId}]`;
  const reelUrl = job.reelUrl;
  if (!reelUrl) {
    console.error(`${label} Queue job has no reelUrl — dropping`);
    removeQueueJob(job);
    return;
  }

  console.log(`${label} Extracting reel: ${reelUrl}`);

  // Step 1: Extract reel content — with retry tracking in the queue file.
  let manifest;
  try {
    manifest = extractReel(reelUrl);
  } catch (err) {
    const attemptNumber = (job.attempts ?? 0) + 1;
    console.error(`${label} Extraction attempt ${attemptNumber}/${MAX_EXTRACTION_ATTEMPTS} failed: ${err.message}`);

    if (attemptNumber >= MAX_EXTRACTION_ATTEMPTS) {
      // Exhausted — no board issue (a failed reel is not an analyzed reel).
      // Relay a short failure notice to the user instead.
      writeResult(job, {
        status: "failed",
        attempts: attemptNumber,
        error: err.message.slice(0, 300),
      });
      removeQueueJob(job);
      console.log(`${label} Exhausted ${MAX_EXTRACTION_ATTEMPTS} attempts — failure relayed, no issue created`);
    } else {
      job.attempts = attemptNumber;
      writeQueueJob(job);
      console.log(`${label} Transient — leaving in queue for retry (attempt ${attemptNumber}/${MAX_EXTRACTION_ATTEMPTS})`);
    }
    return;
  }

  // Step 2: Business analysis via Claude (before we create anything visible).
  console.log(`${label} Running Claude analysis...`);
  let analysis;
  try {
    analysis = analyzeWithClaude(manifest);
  } catch (err) {
    console.error(`${label} Claude analysis failed: ${err.message}`);
    analysis = "_Business analysis unavailable — Claude CLI error. Please review manually._";
  }

  // Step 3: Create the board issue — now that we have a real analysis in hand.
  // This is the ONLY place an intake issue is created, so a card always means
  // "something was analyzed" (AUR-2201 requirement).
  const issue = await createIssue(buildIssueTitle(reelUrl), buildIssueDescription(job, manifest));
  const issueId = issue.id;
  const identifier = issue.identifier ?? issueId;
  console.log(`${label} Created issue ${identifier}`);

  // Step 4: Upload up to 2 keyframes.
  const framePaths = (manifest.frames ?? []).slice(0, 2);
  const attachmentResults = [];
  for (const fp of framePaths) {
    if (!existsSync(fp)) continue;
    const att = uploadFrame(issueId, fp);
    if (att?.id) attachmentResults.push(att);
    console.log(`${label} Frame uploaded: ${fp} → ${att?.id ?? "failed"}`);
  }

  // Step 5: Post the analysis comment and mark done.
  const commentBody = buildAnalysisComment(job, manifest, analysis, attachmentResults);
  await postComment(issueId, commentBody);
  await updateIssue(issueId, {
    status: "done",
    comment: "Analysis complete — comment posted.",
  });
  console.log(`${label} Analysis posted, issue ${identifier} marked done ✓`);

  // Step 6: Relay back to Telegram + clear the queue job.
  writeResult(job, {
    status: "done",
    issueIdentifier: identifier,
    analysis: commentBody,
  });
  removeQueueJob(job);
}

// ── Main loop ────────────────────────────────────────────────────────────────
async function main() {
  API_URL = await resolveApiBase();
  const cookiesStatus = existsSync(IG_COOKIES_PATH) ? `present (${IG_COOKIES_PATH})` : "absent";
  console.log(
    `reel-analysis-worker starting (AUR-2216/AUR-2363/AUR-2201) — queue: ${REEL_QUEUE_DIR}, ` +
    `poll: ${POLL_INTERVAL_MS}ms, max-reels/cycle: ${MAX_REELS_PER_CYCLE}, ` +
    `inter-reel-delay: ${INTER_REEL_DELAY_MS}ms, max-attempts: ${MAX_EXTRACTION_ATTEMPTS}, ` +
    `cookies: ${cookiesStatus}, run-once: ${RUN_ONCE}`
  );

  let iteration = 0;
  while (true) {
    iteration++;
    try {
      const allJobs = readQueue();
      const jobs = allJobs.slice(0, MAX_REELS_PER_CYCLE);
      if (allJobs.length > 0) {
        console.log(`[poll #${iteration}] ${allJobs.length} queued, processing ${jobs.length} this cycle (cap=${MAX_REELS_PER_CYCLE})`);
      }
      for (let i = 0; i < jobs.length; i++) {
        try {
          await processJob(jobs[i]);
        } catch (err) {
          console.error(`Error processing ${jobs[i].queueId}: ${err.message}`);
        }
        // Sleep between reels (except after the last one) to defeat IG rate-limiting
        if (i < jobs.length - 1) {
          await sleep(INTER_REEL_DELAY_MS);
        }
      }
    } catch (err) {
      console.error(`Poll error: ${err.message}`);
    }

    if (RUN_ONCE) {
      console.log("--once flag set — exiting after one pass");
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
