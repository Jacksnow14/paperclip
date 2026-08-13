/**
 * routine-cron.mjs (AUR-5042)
 *
 * Standalone JS port of server/src/services/cron.ts's 5-field cron parser +
 * next-tick calculator, for use in host-cron scripts (which cannot import
 * server TypeScript directly). Kept byte-for-byte equivalent in behavior so
 * "expected fire time" here always agrees with what the scheduler itself
 * would compute. If server/src/services/cron.ts changes its semantics, port
 * the change here too.
 */

const FIELD_SPECS = [
  { min: 0, max: 59, name: 'minute' },
  { min: 0, max: 23, name: 'hour' },
  { min: 1, max: 31, name: 'day of month' },
  { min: 1, max: 12, name: 'month' },
  { min: 0, max: 6, name: 'day of week' },
];

function validateBounds(value, spec) {
  if (value < spec.min || value > spec.max) {
    throw new Error(`Value ${value} out of range [${spec.min}–${spec.max}] for cron ${spec.name} field`);
  }
}

function parseField(token, spec) {
  const values = new Set();
  const parts = token.split(',');

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === '') throw new Error(`Empty element in cron ${spec.name} field`);

    const slashIdx = trimmed.indexOf('/');
    if (slashIdx !== -1) {
      const base = trimmed.slice(0, slashIdx);
      const stepStr = trimmed.slice(slashIdx + 1);
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) throw new Error(`Invalid step "${stepStr}" in cron ${spec.name} field`);

      let rangeStart = spec.min;
      let rangeEnd = spec.max;

      if (base === '*') {
        // */S - every S from field min
      } else if (base.includes('-')) {
        const [a, b] = base.split('-').map((s) => parseInt(s, 10));
        if (isNaN(a) || isNaN(b)) throw new Error(`Invalid range "${base}" in cron ${spec.name} field`);
        rangeStart = a;
        rangeEnd = b;
      } else {
        const start = parseInt(base, 10);
        if (isNaN(start)) throw new Error(`Invalid start "${base}" in cron ${spec.name} field`);
        rangeStart = start;
      }

      validateBounds(rangeStart, spec);
      validateBounds(rangeEnd, spec);
      for (let i = rangeStart; i <= rangeEnd; i += step) values.add(i);
      continue;
    }

    if (trimmed.includes('-')) {
      const [aStr, bStr] = trimmed.split('-');
      const a = parseInt(aStr, 10);
      const b = parseInt(bStr, 10);
      if (isNaN(a) || isNaN(b)) throw new Error(`Invalid range "${trimmed}" in cron ${spec.name} field`);
      validateBounds(a, spec);
      validateBounds(b, spec);
      if (a > b) throw new Error(`Invalid range ${a}-${b} in cron ${spec.name} field (start > end)`);
      for (let i = a; i <= b; i++) values.add(i);
      continue;
    }

    if (trimmed === '*') {
      for (let i = spec.min; i <= spec.max; i++) values.add(i);
      continue;
    }

    const val = parseInt(trimmed, 10);
    if (isNaN(val)) throw new Error(`Invalid value "${trimmed}" in cron ${spec.name} field`);
    validateBounds(val, spec);
    values.add(val);
  }

  if (values.size === 0) throw new Error(`Empty result for cron ${spec.name} field`);
  return [...values].sort((a, b) => a - b);
}

export function parseCron(expression) {
  const trimmed = (expression ?? '').trim();
  if (!trimmed) throw new Error('Cron expression must not be empty');

  const tokens = trimmed.split(/\s+/);
  if (tokens.length !== 5) {
    throw new Error(`Cron expression must have exactly 5 fields, got ${tokens.length}: "${trimmed}"`);
  }

  return {
    minutes: parseField(tokens[0], FIELD_SPECS[0]),
    hours: parseField(tokens[1], FIELD_SPECS[1]),
    daysOfMonth: parseField(tokens[2], FIELD_SPECS[2]),
    months: parseField(tokens[3], FIELD_SPECS[3]),
    daysOfWeek: parseField(tokens[4], FIELD_SPECS[4]),
  };
}

function findNext(sortedValues, current) {
  for (const v of sortedValues) if (v > current) return v;
  return null;
}

function advanceToNextMonth(d, months) {
  let year = d.getUTCFullYear();
  let month = d.getUTCMonth() + 1;
  for (let i = 0; i < 48; i++) {
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
    if (months.includes(month)) {
      d.setUTCFullYear(year, month - 1, 1);
      d.setUTCHours(0, 0, 0, 0);
      return;
    }
  }
}

/**
 * Next matching Date strictly after `after`, or null if none found within a
 * ~4 year safety window (impossible schedule, e.g. Feb 30).
 */
export function nextCronTick(cron, after) {
  const d = new Date(after.getTime());
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);

  const MAX_CRON_SEARCH_YEARS = 4;
  const maxIterations = MAX_CRON_SEARCH_YEARS * 366 * 24 * 60;

  for (let i = 0; i < maxIterations; i++) {
    const month = d.getUTCMonth() + 1;
    const dayOfMonth = d.getUTCDate();
    const dayOfWeek = d.getUTCDay();
    const hour = d.getUTCHours();
    const minute = d.getUTCMinutes();

    if (!cron.months.includes(month)) {
      advanceToNextMonth(d, cron.months);
      continue;
    }

    if (!cron.daysOfMonth.includes(dayOfMonth) || !cron.daysOfWeek.includes(dayOfWeek)) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }

    if (!cron.hours.includes(hour)) {
      const nextHour = findNext(cron.hours, hour);
      if (nextHour !== null) {
        d.setUTCHours(nextHour, 0, 0, 0);
      } else {
        d.setUTCDate(d.getUTCDate() + 1);
        d.setUTCHours(0, 0, 0, 0);
      }
      continue;
    }

    if (!cron.minutes.includes(minute)) {
      const nextMin = findNext(cron.minutes, minute);
      if (nextMin !== null) {
        d.setUTCMinutes(nextMin, 0, 0);
      } else {
        d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
      }
      continue;
    }

    return new Date(d.getTime());
  }

  return null;
}

export function nextCronTickFromExpression(expression, after = new Date()) {
  const cron = parseCron(expression);
  return nextCronTick(cron, after);
}
