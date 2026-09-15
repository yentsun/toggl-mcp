import { describe, expect, it, vi } from 'vitest';
import { collectReportEntries } from '../src/report.js';
import { parseLocalYMD } from '../src/utils.js';
import type { TimeEntry } from '../src/types.js';

const DAY = 24 * 60 * 60 * 1000;

function entry(overrides: Partial<TimeEntry>): TimeEntry {
  return {
    id: 1,
    workspace_id: 10,
    project_id: null,
    task_id: null,
    billable: false,
    start: '2026-09-10T00:00:00.000Z',
    stop: null,
    duration: 0,
    description: '',
    tags: null,
    at: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

const RANGE_START = new Date('2026-09-10T00:00:00.000Z');
const RANGE_END = new Date('2026-09-11T00:00:00.000Z');

describe('collectReportEntries', () => {
  it('collects in-range entries and stops once a window cannot overlap', async () => {
    const inRange = entry({ id: 1, duration: 3600 });
    const getEntries = vi.fn(async ({ start }: { start: Date }) => {
      if (start.getTime() === RANGE_START.getTime()) return [inRange];
      return [];
    });
    const getRunningEntry = vi.fn().mockResolvedValue(null);

    const scan = await collectReportEntries(RANGE_START, RANGE_END, {
      getEntries,
      getRunningEntry,
      windowMs: 10 * DAY,
      maxWindows: 5,
    });

    expect(scan.incomplete).toBe(false);
    expect(scan.entries.map((e) => e.id)).toEqual([1]);
    expect(getEntries).toHaveBeenCalledTimes(2); // range query + one clean backward window
  });

  it('finds a long completed entry that started before the range', async () => {
    const longEntry = entry({
      id: 7,
      start: '2026-09-01T00:00:00.000Z',
      stop: '2026-09-15T00:00:00.000Z',
      duration: 1209600,
    });
    const getEntries = vi.fn(async ({ start }: { start: Date }) => {
      if (start.getTime() === RANGE_START.getTime()) return [entry({ id: 1, duration: 60 })];
      if (start.getTime() === RANGE_START.getTime() - 10 * DAY) return [longEntry];
      return [];
    });

    const scan = await collectReportEntries(RANGE_START, RANGE_END, {
      getEntries,
      getRunningEntry: vi.fn().mockResolvedValue(null),
      windowMs: 10 * DAY,
      maxWindows: 5,
    });

    expect(scan.incomplete).toBe(false);
    expect(scan.entries.map((e) => e.id).sort()).toEqual([1, 7]);
  });

  it('clamps a window that crosses the retention floor and marks the report incomplete', async () => {
    const recentOverlap = entry({
      id: 9,
      start: '2026-08-25T00:00:00.000Z',
      stop: '2026-09-10T06:00:00.000Z',
      duration: 1300000,
    });
    // Window start is before the floor; the floor sits inside the window.
    const windowStart = new Date(RANGE_START.getTime() - 40 * DAY); // 2026-08-01
    const floor = parseLocalYMD('2026-08-16'); // the module parses the floor as a local date
    const clampedRequest: Date[] = [];

    const getEntries = vi.fn(async ({ start }: { start: Date }) => {
      if (start.getTime() === RANGE_START.getTime()) return [entry({ id: 1 })];
      if (start.getTime() === windowStart.getTime()) {
        throw new Error(
          'Toggl API 400 Bad Request: "start_date must not be earlier than 2026-08-16"'
        );
      }
      clampedRequest.push(start);
      return [recentOverlap];
    });

    const scan = await collectReportEntries(RANGE_START, RANGE_END, {
      getEntries,
      getRunningEntry: vi.fn().mockResolvedValue(null),
      windowMs: 40 * DAY,
      maxWindows: 5,
    });

    // The accessible, more recent part of the failed window is still retrieved.
    expect(clampedRequest[0]!.getTime()).toBe(floor.getTime());
    expect(scan.entries.map((e) => e.id).sort()).toEqual([1, 9]);
    expect(scan.incomplete).toBe(true);
    expect(scan.reason).toMatch(/older entries could not be checked/i);
  });

  it('propagates a non-boundary error instead of reporting success', async () => {
    const getEntries = vi.fn(async ({ start }: { start: Date }) => {
      if (start.getTime() === RANGE_START.getTime()) return [];
      throw new Error('Toggl API 500 Internal Server Error');
    });

    await expect(
      collectReportEntries(RANGE_START, RANGE_END, {
        getEntries,
        getRunningEntry: vi.fn().mockResolvedValue(null),
        windowMs: 10 * DAY,
        maxWindows: 5,
      })
    ).rejects.toThrow(/500/);
  });

  it('propagates an unrelated 400 without the boundary wording', async () => {
    const getEntries = vi.fn(async ({ start }: { start: Date }) => {
      if (start.getTime() === RANGE_START.getTime()) return [];
      throw new Error('Toggl API 400 Bad Request: "invalid end_date"');
    });

    await expect(
      collectReportEntries(RANGE_START, RANGE_END, {
        getEntries,
        getRunningEntry: vi.fn().mockResolvedValue(null),
        windowMs: 10 * DAY,
        maxWindows: 5,
      })
    ).rejects.toThrow(/invalid end_date/);
  });
});
