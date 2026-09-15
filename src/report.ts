import type { TimeEntry } from './types.js';
import { mergeEntriesById, reachesPast } from './utils.js';

/** Toggl rejects /me/time_entries spans beyond ~90 days, so windows stay under that. */
export const REPORT_WINDOW_MS = 84 * 24 * 60 * 60 * 1000;
export const MAX_REPORT_WINDOWS = 12;

export interface ReportScanDeps {
  getEntries: (range: { start: Date; end: Date }) => Promise<TimeEntry[]>;
  getRunningEntry: () => Promise<TimeEntry | null>;
  windowMs?: number;
  maxWindows?: number;
}

export interface ReportScan {
  entries: TimeEntry[];
  /** True when some entries could not be checked for overlap (retention floor, etc.). */
  incomplete: boolean;
  reason?: string;
}

const FLOOR_PATTERN = /must not be earlier than\s+(\d{4})-(\d{2})-(\d{2})/i;

/** Extract Toggl's retention floor from a boundary error message, if present. */
function retentionFloorMs(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : '';
  const match = FLOOR_PATTERN.exec(message);
  if (!match) return undefined;

  const [, year, month, day] = match;
  const floor = new Date(Number(year), Number(month) - 1, Number(day));
  return Number.isNaN(floor.getTime()) ? undefined : floor.getTime();
}

/**
 * Collect every entry that could overlap [rangeStart, rangeEnd].
 *
 * Toggl filters /me/time_entries by start time, so entries that began earlier are found
 * by walking backwards in windows until a whole window lies before the range and nothing
 * in it reaches past the range start — no maximum entry duration is assumed.
 */
export async function collectReportEntries(
  rangeStart: Date,
  rangeEnd: Date,
  deps: ReportScanDeps
): Promise<ReportScan> {
  const windowMs = deps.windowMs ?? REPORT_WINDOW_MS;
  const maxWindows = deps.maxWindows ?? MAX_REPORT_WINDOWS;
  const rangeStartMs = rangeStart.getTime();

  const inRange = await deps.getEntries({ start: rangeStart, end: rangeEnd });
  const running = await deps.getRunningEntry();

  const entries = mergeEntriesById(inRange, running);
  const seen = new Set(entries.map((entry) => entry.id));
  const add = (batch: TimeEntry[]) => {
    for (const entry of batch) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        entries.push(entry);
      }
    }
  };

  let windowEndMs = rangeStartMs;
  for (let window = 0; window < maxWindows; window++) {
    const windowStartMs = windowEndMs - windowMs;
    let batch: TimeEntry[];

    try {
      batch = await deps.getEntries({
        start: new Date(windowStartMs),
        end: new Date(windowEndMs),
      });
    } catch (error) {
      const floorMs = retentionFloorMs(error);
      // Only Toggl's historical-boundary error is expected here. Anything else (auth,
      // quota, network, a different 400) must surface rather than be read as "done".
      if (floorMs === undefined) throw error;

      // The window straddles the retention floor, so the request failed as a whole.
      // Retry the still-accessible, more recent part before giving up on it.
      const accessibleStartMs = Math.max(floorMs, windowStartMs);
      if (accessibleStartMs < windowEndMs) {
        try {
          add(
            await deps.getEntries({
              start: new Date(accessibleStartMs),
              end: new Date(windowEndMs),
            })
          );
        } catch {
          // nothing more we can retrieve; still reported as incomplete below
        }
      }

      return {
        entries,
        incomplete: true,
        reason:
          'Toggl only serves recent time entries; older entries could not be checked for overlap, so this report may omit overlapping time.',
      };
    }

    add(batch);
    if (!reachesPast(batch, rangeStartMs)) break;
    windowEndMs = windowStartMs;
  }

  return { entries, incomplete: false };
}
