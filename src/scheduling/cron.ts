const CRON_FIELD_RANGES: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7],  // day of week (0 and 7 both Sunday)
];

const DAY_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

interface CronField {
  allowed: (value: number) => boolean;
  min: number;
  max: number;
}

export function parseCron(expression: string): CronField[] {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Cron expression "${expression}" must have exactly 5 fields (minute hour dom month dow), got ${parts.length}`,
    );
  }
  return parts.map((field, i) => parseCronField(field, ...CRON_FIELD_RANGES[i]!));
}

function parseCronField(field: string, min: number, max: number): CronField {
  const normalized = field.toLowerCase();

  if (normalized === '*') {
    return { allowed: () => true, min, max };
  }

  const values = new Set<number>();
  const segments = normalized.split(',');

  for (const segment of segments) {
    const stepMatch = segment.match(/^(.+?)\/(\d+)$/);
    let baseRange = segment;
    let step = 1;
    if (stepMatch) {
      baseRange = stepMatch[1]!;
      step = parseInt(stepMatch[2]!, 10);
      if (step < 1) throw new Error(`Invalid step "${step}" in cron field "${field}"`);
    }

    if (baseRange === '*') {
      for (let v = min; v <= max; v += step) {
        values.add(v);
      }
      continue;
    }

    const rangeMatch = baseRange.match(/^(.+?)-(.+)$/);
    let start: number;
    let end: number;
    if (rangeMatch) {
      start = resolveName(rangeMatch[1]!, min, max);
      end = resolveName(rangeMatch[2]!, min, max);
    } else {
      start = resolveName(baseRange, min, max);
      end = start;
    }

    if (start < min || start > max) {
      throw new Error(`Value ${start} out of range [${min},${max}] in cron field "${field}"`);
    }
    if (end < min || end > max) {
      throw new Error(`Value ${end} out of range [${min},${max}] in cron field "${field}"`);
    }

    for (let v = start; v <= end; v += step) {
      values.add(v);
    }
  }

  const arr = [...values].sort((a, b) => a - b);
  return {
    allowed: (v: number) => values.has(v),
    min: arr[0] ?? min,
    max: arr[arr.length - 1] ?? max,
  };
}

function resolveName(token: string, min: number, max: number): number {
  const n = parseInt(token, 10);
  if (!isNaN(n)) return n;
  if (max === 6 || max === 7) {
    const d = DAY_NAMES[token];
    if (d !== undefined) return d;
  }
  if (max === 12) {
    const m = MONTH_NAMES[token];
    if (m !== undefined) return m;
  }
  throw new Error(`Cannot resolve "${token}" in cron field (range ${min}-${max})`);
}

export function nextCronTime(expression: string, from?: Date): Date {
  return nextCronTimeImpl(parseCron(expression), from ?? new Date());
}

export function nextCronTimeImpl(fields: CronField[], from: Date): Date {
  const MAX_ITERATIONS = 366 * 24 * 60; // 2 years in minutes
  const current = new Date(from);
  current.setSeconds(0, 0);
  current.setMinutes(current.getMinutes() + 1); // Start from next minute

  const [minField, hourField, domField, monthField, dowField] = fields as [
    CronField, CronField, CronField, CronField, CronField,
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const minute = current.getMinutes();
    const hour = current.getHours();
    const dom = current.getDate();
    const month = current.getMonth() + 1; // 1-indexed
    const year = current.getFullYear();

    if (!minField.allowed(minute)) {
      current.setMinutes(minute + 1, 0, 0);
      continue;
    }
    if (!hourField.allowed(hour)) {
      current.setMinutes(0, 0, 0);
      current.setHours(hour + 1);
      continue;
    }

    const dow = current.getDay(); // 0=Sun
    const dowMatch = dow === 0
      ? dowField.allowed(0) || dowField.allowed(7)
      : dowField.allowed(dow);
    const domMatch = domField.allowed(dom);

    // For cron, if both dom and dow are specified (non-*), they OR together.
    // If only one is specified, it ANDs normally.
    const domSpecified = !isWildcard(domField, 1, 31);
    const dowSpecified = !isWildcard(dowField, 0, 7);

    let dayMatch: boolean;
    if (domSpecified && dowSpecified) {
      dayMatch = domMatch || dowMatch;
    } else {
      dayMatch = domMatch && dowMatch;
    }

    if (!dayMatch) {
      current.setMinutes(0, 0, 0);
      current.setHours(0);
      current.setDate(dom + 1);
      continue;
    }

    if (!monthField.allowed(month)) {
      current.setMinutes(0, 0, 0);
      current.setHours(0);
      current.setDate(1);
      current.setMonth(month); // month is 0-indexed here, so this advances by 1
      continue;
    }

    return new Date(current);
  }

  throw new Error(`No matching time found for cron expression within 2 years`);
}

function isWildcard(field: CronField, min: number, max: number): boolean {
  for (let v = min; v <= max; v++) {
    if (!field.allowed(v)) return false;
  }
  return true;
}

/**
 * Returns the number of milliseconds until the next cron fire time.
 */
export function msUntilNextCron(expression: string, from?: Date): number {
  return nextCronTime(expression, from).getTime() - (from ?? new Date()).getTime();
}
