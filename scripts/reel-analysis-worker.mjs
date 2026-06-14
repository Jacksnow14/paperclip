#!/usr/bin/env node
/**
 * AUR-2216: Reel analysis worker — reel-intake issue → business analysis.
 *
 * Run on the predictor host alongside the Telegram bot worker:
 *   PAPERCLIP_API_URL=... PAPERCLIP_API_KEY=... \
 *   PAPERCLIP_COMPANY_ID=... node scripts/reel-analysis-worker.mjs
 *
 * Behaviour:
 *   1. Poll Paperclip every ANALYSIS_POLL_INTERVAL_MS (default 60s) for
 *      `reel-intake` issues in `todo` status.
 *   2. For each: extract reel content via reel_extract.py
 *      (caption + transcript + keyframes).
 *   3. Run business analysis via the `claude -p` CLI.
 *   4. Upload up to 2 keyframes as issue attachments.
 *   5. Post analysis comment on the issue.
 *   6. Mark the issue `done` — Telegram relay (AUR-2215) sends it to the user.
 *
 * Flags:
 *   --once   Process the current backlog once and exit (for cron/Paperclip routine use).
 */

import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// ── Config ───────────────────────────────────────────────────────────────────
const API_URL = process.env.PAPERCLIP_API_URL ?? "http://localhost:3000";
const API_KEY = process.env.PAPERCLIP_API_KEY;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
const POLL_INTERVAL_MS = Number(process.env.ANALYSIS_POLL_INTERVAL_MS ?? 60_000);
const REEL_EXTRACT_PATH = process.env.REEL_EXTRACT_PATH ?? "/home/ievgen/outreach/reel_extract.py";
const CLAUDE_PATH = process.env.CLAUDE_PATH ?? "/home/ievgen/.local/bin/claude";
const RUN_ONCE = process.argv.includes("--once");

if (!API_KEY || !COMPANY_ID) {
  console.error("PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID are required");
  process.exit(1);
}

// ── Paperclip API helpers ────────────────────────────────────────────────────
function pcHeaders() {
  return {
    "Authorization": `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };
}

async function findReelIntakeIssues() {
  const params = new URLSearchParams({ q: "[reel-intake]", status: "todo", limit: "25" });
  const res = await fetch(`${API_URL}/api/companies/${COMPANY_ID}/issues?${params}`, {
    headers: { "Authorization": `Bearer ${API_KEY}` },
  });
  if (!res.ok) {
    console.error(`Issues fetch HTTP ${res.status}`);
    return [];
  }
  const data = await res.json();
  const issues = Array.isArray(data) ? data : (data.issues ?? []);
  return issues.filter(i => i.title?.includes("[reel-intake]"));
}

async function getIssueComments(issueId) {
  const res = await fetch(`${API_URL}/api/issues/${issueId}/comments?order=asc`, {
    headers: { "Authorization": `Bearer ${API_KEY}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : (data.comments ?? []);
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

async function uploadFrame(issueId, framePath) {
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

// ── Reel extraction ──────────────────────────────────────────────────────────
function extractReel(url) {
  const input = JSON.stringify({ url, max_frames: 3, whisper_model: "base" });
  const result = spawnSync("python3", [REEL_EXTRACT_PATH, input], {
    timeout: 300_000,
    encoding: "utf8",
  });
  if (result.error) throw new Error(`spawnSync error: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").slice(0, 500);
    throw new Error(`reel_extract.py exited ${result.status}: ${stderr}`);
  }
  const stdout = (result.stdout ?? "").trim();
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`reel_extract.py output not JSON: ${stdout.slice(0, 200)}`);
  }
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

// ── URL extraction from issue ────────────────────────────────────────────────
function extractReelUrl(issue) {
  const descMatch = issue.description?.match(/\*\*Reel URL:\*\*\s+(https?:\/\/\S+)/);
  if (descMatch) return descMatch[1];
  const titleMatch = issue.title?.match(/\[reel-intake\]\s+(https?:\/\/\S+)/);
  return titleMatch ? titleMatch[1] : null;
}

function alreadyAnalyzed(comments) {
  return comments.some(c =>
    c.authorType !== "system" &&
    (c.body?.includes("## Reel Analysis") || c.body?.includes("**Summary:**"))
  );
}

// ── Process a single reel-intake issue ──────────────────────────────────────
async function processIssue(issue) {
  const { id: issueId, identifier } = issue;
  const label = `[${identifier}]`;

  console.log(`${label} Processing: ${issue.title?.slice(0, 80)}`);

  const comments = await getIssueComments(issueId);
  if (alreadyAnalyzed(comments)) {
    console.log(`${label} Already analyzed — skipping`);
    // Make sure the issue isn't stuck in todo
    await updateIssue(issueId, { status: "done", comment: "Previously analyzed — marking done." });
    return;
  }

  const reelUrl = extractReelUrl(issue);
  if (!reelUrl) {
    console.error(`${label} Could not extract reel URL`);
    await postComment(issueId, "⚠️ Could not extract reel URL from issue. Manual review needed.");
    await updateIssue(issueId, { status: "done", comment: "URL extraction failed — marked done for cleanup." });
    return;
  }

  // Step 1: Extract reel content
  console.log(`${label} Extracting reel: ${reelUrl}`);
  let manifest;
  try {
    manifest = extractReel(reelUrl);
  } catch (err) {
    console.error(`${label} Extraction failed: ${err.message}`);
    await postComment(
      issueId,
      `⚠️ **Reel extraction failed**\n\nURL: ${reelUrl}\nError: \`${err.message.slice(0, 400)}\`\n\nThe reel may be private or removed.`
    );
    await updateIssue(issueId, { status: "done", comment: "Extraction failed — marked done." });
    return;
  }

  if (!manifest.ok) {
    const errMsg = (manifest.error ?? "unknown").slice(0, 300);
    console.error(`${label} Extraction not ok: ${errMsg}`);
    await postComment(
      issueId,
      `⚠️ **Reel extraction error**\n\nURL: ${reelUrl}\nError: ${errMsg}`
    );
    await updateIssue(issueId, { status: "done", comment: "Extraction returned error — marked done." });
    return;
  }

  // Step 2: Upload up to 2 keyframes
  const framePaths = (manifest.frames ?? []).slice(0, 2);
  const attachmentResults = [];
  for (const fp of framePaths) {
    if (!existsSync(fp)) continue;
    const att = await uploadFrame(issueId, fp);
    if (att?.id) attachmentResults.push(att);
    console.log(`${label} Frame uploaded: ${fp} → ${att?.id ?? "failed"}`);
  }

  // Step 3: Business analysis via Claude
  console.log(`${label} Running Claude analysis...`);
  let analysis;
  try {
    analysis = analyzeWithClaude(manifest);
  } catch (err) {
    console.error(`${label} Claude analysis failed: ${err.message}`);
    analysis = "_Business analysis unavailable — Claude CLI error. Please review manually._";
  }

  // Step 4: Build and post analysis comment
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

  const commentBody = [
    "## Reel Analysis",
    "",
    `**Source:** [${reelUrl}](${reelUrl})`,
    `**Uploader:** @${uploader} · ${duration}s`,
    "",
    analysis,
    frameSection,
    transcriptSection,
    "",
    "---",
    "_Analyzed by reel-analysis-worker ([AUR-2216](/AUR/issues/AUR-2216))_",
  ].join("\n");

  await postComment(issueId, commentBody);
  console.log(`${label} Analysis comment posted`);

  // Step 5: Mark done
  await updateIssue(issueId, {
    status: "done",
    comment: "Analysis complete — comment posted. Telegram relay (AUR-2215) will forward to user.",
  });
  console.log(`${label} Marked done ✓`);
}

// ── Main loop ────────────────────────────────────────────────────────────────
async function main() {
  console.log(
    `reel-analysis-worker starting (AUR-2216) — poll: ${POLL_INTERVAL_MS}ms, run-once: ${RUN_ONCE}`
  );

  let iteration = 0;
  while (true) {
    iteration++;
    console.log(`[poll #${iteration}] Checking for reel-intake issues...`);
    try {
      const issues = await findReelIntakeIssues();
      console.log(`[poll #${iteration}] Found ${issues.length} issue(s)`);
      for (const issue of issues) {
        try {
          await processIssue(issue);
        } catch (err) {
          console.error(`Error processing ${issue.identifier}: ${err.message}`);
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
