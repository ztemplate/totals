/** Date ranges for filtering, and the month grid of the range picker. Calendar aware, pure. */
import { toEthiopian } from './ethiopianCalendar';
import { formatDate, formatMonth } from './format';
import { addDays, endOfDay, nextPeriodStart, periodStart, startOfDay, type CalendarKind } from './periodUtils';

/** Inclusive range: start is local midnight, end is the last millisecond of its day. */
export interface DateRange {
  start: Date;
  end: Date;
}

export type RangePreset = 'last7' | 'last30' | 'last90' | 'thisYear';

export const RANGE_PRESETS: { value: RangePreset; label: string }[] = [
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'last90', label: 'Last 90 days' },
  { value: 'thisYear', label: 'This year' },
];

export function makeRange(a: Date, b: Date): DateRange {
  const [first, last] = a.getTime() <= b.getTime() ? [a, b] : [b, a];
  return { start: startOfDay(first), end: endOfDay(last) };
}

export function presetRange(preset: RangePreset, now: Date, calendar: CalendarKind = 'gregorian'): DateRange {
  switch (preset) {
    case 'last7':
      return makeRange(addDays(now, -6), now);
    case 'last30':
      return makeRange(addDays(now, -29), now);
    case 'last90':
      return makeRange(addDays(now, -89), now);
    case 'thisYear':
      return makeRange(periodStart(now, 'yearly', calendar), now);
  }
}

/** The preset a range was made from, if any, so its chip can show as selected. */
export function matchingPreset(range: DateRange | null, now: Date, calendar: CalendarKind = 'gregorian'): RangePreset | null {
  if (!range) return null;
  for (const { value } of RANGE_PRESETS) {
    const preset = presetRange(value, now, calendar);
    if (preset.start.getTime() === range.start.getTime() && preset.end.getTime() === range.end.getTime()) return value;
  }
  return null;
}

export function isInRange(date: Date | null | undefined, range: DateRange): boolean {
  if (!date) return false;
  const t = date.getTime();
  return t >= range.start.getTime() && t <= range.end.getTime();
}

export function formatRange(range: DateRange, calendar: CalendarKind = 'gregorian'): string {
  const start = formatDate(range.start, calendar);
  const end = formatDate(range.end, calendar);
  return start === end ? start : `${start} – ${end}`;
}

/**
 * Picking a range by tapping days: the first tap starts a range, the second ends it (taps before the
 * start move the start instead), and a tap after a finished range starts over.
 */
export function nextRangeSelection(
  current: { start: Date | null; end: Date | null },
  day: Date,
): { start: Date; end: Date | null } {
  const tapped = startOfDay(day);
  if (!current.start || current.end) return { start: tapped, end: null };
  if (tapped.getTime() < startOfDay(current.start).getTime()) return { start: tapped, end: null };
  return { start: startOfDay(current.start), end: tapped };
}

export interface MonthGrid {
  label: string;
  /** First day of the month (local midnight). */
  start: Date;
  /** First day of the next month. */
  next: Date;
  /** Weeks of Monday-first cells; null pads the first and last week. */
  weeks: (Date | null)[][];
}

export function monthGrid(anchor: Date, calendar: CalendarKind = 'gregorian'): MonthGrid {
  const start = periodStart(anchor, 'monthly', calendar);
  const next = nextPeriodStart(anchor, 'monthly', calendar);
  const cells: (Date | null)[] = Array.from({ length: (start.getDay() + 6) % 7 }, () => null);
  for (let d = start; d.getTime() < next.getTime(); d = addDays(d, 1)) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (Date | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return { label: formatMonth(start, calendar), start, next, weeks };
}

export function dayOfMonth(date: Date, calendar: CalendarKind = 'gregorian'): number {
  return calendar === 'ethiopian' ? toEthiopian(date).day : date.getDate();
}

export const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
