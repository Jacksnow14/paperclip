#!/usr/bin/env node
/**
 * verify-issue-comment.mjs
 *
 * Post a handoff/delivery comment AND verify it landed, in one command
 * (AUR-4613). Compliance with doctrine/deliverable-verification.md ("re-read
 * the artifact back from the store you wrote it to, and quote the identifier
 * and size in the claim") is cheaper than non-compliance: run this instead
 * of a bare POST and paste the printed line into your handoff.
 *
 * The verification is a READ-path re-GET, not the POST response: a write
 * response saying `201` is a success signal, not the outcome (AUR-3930,
 * AUR-4136, AUR-4184 class). The comment only counts once the comments LIST
 * endpoint — what the next reader will actually fetch — returns it with the
 * full body intact.
 *
 * Usage:
 *   node scripts/verify-issue-comment.mjs <issueId> <body-file> [minChars=2000]
 *
 *   <issueId>   Issue UUID or identifier (e.g. AUR-4613)
 *   <body-file> File containing the comment body (markdown)
 *   [minChars]  Minimum body length to accept (default 2000 — the
 *               check-delivery-claims.mjs threshold). Pass a smaller value
 *               deliberately for comments that are not delivery claims.
 *
 * On success prints exactly:  Verified: comment <id> (<N> chars)
 * On any failure: prints the failure to stderr and exits non-zero. If the
 * POST succeeded but the read-back failed, says so explicitly — do NOT
 * re-post blindly; check the thread first.
 *
 * Env vars required: PAPERCLIP_API_KEY (URL via scripts/lib/paperclip-api-base.mjs)
 */

import { readFileSync } from 'node:fs';
import { resolveApiBase } from './lib/paperclip-api-base.mjs';

export const DEFAULT_MIN_CHARS = 2000;

/**
 * Mirrors packages/shared/src/validators/text.ts normalizeEscapedLineBreaks.
 * multilineTextSchema applies this to every comment body server-side (AUR-5577),
 * so the stored body legitimately differs from what was posted whenever the
 * body contains a literal backslash-n / backslash-r / backslash-r-backslash-n
 * sequence. Duplicated here (not imported) because this script runs under
 * plain node, which cannot load the shared package's .ts source directly.
 */
function normalizeEscapedLineBreaks(value) {
  return value
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n');
}

/**
 * Locate the posted comment in the comments-list response and check the
 * body survived intact. Pure — used in tests.
 * @returns {{ ok: true, length: number } | { ok: false, reason: string }}
 */
export function verifyReadBack(comments, commentId, expectedBody) {
  const found = (comments ?? []).find((c) => c.id === commentId);
  if (!found) {
    return { ok: false, reason: `comment ${commentId} not returned by the comments list read path` };
  }
  const normalizedExpected = normalizeEscapedLineBreaks(expectedBody);
  if (found.body !== normalizedExpected) {
    return {
      ok: false,
      reason: `comment ${commentId} came back with a different body (${(found.body ?? '').length} chars vs ${normalizedExpected.length} posted)`,
    };
  }
  return { ok: true, length: found.body.length };
}

async function main(argv) {
  const [issueId, bodyFile, minCharsArg] = argv;
  if (!issueId || !bodyFile) {
    console.error('Usage: node scripts/verify-issue-comment.mjs <issueId> <body-file> [minChars=2000]');
    return 2;
  }
  const minChars = minCharsArg ? Number(minCharsArg) : DEFAULT_MIN_CHARS;
  if (!Number.isFinite(minChars) || minChars < 0) {
    console.error(`FAILED: minChars "${minCharsArg}" is not a number.`);
    return 2;
  }
  const apiKey = process.env.PAPERCLIP_API_KEY;
  if (!apiKey) {
    console.error('FAILED: PAPERCLIP_API_KEY must be set.');
    return 2;
  }

  let body;
  try {
    body = readFileSync(bodyFile, 'utf8');
  } catch (err) {
    console.error(`FAILED: cannot read body file ${bodyFile}: ${err.message}`);
    return 2;
  }
  if (body.length < minChars) {
    console.error(
      `FAILED: body is ${body.length} chars, below the ${minChars}-char minimum for a delivery claim. ` +
        'Write the substantive handoff (or pass a lower minChars if this is deliberately not a delivery claim). Nothing was posted.'
    );
    return 1;
  }

  const apiUrl = await resolveApiBase();
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  const postRes = await fetch(`${apiUrl}/api/issues/${issueId}/comments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ body }),
  });
  if (!postRes.ok) {
    console.error(`FAILED: POST comment → ${postRes.status} ${postRes.statusText}. Nothing verified.`);
    return 1;
  }
  const posted = await postRes.json();
  const commentId = posted?.id;
  if (!commentId) {
    console.error('FAILED: POST returned no comment id — write response is unusable. Check the thread before re-posting.');
    return 1;
  }

  // Read back from the LIST path (what the next reader fetches), paginated.
  const comments = [];
  const pageSize = 200;
  for (let page = 0; page < 50; page++) {
    const res = await fetch(
      `${apiUrl}/api/issues/${issueId}/comments?limit=${pageSize}&offset=${page * pageSize}`,
      { headers },
    );
    if (!res.ok) {
      console.error(
        `FAILED: comment ${commentId} was POSTed (201) but the read-back GET failed (${res.status}). ` +
          'Do not claim delivery, and do not blindly re-post — check the thread first.'
      );
      return 1;
    }
    const rows = await res.json();
    comments.push(...rows);
    if (rows.length < pageSize) break;
  }

  const verdict = verifyReadBack(comments, commentId, body);
  if (!verdict.ok) {
    console.error(`FAILED: POSTed but read-back failed: ${verdict.reason}. Do not claim delivery.`);
    return 1;
  }

  console.log(`Verified: comment ${commentId} (${verdict.length} chars)`);
  return 0;
}

const isMain = process.argv[1] && import.meta.url.endsWith(
  process.argv[1].replace(/\\/g, '/').split('/').pop()
);

if (isMain) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('FAILED:', err.message);
      process.exit(2);
    });
}
