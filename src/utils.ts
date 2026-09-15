import type { DateRange, TimeEntry } from './types.js';

export type Period = 'today' | 'yesterday' | 'week' | 'lastWeek' | 'month' | 'lastMonth';

export const PERIODS: readonly Period[] = [
  'today',
  'yesterday',
  'week',
  'lastWeek',
  'month',
  'lastMonth',
];

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function endOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

function mondayOf(date: Date): Date {
  const monday = startOfDay(date);
  const offset = (monday.getDay() + 6) % 7;
  monday.setDate(monday.getDate() - offset);
  return monday;
}

/** Local-time range for a named period. `end` is inclusive (end of day for past periods). */
export function periodRange(period: Period, now: Date = new Date()): DateRange {
  switch (period) {
    case 'today':
      return { start: startOfDay(now), end: now };
    case 'yesterday': {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      return { start: startOfDay(yesterday), end: endOfDay(yesterday) };
    }
    case 'week':
      return { start: mondayOf(now), end: now };
    case 'lastWeek': {
      const monday = mondayOf(now);
      monday.setDate(monday.getDate() - 7);
      const sunday = new Date(monday);
      sunday.setDate(sunday.getDate() + 6);
      return { start: monday, end: endOfDay(sunday) };
    }
    case 'month': {
      const first = startOfDay(now);
      first.setDate(1);
      return { start: first, end: now };
    }
    case 'lastMonth': {
      const first = startOfDay(now);
      first.setDate(1);
      first.setMonth(first.getMonth() - 1);
      const last = new Date(first);
      last.setMonth(last.getMonth() + 1);
      last.setDate(0);
      return { start: first, end: endOfDay(last) };
    }
  }
}

export function parseLocalYMD(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`Invalid date "${value}" (expected YYYY-MM-DD)`);
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

export interface RangeInput {
  period?: Period;
  start_date?: string;
  end_date?: string;
}

export function rangeFromInput(input: RangeInput, now: Date = new Date()): DateRange {
  if (input.start_date !== undefined || input.end_date !== undefined) {
    const start = input.start_date ? parseLocalYMD(input.start_date) : startOfDay(now);
    const end = input.end_date ? endOfDay(parseLocalYMD(input.end_date)) : now;
    return { start, end };
  }
  return periodRange(input.period ?? 'today', now);
}

/** Duration in seconds. Toggl uses negative durations for the running entry. */
export function entrySeconds(entry: TimeEntry, nowMs: number = Date.now()): number {
  if (entry.duration >= 0) return entry.duration;
  const startedMs = new Date(entry.start).getTime();
  if (Number.isNaN(startedMs)) return 0;
  return Math.max(0, Math.round((nowMs - startedMs) / 1000));
}

export function roundHours(seconds: number): number {
  return Math.round((seconds / 3600) * 100) / 100;
}

/** Keep only entries belonging to the given workspace (no-op when none is selected). */
export function filterEntriesByWorkspace(entries: TimeEntry[], workspaceId?: number): TimeEntry[] {
  if (!workspaceId) return entries;
  return entries.filter((entry) => entry.workspace_id === workspaceId);
}

/**
 * Seconds of an entry that fall inside [rangeStartMs, rangeEndMs].
 * Running entries are capped at the range end and at now.
 */
export function entryOverlapSeconds(
  entry: TimeEntry,
  rangeStartMs: number,
  rangeEndMs: number,
  nowMs: number = Date.now()
): number {
  const startMs = Date.parse(entry.start);
  if (Number.isNaN(startMs)) return 0;

  const fallbackEndMs = Math.min(nowMs, rangeEndMs);
  const parsedEndMs = entry.stop ? Date.parse(entry.stop) : fallbackEndMs;
  const endMs = Number.isNaN(parsedEndMs) ? fallbackEndMs : parsedEndMs;

  const overlapStart = Math.max(startMs, rangeStartMs);
  const overlapEnd = Math.min(endMs, rangeEndMs);
  return Math.max(0, Math.round((overlapEnd - overlapStart) / 1000));
}

export interface SummaryOptions {
  /** With rangeEndMs, count only the part of each entry inside the interval. */
  rangeStartMs?: number;
  rangeEndMs?: number;
  nowMs?: number;
}

export interface ProjectSummaryRow {
  project_id: number | null;
  project_name: string;
  seconds: number;
  hours: number;
  entries: number;
}

export function summarizeByProject(
  entries: TimeEntry[],
  projectNames: Map<number, string> = new Map(),
  options: SummaryOptions = {}
): ProjectSummaryRow[] {
  const { rangeStartMs, rangeEndMs } = options;
  const nowMs = options.nowMs ?? Date.now();
  const rows = new Map<string, ProjectSummaryRow>();

  for (const entry of entries) {
    const seconds =
      rangeStartMs !== undefined && rangeEndMs !== undefined
        ? entryOverlapSeconds(entry, rangeStartMs, rangeEndMs, nowMs)
        : entrySeconds(entry, nowMs);
    if (seconds <= 0) continue;

    const key = entry.project_id === null ? 'none' : String(entry.project_id);
    const row =
      rows.get(key) ??
      {
        project_id: entry.project_id,
        project_name:
          entry.project_id === null
            ? 'No project'
            : (projectNames.get(entry.project_id) ?? `Project ${entry.project_id}`),
        seconds: 0,
        hours: 0,
        entries: 0,
      };

    row.seconds += seconds;
    row.entries += 1;
    rows.set(key, row);
  }

  return [...rows.values()]
    .map((row) => ({ ...row, hours: roundHours(row.seconds) }))
    .sort((a, b) => b.seconds - a.seconds);
}
