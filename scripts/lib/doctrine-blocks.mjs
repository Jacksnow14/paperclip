/**
 * doctrine-blocks.mjs
 *
 * Pure, dependency-free helpers for mirroring a canonical doctrine block
 * (a `<!-- BEGIN:{slug} vN --> ... <!-- END:{slug} -->` region) into agent
 * instruction bundles (AGENTS.md).
 *
 * Paperclip has no include/transclusion mechanism for instruction bundles
 * (verified AUR-4089: `server/src/services/agent-instructions.ts` injects
 * exactly one file per agent), so a doctrine block is mirrored by copy and
 * drifts unless re-synced. These functions do the parse/diff/apply — no I/O,
 * so they are directly unit-testable (see doctrine-blocks.test.mjs and
 * sync-agent-doctrine.test.mjs).
 */

/** Matches a line-anchored `<!-- BEGIN:{slug} [vN[.N...]] -->` marker. */
const BEGIN_MARKER_RE = /^<!-- BEGIN:([a-z0-9-]+)(?: v\d+(?:\.\d+)*)? -->$/m;

/**
 * Extracts the canonical `{slug, block}` from a doctrine file's raw text.
 * `block` is the trimmed text from the BEGIN marker line through the END
 * marker line, inclusive — exactly what gets mirrored verbatim.
 *
 * Throws if no BEGIN marker is found, or if BEGIN has no matching
 * line-anchored END marker. Doctrine files without markers (pure reference
 * notes with no fleet-wide mirroring obligation) are expected to throw —
 * callers that scan a directory should treat that as "not a mirrored
 * doctrine file" rather than an error.
 */
export function extractCanonicalBlock(raw) {
  const beginMatch = BEGIN_MARKER_RE.exec(raw);
  if (!beginMatch) {
    throw new Error('no line-anchored BEGIN:{slug} marker found in canonical text');
  }
  const slug = beginMatch[1];
  const endRe = new RegExp(`^<!-- END:${slug} -->$`, 'm');
  const tail = raw.slice(beginMatch.index);
  const endMatch = endRe.exec(tail);
  if (!endMatch) {
    throw new Error(`canonical file has BEGIN:${slug} but no matching line-anchored END:${slug}`);
  }
  const block = tail.slice(0, endMatch.index + endMatch[0].length).trim();
  return { slug, block };
}

/** Byte range of the mirrored `{slug}` block within `contents`, or null if absent. */
export function findBlockRegion(contents, slug) {
  const begin = `<!-- BEGIN:${slug}`;
  const end = `<!-- END:${slug} -->`;
  const beginIdx = contents.indexOf(begin);
  if (beginIdx === -1) return null;
  const endIdx = contents.indexOf(end, beginIdx);
  if (endIdx === -1) return null;
  return { start: beginIdx, end: endIdx + end.length };
}

function appendBlock(contents, block) {
  const base = contents.replace(/\n+$/, '');
  return base.length > 0 ? `${base}\n\n${block}\n` : `${block}\n`;
}

function replaceBlockRegion(contents, region, block) {
  return contents.slice(0, region.start) + block + contents.slice(region.end);
}

/**
 * An existing block shorter than this fraction of the canonical block's
 * length is treated as a deliberate pointer stub, not drift. Matches
 * `doctrine/propagate.py`'s POINTER_TIER_RATIO exactly, so both tools agree
 * on what counts as a stub (confirmed live: routing-rationale-doctrine is
 * mirrored at two tiers — 5 of 15 agents intentionally carry an 894-byte
 * stub against an 11429-byte full block, a ~0.078 ratio, well under 0.5).
 */
export const POINTER_TIER_RATIO = 0.5;

/**
 * Diffs one canonical `{slug}` block against `contents` (an agent's
 * AGENTS.md text) and returns the verdict plus the contents that would
 * result from applying it.
 *
 * `options.tier` mirrors `doctrine/propagate.py --tier`:
 *   - "safe" (default): append where missing, replace full-tier blocks that
 *     differ, leave pointer stubs alone.
 *   - "full": only touch existing full-tier blocks; never append where
 *     missing, never touch stubs.
 *   - "all": overwrite every mirror, stubs included.
 *
 * Verdicts:
 *   - "unchanged":    block present and byte-identical (after trim) to canon.
 *   - "drifted":      full-tier block present but differs from canon.
 *   - "missing":      no BEGIN:{slug} marker at all, and tier allows appending.
 *   - "skip-missing": no BEGIN:{slug} marker, but tier is "full"/"all" so
 *                     appending is not this diff's job.
 *   - "stub":         existing block is a deliberate pointer stub (shorter
 *                     than canon * POINTER_TIER_RATIO) and tier != "all" —
 *                     not drift, left untouched.
 */
export function diffDoctrineBlock(contents, canonicalBlock, slug, options = {}) {
  const tier = options.tier ?? 'safe';
  const canonTrimmed = canonicalBlock.trim();
  const region = findBlockRegion(contents, slug);
  if (!region) {
    if (tier === 'full' || tier === 'all') {
      return { verdict: 'skip-missing', newContents: contents };
    }
    return { verdict: 'missing', newContents: appendBlock(contents, canonicalBlock) };
  }
  const existing = contents.slice(region.start, region.end).trim();
  if (existing.length < canonTrimmed.length * POINTER_TIER_RATIO && tier !== 'all') {
    return { verdict: 'stub', newContents: contents };
  }
  if (existing === canonTrimmed) {
    return { verdict: 'unchanged', newContents: contents };
  }
  return { verdict: 'drifted', newContents: replaceBlockRegion(contents, region, canonicalBlock) };
}

/**
 * Folds `diffDoctrineBlock` over every canonical block in `blocks`
 * (`[{ slug, block }, ...]`), applying each in turn so later blocks see
 * earlier blocks' edits. Pure — no I/O — so a caller can diff-only (ignore
 * `.contents`) or apply (write `.contents` back) using the same computation.
 *
 * Returns `{ contents, results }` where `results` is `[{ slug, verdict }]`
 * in the same order as `blocks`.
 */
export function applyAllBlocks(contents, blocks, options = {}) {
  let current = contents;
  const results = [];
  for (const { slug, block } of blocks) {
    const { verdict, newContents } = diffDoctrineBlock(current, block, slug, options);
    results.push({ slug, verdict });
    current = newContents;
  }
  return { contents: current, results };
}
