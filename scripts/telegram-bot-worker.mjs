#!/usr/bin/env node
/**
 * AUR-2215: Telegram bot long-poll worker — reel intake channel.
 *
 * Run on the predictor host or alongside existing schedulers:
 *   TELEGRAM_BOT_TOKEN=... PAPERCLIP_API_URL=... PAPERCLIP_API_KEY=... \
 *   PAPERCLIP_COMPANY_ID=... node scripts/telegram-bot-worker.mjs
 *
 * Behaviour (AUR-2201 "no empty issues" redesign):
 *   1. Long-poll Telegram getUpdates (30s timeout).
 *   2. On a message containing an instagram.com/(reel|p)/ URL:
 *      - Drop a JSON job into REEL_QUEUE_DIR. We do NOT create a board issue
 *        here — the analysis worker creates the issue only once it has a real
 *        analysis, so a board card always means "something was analyzed".
 *   3. Every RELAY_POLL_INTERVAL_MS (default 60s) scan REEL_RESULT_DIR for
 *      finished jobs and relay the analysis (or a short failure notice) back to
 *      the originating Telegram chat, then delete the result file.
 *
 * State file: ./telegram-bot-state.json (only the Telegram update offset).
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveApiBase } from "./lib/paperclip-api-base.mjs";

// ── Config ──────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
let API_URL = "";
const API_KEY = process.env.PAPERCLIP_API_KEY;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
const STATE_FILE = process.env.STATE_FILE ?? new URL("telegram-bot-state.json", import.meta.url).pathname;
const RELAY_POLL_INTERVAL_MS = Number(process.env.RELAY_POLL_INTERVAL_MS ?? 60_000);
// Shared file queue with the analysis worker.
const REEL_QUEUE_DIR = process.env.REEL_QUEUE_DIR ?? "/home/ievgen/paperclip-data/reel-queue";
const REEL_RESULT_DIR = process.env.REEL_RESULT_DIR ?? "/home/ievgen/paperclip-data/reel-results";

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}
if (!API_KEY || !COMPANY_ID) {
  console.error("PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID are required");
  process.exit(1);
}

mkdirSync(REEL_QUEUE_DIR, { recursive: true });
mkdirSync(REEL_RESULT_DIR, { recursive: true });

const TG_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
const INSTAGRAM_REEL_RE = /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|p)\/[\w-]+\/?[^\s]*/i;

// ── State persistence ────────────────────────────────────────────────────────
// state = { offset: number }  (just the Telegram update cursor)
function loadState() {
  if (existsSync(STATE_FILE)) {
    try {
      const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      return { offset: s.offset ?? 0 };
    } catch { /* corrupt → start fresh */ }
  }
  return { offset: 0 };
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

// ── Intake queue ─────────────────────────────────────────────────────────────
function enqueueReel({ reelUrl, chatId, messageId, receivedAt }) {
  // Unique, idempotent per Telegram message so the same forward never queues twice.
  const queueId = `${chatId}-${messageId}`;
  const path = join(REEL_QUEUE_DIR, `${queueId}.json`);
  writeFileSync(path, JSON.stringify({
    queueId, reelUrl, chatId, messageId, receivedAt, attempts: 0,
  }, null, 2));
  return queueId;
}

// ── Relay: forward finished analyses (and failures) back to chat ─────────────
async function relayResults() {
  let files;
  try {
    files = readdirSync(REEL_RESULT_DIR).filter(f => f.endsWith(".json"));
  } catch {
    return;
  }
  for (const f of files) {
    const path = join(REEL_RESULT_DIR, f);
    let result;
    try {
      result = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      console.warn(`Skipping unreadable result file ${f}: ${err.message}`);
      continue;
    }
    try {
      if (result.status === "done" && result.analysis) {
        await sendMessage(result.chatId, result.analysis.slice(0, 4000));
        console.log(`relay → chat ${result.chatId}: analysis for ${result.issueIdentifier ?? result.reelUrl}`);
      } else if (result.status === "failed") {
        await sendMessage(
          result.chatId,
          `⚠️ Couldn't analyze that reel after ${result.attempts ?? "several"} tries — it may be private, removed, or Instagram is rate-limiting. Try resending it later.\n${result.reelUrl ?? ""}`.trim(),
        );
        console.log(`relay → chat ${result.chatId}: failure for ${result.reelUrl}`);
      }
      // Delivered (or nothing to deliver) — clear the result file.
      unlinkSync(path);
    } catch (err) {
      console.warn(`relay failed for ${f}:`, err.message);
      // Leave the file in place to retry next cycle.
    }
  }
}

// ── Main loop ────────────────────────────────────────────────────────────────
async function main() {
  API_URL = await resolveApiBase();
  console.log("telegram-bot-worker: starting (AUR-2215/AUR-2201 queue mode)");
  const state = loadState();

  // Start relay polling in parallel (fire-and-forget interval).
  const relayLoop = async () => {
    while (true) {
      await sleep(RELAY_POLL_INTERVAL_MS);
      try {
        await relayResults();
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
        const queueId = enqueueReel({ reelUrl, chatId, messageId, receivedAt: msg.date });
        await sendMessage(
          chatId,
          `Got it! Analyzing this reel — I'll send the analysis here when it's ready. 📥`,
        );
        console.log(`queued reel ${reelUrl} as ${queueId}`);
      } catch (err) {
        console.error(`failed to queue reel ${reelUrl}:`, err.message);
        try {
          await sendMessage(chatId, `⚠️ Something went wrong queuing that reel. Please try again.`);
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
