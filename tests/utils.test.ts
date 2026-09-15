import { describe, expect, it } from 'vitest';
import {
  entryEndMs,
  entryOverlapSeconds,
  entrySeconds,
  filterEntriesByWorkspace,
  mergeEntriesById,
  parseLocalYMD,
  periodRange,
  rangeFromInput,
  reachesPast,
  roundHours,
  summarizeByProject,
} from '../src/utils.js';
import type { TimeEntry } from '../src/types.js';

function entry(overrides: Partial<TimeEntry>): TimeEntry {
  return {
    id: 1,
    workspace_id: 10,
    project_id: null,
    task_id: null,
    billable: false,
    start: '2026-09-15T09:00:00.000Z',
    stop: null,
    duration: 0,
    description: '',
    tags: null,
    at: '2026-09-15T09:00:00.000Z',
    ...overrides,
  };
}

describe('parseLocalYMD', () => {
  it('parses a YYYY-MM-DD date in local time', () => {
    const date = parseLocalYMD('2026-09-15');
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(8);
    expect(date.getDate()).toBe(15);
    expect(date.getHours()).toBe(0);
  });

  it('rejects malformed input', () => {
    expect(() => parseLocalYMD('15/09/2026')).toThrow();
  });

  it('rejects calendar dates that would otherwise roll over', () => {
    expect(() => parseLocalYMD('2026-02-30')).toThrow(/Invalid calendar date/);
    expect(() => parseLocalYMD('2026-04-31')).toThrow(/Invalid calendar date/);
    expect(() => parseLocalYMD('2026-13-01')).toThrow(/Invalid calendar date/);
    expect(() => parseLocalYMD('2026-00-10')).toThrow(/Invalid calendar date/);
  });

  it('accepts month ends and leap days', () => {
    expect(parseLocalYMD('2026-02-28').getDate()).toBe(28);
    expect(parseLocalYMD('2024-02-29').getDate()).toBe(29);
  });
});

describe('periodRange', () => {
  const now = new Date(2026, 8, 15, 14, 30, 0); // Tue 15 Sep 2026, local

  it('today starts at local midnight and ends now', () => {
    const { start, end } = periodRange('today', now);
    expect(start.getHours()).toBe(0);
    expect(start.getDate()).toBe(15);
    expect(end).toBe(now);
  });

  it('yesterday is the full previous day', () => {
    const { start, end } = periodRange('yesterday', now);
    expect(start.getDate()).toBe(14);
    expect(start.getHours()).toBe(0);
    expect(end.getDate()).toBe(14);
    expect(end.getHours()).toBe(23);
  });

  it('week starts on Monday', () => {
    const { start, end } = periodRange('week', now);
    expect(start.getDay()).toBe(1);
    expect(start.getDate()).toBe(14);
    expect(end).toBe(now);
  });

  it('lastWeek is Monday through Sunday', () => {
    const { start, end } = periodRange('lastWeek', now);
    expect(start.getDay()).toBe(1);
    expect(start.getDate()).toBe(7);
    expect(end.getDay()).toBe(0);
    expect(end.getDate()).toBe(13);
  });

  it('month starts on the 1st', () => {
    const { start } = periodRange('month', now);
    expect(start.getDate()).toBe(1);
    expect(start.getMonth()).toBe(8);
  });

  it('lastMonth covers the whole previous month', () => {
    const { start, end } = periodRange('lastMonth', now);
    expect(start.getMonth()).toBe(7);
    expect(start.getDate()).toBe(1);
    expect(end.getMonth()).toBe(7);
    expect(end.getDate()).toBe(31);
  });
});

describe('rangeFromInput', () => {
  it('uses explicit dates and includes the whole end day', () => {
    const { start, end } = rangeFromInput({ start_date: '2026-09-01', end_date: '2026-09-15' });
    expect(start.getDate()).toBe(1);
    expect(start.getHours()).toBe(0);
    expect(end.getDate()).toBe(15);
    expect(end.getHours()).toBe(23);
  });

  it('falls back to the period', () => {
    const now = new Date(2026, 8, 15, 12, 0, 0);
    const { start } = rangeFromInput({ period: 'today' }, now);
    expect(start.getHours()).toBe(0);
    expect(start.getDate()).toBe(15);
  });
});

describe('entrySeconds', () => {
  it('returns the stored duration for completed entries', () => {
    expect(entrySeconds(entry({ duration: 3600 }))).toBe(3600);
  });

  it('computes elapsed time for a running entry', () => {
    const nowMs = new Date('2026-09-15T09:00:10.000Z').getTime();
    const seconds = entrySeconds(
      entry({ duration: -1, start: '2026-09-15T09:00:00.000Z' }),
      nowMs
    );
    expect(seconds).toBe(10);
  });
});

describe('roundHours', () => {
  it('rounds to two decimals', () => {
    expect(roundHours(5400)).toBe(1.5);
    expect(roundHours(1000)).toBe(0.28);
  });
});

describe('entryEndMs / reachesPast', () => {
  it('uses the stop time, or now for a running entry', () => {
    expect(entryEndMs(entry({ stop: '2026-09-15T01:00:00.000Z' }))).toBe(
      Date.parse('2026-09-15T01:00:00.000Z')
    );
    expect(entryEndMs(entry({ stop: null }), 1234)).toBe(1234);
  });

  it('detects whether any entry reaches past the range start', () => {
    const rangeStartMs = Date.parse('2026-09-14T00:00:00.000Z');
    const older = entry({ start: '2026-08-01T00:00:00.000Z', stop: '2026-08-02T00:00:00.000Z' });
    const longEntry = entry({
      start: '2026-09-01T00:00:00.000Z',
      stop: '2026-09-15T00:00:00.000Z',
    });

    expect(reachesPast([older], rangeStartMs)).toBe(false);
    expect(reachesPast([older, longEntry], rangeStartMs)).toBe(true);
    expect(reachesPast([], rangeStartMs)).toBe(false);
  });
});

describe('long entries in reports', () => {
  it('contributes the same hours whether still running or stopped', () => {
    const rangeStartMs = Date.parse('2026-09-14T00:00:00.000Z');
    const rangeEndMs = Date.parse('2026-09-14T23:59:59.999Z');
    const nowMs = Date.parse('2026-09-15T10:00:00.000Z');

    const running = entry({
      id: 1,
      start: '2026-09-01T00:00:00.000Z',
      stop: null,
      duration: -1,
    });
    const stopped = entry({
      id: 1,
      start: '2026-09-01T00:00:00.000Z',
      stop: '2026-09-15T00:00:00.000Z',
      duration: 1209600,
    });

    expect(entryOverlapSeconds(running, rangeStartMs, rangeEndMs, nowMs)).toBe(86400);
    expect(entryOverlapSeconds(stopped, rangeStartMs, rangeEndMs, nowMs)).toBe(86400);

    const fromRunning = summarizeByProject([running], new Map(), {
      rangeStartMs,
      rangeEndMs,
      nowMs,
    });
    const fromStopped = summarizeByProject([stopped], new Map(), {
      rangeStartMs,
      rangeEndMs,
      nowMs,
    });

    expect(fromRunning[0]!.seconds).toBe(fromStopped[0]!.seconds);
    expect(fromRunning[0]!.hours).toBe(24);
  });
});

describe('mergeEntriesById', () => {
  it('adds the running entry and de-duplicates by id', () => {
    const windowed = [entry({ id: 1, duration: 60 }), entry({ id: 2, duration: 120 })];
    const running = entry({ id: 3, duration: -1, stop: null });

    expect(mergeEntriesById(windowed, running).map((e) => e.id)).toEqual([1, 2, 3]);

    const duplicate = entry({ id: 1, duration: 999 });
    expect(mergeEntriesById(windowed, duplicate).find((e) => e.id === 1)?.duration).toBe(999);
  });

  it('tolerates the absence of a running entry', () => {
    expect(mergeEntriesById([entry({ id: 1 })], null)).toHaveLength(1);
  });
});

describe('filterEntriesByWorkspace', () => {
  it('keeps only entries from the selected workspace', () => {
    const entries = [entry({ id: 1, workspace_id: 10 }), entry({ id: 2, workspace_id: 20 })];
    expect(filterEntriesByWorkspace(entries, 10).map((e) => e.id)).toEqual([1]);
  });

  it('is a no-op when no workspace is selected', () => {
    const entries = [entry({ id: 1, workspace_id: 10 }), entry({ id: 2, workspace_id: 20 })];
    expect(filterEntriesByWorkspace(entries, undefined)).toHaveLength(2);
  });
});

describe('entryOverlapSeconds', () => {
  const dayStart = Date.parse('2026-09-15T00:00:00.000Z');
  const dayEnd = Date.parse('2026-09-15T23:59:59.999Z');

  it('counts only the part of an entry inside the range', () => {
    const crossing = entry({
      start: '2026-09-14T23:00:00.000Z',
      stop: '2026-09-15T01:00:00.000Z',
      duration: 7200,
    });
    expect(entryOverlapSeconds(crossing, dayStart, dayEnd)).toBe(3600);
  });

  it('returns zero for an entry entirely outside the range', () => {
    const outside = entry({
      start: '2026-09-14T20:00:00.000Z',
      stop: '2026-09-14T21:00:00.000Z',
      duration: 3600,
    });
    expect(entryOverlapSeconds(outside, dayStart, dayEnd)).toBe(0);
  });

  it('caps a running entry at the range end and at now', () => {
    const running = entry({ start: '2026-09-14T23:00:00.000Z', stop: null, duration: -1 });
    const now = Date.parse('2026-09-15T10:00:00.000Z');
    const rangeEnd = Date.parse('2026-09-15T12:00:00.000Z');

    expect(entryOverlapSeconds(running, dayStart, rangeEnd, now)).toBe(36000);
  });
});

describe('summarizeByProject', () => {
  it('aggregates by project, labels unassigned entries, and sorts by seconds', () => {
    const rows = summarizeByProject(
      [
        entry({ id: 1, project_id: 5, duration: 1800 }),
        entry({ id: 2, project_id: 5, duration: 1800 }),
        entry({ id: 3, project_id: null, duration: 600 }),
      ],
      new Map([[5, 'mono']]),
      { nowMs: 0 }
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ project_id: 5, project_name: 'mono', seconds: 3600, hours: 1 });
    expect(rows[1]).toMatchObject({ project_id: null, project_name: 'No project', seconds: 600 });
  });

  it('clips entries to the range and drops non-overlapping ones', () => {
    const rangeStartMs = Date.parse('2026-09-15T00:00:00.000Z');
    const rangeEndMs = Date.parse('2026-09-15T23:59:59.999Z');

    const rows = summarizeByProject(
      [
        entry({
          id: 1,
          project_id: 5,
          start: '2026-09-14T23:00:00.000Z',
          stop: '2026-09-15T01:00:00.000Z',
          duration: 7200,
        }),
        entry({
          id: 2,
          project_id: 5,
          start: '2026-09-14T20:00:00.000Z',
          stop: '2026-09-14T21:00:00.000Z',
          duration: 3600,
        }),
      ],
      new Map([[5, 'mono']]),
      { rangeStartMs, rangeEndMs, nowMs: rangeEndMs }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seconds: 3600, hours: 1, entries: 1 });
  });
});
