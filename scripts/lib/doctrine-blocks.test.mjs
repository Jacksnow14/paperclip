import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractCanonicalBlock,
  findBlockRegion,
  diffDoctrineBlock,
  applyAllBlocks,
  POINTER_TIER_RATIO,
} from './doctrine-blocks.mjs';

const CANON_RAW = `# Canonical source — example doctrine

Some header prose that must NOT be mirrored.

<!-- BEGIN:example-doctrine v1 -->
<!-- CANONICAL SOURCE: /doctrine/example.md -->
## Example doctrine

Body text.
<!-- END:example-doctrine -->
`;

test('extractCanonicalBlock: finds slug and trims to the marker region only', () => {
  const { slug, block } = extractCanonicalBlock(CANON_RAW);
  assert.equal(slug, 'example-doctrine');
  assert.ok(block.startsWith('<!-- BEGIN:example-doctrine v1 -->'));
  assert.ok(block.endsWith('<!-- END:example-doctrine -->'));
  assert.ok(!block.includes('must NOT be mirrored'));
});

test('extractCanonicalBlock: accepts dotted minor versions (v1.1)', () => {
  const raw = '<!-- BEGIN:foo v1.1 -->\nbody\n<!-- END:foo -->';
  const { slug } = extractCanonicalBlock(raw);
  assert.equal(slug, 'foo');
});

test('extractCanonicalBlock: throws when no BEGIN marker present', () => {
  assert.throws(() => extractCanonicalBlock('just prose, no markers'), /no line-anchored BEGIN/);
});

test('extractCanonicalBlock: throws when BEGIN has no matching END', () => {
  assert.throws(
    () => extractCanonicalBlock('<!-- BEGIN:foo v1 -->\nbody, never closed'),
    /no matching line-anchored END/,
  );
});

test('extractCanonicalBlock: does not match markers described in prose (AUR-3924-class bug)', () => {
  // A canonical file that merely *describes* its own markers in backticked prose
  // must not have that description mistaken for the real marker line — matching
  // that class of near-miss text previously yielded an 88-byte "block" that would
  // wipe the real doctrine (see doctrine/propagate.py's load_canon comment).
  const raw = [
    'This doctrine is mirrored between `<!-- BEGIN:foo v1 -->` and `<!-- END:foo -->`.',
    '',
    '<!-- BEGIN:foo v1 -->',
    'real body',
    '<!-- END:foo -->',
  ].join('\n');
  const { block } = extractCanonicalBlock(raw);
  assert.ok(block.includes('real body'));
  assert.ok(!block.includes('This doctrine is mirrored'));
});

const { block: CANON_BLOCK } = extractCanonicalBlock(CANON_RAW);

test('findBlockRegion: null when slug absent', () => {
  assert.equal(findBlockRegion('no markers here', 'example-doctrine'), null);
});

test('findBlockRegion: locates start/end byte offsets', () => {
  const contents = `preamble\n\n${CANON_BLOCK}\n`;
  const region = findBlockRegion(contents, 'example-doctrine');
  assert.ok(region);
  assert.equal(contents.slice(region.start, region.end), CANON_BLOCK);
});

test('diffDoctrineBlock: missing -> appends with blank-line separation', () => {
  const result = diffDoctrineBlock('You are an agent.', CANON_BLOCK, 'example-doctrine');
  assert.equal(result.verdict, 'missing');
  assert.equal(result.newContents, `You are an agent.\n\n${CANON_BLOCK}\n`);
});

test('diffDoctrineBlock: missing on empty file -> just the block, no leading blank lines', () => {
  const result = diffDoctrineBlock('', CANON_BLOCK, 'example-doctrine');
  assert.equal(result.verdict, 'missing');
  assert.equal(result.newContents, `${CANON_BLOCK}\n`);
});

test('diffDoctrineBlock: unchanged when block already present and identical', () => {
  const contents = `You are an agent.\n\n${CANON_BLOCK}\n`;
  const result = diffDoctrineBlock(contents, CANON_BLOCK, 'example-doctrine');
  assert.equal(result.verdict, 'unchanged');
  assert.equal(result.newContents, contents);
});

test('diffDoctrineBlock: drifted -> replaces only the marker region, preserves surrounding text', () => {
  const stale = [
    '<!-- BEGIN:example-doctrine v1 -->',
    '<!-- CANONICAL SOURCE: /doctrine/example.md -->',
    '## Example doctrine (OLD, hand-edited)',
    '<!-- END:example-doctrine -->',
  ].join('\n');
  const contents = `before\n\n${stale}\n\nafter`;
  const result = diffDoctrineBlock(contents, CANON_BLOCK, 'example-doctrine');
  assert.equal(result.verdict, 'drifted');
  assert.equal(result.newContents, `before\n\n${CANON_BLOCK}\n\nafter`);
  assert.ok(result.newContents.includes('before'));
  assert.ok(result.newContents.includes('after'));
  assert.ok(!result.newContents.includes('OLD, hand-edited'));
});

test('diffDoctrineBlock: idempotent — applying twice produces no further change', () => {
  const first = diffDoctrineBlock('You are an agent.', CANON_BLOCK, 'example-doctrine');
  const second = diffDoctrineBlock(first.newContents, CANON_BLOCK, 'example-doctrine');
  assert.equal(second.verdict, 'unchanged');
  assert.equal(second.newContents, first.newContents);
});

test('applyAllBlocks: folds multiple slugs in order, each seeing prior edits', () => {
  const blockA = '<!-- BEGIN:a v1 -->\nA body\n<!-- END:a -->';
  const blockB = '<!-- BEGIN:b v1 -->\nB body\n<!-- END:b -->';
  const { contents, results } = applyAllBlocks('You are an agent.', [
    { slug: 'a', block: blockA },
    { slug: 'b', block: blockB },
  ]);
  assert.deepEqual(results, [
    { slug: 'a', verdict: 'missing' },
    { slug: 'b', verdict: 'missing' },
  ]);
  assert.ok(contents.includes(blockA));
  assert.ok(contents.includes(blockB));
  // Re-applying to the folded result is fully idempotent.
  const again = applyAllBlocks(contents, [
    { slug: 'a', block: blockA },
    { slug: 'b', block: blockB },
  ]);
  assert.deepEqual(again.results, [
    { slug: 'a', verdict: 'unchanged' },
    { slug: 'b', verdict: 'unchanged' },
  ]);
  assert.equal(again.contents, contents);
});

test('applyAllBlocks: reports drifted for one slug and missing for another independently', () => {
  const blockA = '<!-- BEGIN:a v1 -->\nA body\n<!-- END:a -->';
  const staleA = '<!-- BEGIN:a v1 -->\nSTALE\n<!-- END:a -->';
  const blockB = '<!-- BEGIN:b v1 -->\nB body\n<!-- END:b -->';
  const { results } = applyAllBlocks(staleA, [
    { slug: 'a', block: blockA },
    { slug: 'b', block: blockB },
  ]);
  assert.deepEqual(results, [
    { slug: 'a', verdict: 'drifted' },
    { slug: 'b', verdict: 'missing' },
  ]);
});

// --- Pointer-stub tiering (matches doctrine/propagate.py --tier semantics) ---

const LONG_CANON_BLOCK =
  '<!-- BEGIN:routing-rationale-doctrine v1 -->\n' + 'x'.repeat(2000) + '\n<!-- END:routing-rationale-doctrine -->';
const STUB_BLOCK =
  '<!-- BEGIN:routing-rationale-doctrine v1 -->\n' + 'stub pointer text'.repeat(5) + '\n<!-- END:routing-rationale-doctrine -->';

test('POINTER_TIER_RATIO matches propagate.py (0.5)', () => {
  assert.equal(POINTER_TIER_RATIO, 0.5);
});

test('diffDoctrineBlock: default (safe) tier treats a short existing block as a stub, not drift', () => {
  const contents = `preamble\n\n${STUB_BLOCK}\n`;
  const result = diffDoctrineBlock(contents, LONG_CANON_BLOCK, 'routing-rationale-doctrine');
  assert.equal(result.verdict, 'stub');
  assert.equal(result.newContents, contents, 'stub tier must be left untouched');
});

test('diffDoctrineBlock: --tier all overwrites a stub with the full canonical block', () => {
  const contents = `preamble\n\n${STUB_BLOCK}\n`;
  const result = diffDoctrineBlock(contents, LONG_CANON_BLOCK, 'routing-rationale-doctrine', { tier: 'all' });
  assert.equal(result.verdict, 'drifted');
  assert.ok(result.newContents.includes(LONG_CANON_BLOCK));
  assert.ok(!result.newContents.includes('stub pointer text'));
});

test('diffDoctrineBlock: --tier full does not append a missing block', () => {
  const result = diffDoctrineBlock('You are an agent.', LONG_CANON_BLOCK, 'routing-rationale-doctrine', {
    tier: 'full',
  });
  assert.equal(result.verdict, 'skip-missing');
  assert.equal(result.newContents, 'You are an agent.');
});

test('diffDoctrineBlock: --tier all also skips a missing block (matches propagate.py: only "safe" appends)', () => {
  const result = diffDoctrineBlock('You are an agent.', LONG_CANON_BLOCK, 'routing-rationale-doctrine', {
    tier: 'all',
  });
  assert.equal(result.verdict, 'skip-missing');
  assert.equal(result.newContents, 'You are an agent.');
});

test('diffDoctrineBlock: safe tier still flags drift for a full-tier block that materially differs', () => {
  const staleFull =
    '<!-- BEGIN:routing-rationale-doctrine v1 -->\n' + 'y'.repeat(1900) + '\n<!-- END:routing-rationale-doctrine -->';
  const contents = `preamble\n\n${staleFull}\n`;
  const result = diffDoctrineBlock(contents, LONG_CANON_BLOCK, 'routing-rationale-doctrine');
  assert.equal(result.verdict, 'drifted');
});
