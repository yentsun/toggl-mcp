import { describe, expect, it } from 'vitest';
import {
  entrySeconds,
  parseLocalYMD,
  periodRange,
  rangeFromInput,
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

describe('summarizeByProject', () => {
  it('aggregates by project, labels unassigned entries, and sorts by seconds', () => {
    const rows = summarizeByProject(
      [
        entry({ id: 1, project_id: 5, duration: 1800 }),
        entry({ id: 2, project_id: 5, duration: 1800 }),
        entry({ id: 3, project_id: null, duration: 600 }),
      ],
      new Map([[5, 'mono']]),
      0
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ project_id: 5, project_name: 'mono', seconds: 3600, hours: 1 });
    expect(rows[1]).toMatchObject({ project_id: null, project_name: 'No project', seconds: 600 });
  });
});
