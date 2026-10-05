import { describe, expect, test } from 'bun:test';
import {
  formatRange,
  isInRange,
  makeRange,
  matchingPreset,
  monthGrid,
  nextRangeSelection,
  presetRange,
} from '../src/utils/dateRange';

const d = (y: number, m: number, day: number, h = 0) => new Date(y, m - 1, day, h);

describe('date ranges', () => {
  test('ranges cover whole days whichever end comes first', () => {
    const range = makeRange(d(2026, 3, 10, 15), d(2026, 3, 1, 9));
    expect(range.start).toEqual(d(2026, 3, 1));
    expect(range.end).toEqual(new Date(2026, 2, 10, 23, 59, 59, 999));
    expect(isInRange(d(2026, 3, 10, 22), range)).toBe(true);
    expect(isInRange(d(2026, 3, 11), range)).toBe(false);
    expect(isInRange(null, range)).toBe(false);
  });

  test('presets end today and are recognised again', () => {
    const now = d(2026, 10, 5, 14);
    const last7 = presetRange('last7', now);
    expect(last7.start).toEqual(d(2026, 9, 29));
    expect(matchingPreset(last7, now)).toBe('last7');
    expect(presetRange('thisYear', now).start).toEqual(d(2026, 1, 1));
    // Ethiopian year starts on Meskerem 1 (Sep 11, 2026).
    expect(presetRange('thisYear', now, 'ethiopian').start).toEqual(d(2026, 9, 11));
    expect(matchingPreset(makeRange(d(2026, 10, 1), now), now)).toBeNull();
  });

  test('two taps pick a range; a third starts over', () => {
    let sel = nextRangeSelection({ start: null, end: null }, d(2026, 3, 5, 12));
    expect(sel).toEqual({ start: d(2026, 3, 5), end: null });
    sel = nextRangeSelection(sel, d(2026, 3, 2));
    expect(sel).toEqual({ start: d(2026, 3, 2), end: null });
    sel = nextRangeSelection(sel, d(2026, 3, 9));
    expect(sel).toEqual({ start: d(2026, 3, 2), end: d(2026, 3, 9) });
    expect(nextRangeSelection(sel, d(2026, 3, 20))).toEqual({ start: d(2026, 3, 20), end: null });
  });

  test('formats single days and spans', () => {
    expect(formatRange(makeRange(d(2026, 3, 1), d(2026, 3, 1)))).toBe('Mar 1, 2026');
    expect(formatRange(makeRange(d(2026, 3, 1), d(2026, 3, 9)))).toBe('Mar 1, 2026 – Mar 9, 2026');
  });

  test('month grid starts on Monday and pads the edges', () => {
    // March 2026 starts on a Sunday.
    const grid = monthGrid(d(2026, 3, 15));
    expect(grid.label).toBe('Mar 2026');
    expect(grid.weeks[0].slice(0, 6)).toEqual([null, null, null, null, null, null]);
    expect(grid.weeks[0][6]).toEqual(d(2026, 3, 1));
    expect(grid.weeks.flat().filter(Boolean)).toHaveLength(31);
    expect(grid.weeks.every((w) => w.length === 7)).toBe(true);

    const pagume = monthGrid(d(2026, 9, 8), 'ethiopian');
    expect(pagume.label).toBe('Pagume 2018');
    expect(pagume.weeks.flat().filter(Boolean)).toHaveLength(5);
  });
});
