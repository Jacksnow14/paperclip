import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCron, nextCronTick, nextCronTickFromExpression } from './routine-cron.mjs';

test('parseCron expands a daily cron expression', () => {
  const cron = parseCron('30 6 * * *');
  assert.deepEqual(cron.minutes, [30]);
  assert.deepEqual(cron.hours, [6]);
  assert.equal(cron.daysOfMonth.length, 31);
  assert.equal(cron.months.length, 12);
  assert.equal(cron.daysOfWeek.length, 7);
});

test('nextCronTick finds the same-day fire when still ahead of it', () => {
  const cron = parseCron('30 6 * * *');
  const after = new Date('2026-08-06T00:00:00.000Z');
  const next = nextCronTick(cron, after);
  assert.equal(next.toISOString(), '2026-08-06T06:30:00.000Z');
});

test('nextCronTick rolls to the next day once past today\'s fire', () => {
  const cron = parseCron('30 6 * * *');
  const after = new Date('2026-08-06T06:30:00.000Z'); // exactly at the fire
  const next = nextCronTick(cron, after);
  assert.equal(next.toISOString(), '2026-08-07T06:30:00.000Z');
});

test('nextCronTickFromExpression matches the deliverability routine schedule (42a19235, "30 6 * * *")', () => {
  const next = nextCronTickFromExpression('30 6 * * *', new Date('2026-07-29T12:34:01.894Z'));
  assert.equal(next.toISOString(), '2026-07-30T06:30:00.000Z');
});

test('every-6-hours schedule steps correctly ("0 */6 * * *")', () => {
  const cron = parseCron('0 */6 * * *');
  assert.deepEqual(cron.hours, [0, 6, 12, 18]);
  const next = nextCronTick(cron, new Date('2026-08-06T11:33:09.156Z'));
  assert.equal(next.toISOString(), '2026-08-06T12:00:00.000Z');
});
