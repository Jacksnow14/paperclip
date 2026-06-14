#!/usr/bin/env node
/**
 * AUR-2215: Telegram bot long-poll worker — reel intake channel.
 *
 * Run on the predictor host or alongside existing schedulers:
 *   TELEGRAM_BOT_TOKEN=... PAPERCLIP_API_URL=... PAPERCLIP_API_KEY=... \
 *   PAPERCLIP_COMPANY_ID=... node scripts/telegram-bot-worker.mjs
 *
 * Behaviour:
 *   1. Long-poll Telegram getUpdates (30s timeout).
 *   2. On a message containing an instagram.com/(reel|p)/ URL:
 *      - Create a Paperclip issue (reel-intake label) via the API.
 *      - Persist chatId→issueId in a local JSON state file so the relay
 *        worker can look it up across restarts.
 *   3. Every RELAY_POLL_INTERVAL_MS (default 60s) check tracked issues for
 *      new comments and relay the first analyst comment back to the originating
 *      Telegram chat.
 *
 * State file: ./telegram-bot-state.json (next to script, or set STATE_FILE env).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

// ── Config ──────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_URL = process.env.PAPERCLIP_API_URL ?? "http://localhost:3000";
const API_KEY = process.env.PAPERCLIP_API_KEY;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
const STATE_FILE = process.env.STATE_FILE ?? new URL("telegram-bot-state.json", import.meta.url).pathname;
const RELAY_POLL_INTERVAL_MS = Number(process.env.RELAY_POLL_INTERVAL_MS ?? 60_000);
// Optional: set to a Paperclip agent ID to assign intake issues to that agent.
const ASSIGNEE_AGENT_ID = process.env.TELEGRAM_INTAKE_ASSIGNEE_AGENT_ID ?? null;

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}
if (!API_KEY || !COMPANY_ID) {
  console.error("PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID are required");
  process.exit(1);
}

const TG_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
const INSTAGRAM_REEL_RE = /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|p)\/[\w-]+\/?[^\s]*/i;

// ── State persistence ────────────────────────────────────────────────────────
// state = { offset: number, tracked: { [issueId]: { chatId, lastSeenCommentIdx } } }
function loadState() {
  if (existsSync(STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, "utf8"));
    } catch { /* corrupt → start fresh */ }
  }
  return { offset: 0, tracked: {} };
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Telegram helpers ─────────────────────────────────────────────────────────
async function tgCall(method, body = {}) {
  const res = await fetch(`${TG_BASE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method} failed: ${JSON.stringify(json)}`);
  return json.result;
}

async function getUpdates(offset, timeoutSec = 30) {
  return tgCall("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message"] });
}

async function sendMessage(chatId, text, { markdown = false } = {}) {
  const body = { chat_id: chatId, text };
  if (markdown) body.parse_mode = "Markdown";
  try {
    return await tgCall("sendMessage", body);
  } catch (err) {
    // Telegram's legacy Markdown parser rejects unbalanced entities; retry as
    // plain text so relayed analysis is never dropped on a formatting error.
    if (markdown) {
      return tgCall("sendMessage", { chat_id: chatId, text });
    }
    throw err;
  }
}

// ── Paperclip helpers ────────────────────────────────────────────────────────
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
    // These are "saw something interesting, evaluate when you can" intakes, not
    // urgent work — low priority so they queue behind real tasks. Override with
    // TELEGRAM_INTAKE_PRIORITY if a batch needs bumping.
    priority: process.env.TELEGRAM_INTAKE_PRIORITY ?? "low",
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

async function getIssueComments(issueId) {
  const res = await fetch(`${API_URL}/api/issues/${issueId}/comments?order=asc`, {
    headers: { "Authorization": `Bearer ${API_KEY}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.comments ?? data ?? [];
}

async function getIssueById(issueId) {
  const res = await fetch(`${API_URL}/api/issues/${issueId}`, {
    headers: { "Authorization": `Bearer ${API_KEY}` },
  });
  if (!res.ok) return null;
  return res.json();
}

// ── Issue creation ───────────────────────────────────────────────────────────
function buildIssueTitle(reelUrl) {
  return `[reel-intake] ${reelUrl}`.slice(0, 255);
}

function buildIssueDescription(reelUrl, chatId, messageId, receivedAt) {
  return [
    `**Inbound reel shared via Telegram bot**`,
    ``,
    `- **Reel URL:** ${reelUrl}`,
    `- **Telegram chat ID:** \`${chatId}\``,
    `- **Telegram message ID:** \`${messageId}\``,
    `- **Received:** ${new Date(receivedAt * 1000).toISOString()}`,
    ``,
    `exec.labels: reel-intake`,
  ].join("\n");
}

// ── Relay: check tracked issues for new comments ─────────────────────────────
async function relayNewComments(state) {
  for (const [issueId, entry] of Object.entries(state.tracked)) {
    try {
      // Check if issue is done/cancelled — stop tracking it.
      const issue = await getIssueById(issueId);
      if (issue && (issue.status === "done" || issue.status === "cancelled")) {
        // One final relay if there are unread comments, then drop tracking.
      }

      const comments = await getIssueComments(issueId);
      // Relay comments that appeared after the ones we've already sent.
      // lastSeenCommentIdx is an index into the sorted comments array.
      const lastSeen = entry.lastSeenCommentIdx ?? 0;
      const newComments = comments.slice(lastSeen);

      for (const comment of newComments) {
        // Only relay non-system comments (agent/user authored).
        if (comment.authorType === "system") continue;

        const body = (comment.body ?? "").trim();
        if (!body) continue;

        // Relay only substantive analysis output, not internal status one-liners
        // (e.g. the analysis worker's "Analysis complete — comment posted" PATCH
        // comment). The analysis comment is a multi-line markdown block.
        const isAnalysis = body.includes("## Reel Analysis") || body.length > 200;
        if (!isAnalysis) continue;

        await sendMessage(entry.chatId, body.slice(0, 4000));
        console.log(`relay → chat ${entry.chatId} from issue ${issueId}: ${body.slice(0, 80)}`);
      }

      entry.lastSeenCommentIdx = comments.length;

      // Stop tracking resolved issues.
      if (issue && (issue.status === "done" || issue.status === "cancelled")) {
        delete state.tracked[issueId];
      }
    } catch (err) {
      console.warn(`relay check failed for issue ${issueId}:`, err.message);
    }
  }
}

// ── Main loop ────────────────────────────────────────────────────────────────
async function main() {
  console.log("telegram-bot-worker: starting (AUR-2215)");
  const state = loadState();

  // Start relay polling in parallel (fire-and-forget interval).
  const relayLoop = async () => {
    while (true) {
      await sleep(RELAY_POLL_INTERVAL_MS);
      try {
        await relayNewComments(state);
        saveState(state);
      } catch (err) {
        console.warn("relay loop error:", err.message);
      }
    }
  };
  relayLoop().catch((err) => console.error("relay loop fatal:", err));

  while (true) {
    let updates;
    try {
      updates = await getUpdates(state.offset, 30);
    } catch (err) {
      console.warn("getUpdates error:", err.message);
      await sleep(5_000);
      continue;
    }

    for (const update of updates) {
      state.offset = update.update_id + 1;

      const msg = update.message;
      if (!msg) continue;

      const text = msg.text ?? msg.caption ?? "";
      const urlMatch = text.match(INSTAGRAM_REEL_RE);
      if (!urlMatch) continue;

      const reelUrl = urlMatch[0];
      const chatId = msg.chat.id;
      const messageId = msg.message_id;

      console.log(`received reel URL from chat ${chatId}: ${reelUrl}`);

      try {
        await sendMessage(chatId, `Got it! Processing reel: ${reelUrl} 📥`);

        const title = buildIssueTitle(reelUrl);
        const description = buildIssueDescription(reelUrl, chatId, messageId, msg.date);
        const issue = await createIssue(title, description);

        state.tracked[issue.id] = {
          chatId,
          lastSeenCommentIdx: 0,
        };
        saveState(state);

        const issueRef = issue.identifier ?? issue.id;
        await sendMessage(
          chatId,
          `✅ Issue created: *${issueRef}* — I'll send you the analysis when it's ready.`,
          { markdown: true },
        );
        console.log(`created issue ${issue.id} for reel ${reelUrl}`);
      } catch (err) {
        console.error(`failed to create issue for reel ${reelUrl}:`, err.message);
        try {
          await sendMessage(chatId, `⚠️ Something went wrong creating the intake issue. Please try again.`);
        } catch { /* best-effort */ }
      }
    }

    saveState(state);
  }
}

main().catch((err) => {
  console.error("telegram-bot-worker fatal:", err);
  process.exit(1);
});
