import { daysInEthiopianMonth, fromEthiopian, toEthiopian } from './ethiopianCalendar';

export type PeriodFrame = 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
export type CalendarKind = 'gregorian' | 'ethiopian';

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function endOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
}

/** Monday-based week start. */
export function startOfWeek(date: Date): Date {
  const day = (date.getDay() + 6) % 7;
  return startOfDay(addDays(date, -day));
}

export function periodStart(date: Date, frame: PeriodFrame, calendar: CalendarKind = 'gregorian'): Date {
  switch (frame) {
    case 'daily':
    case 'never':
      return startOfDay(date);
    case 'weekly':
      return startOfWeek(date);
    case 'monthly':
      if (calendar === 'ethiopian') {
        const eth = toEthiopian(date);
        return fromEthiopian({ year: eth.year, month: eth.month, day: 1 });
      }
      return new Date(date.getFullYear(), date.getMonth(), 1);
    case 'yearly':
      if (calendar === 'ethiopian') {
        const eth = toEthiopian(date);
        return fromEthiopian({ year: eth.year, month: 1, day: 1 });
      }
      return new Date(date.getFullYear(), 0, 1);
  }
}

export function nextPeriodStart(date: Date, frame: PeriodFrame, calendar: CalendarKind = 'gregorian'): Date {
  const start = periodStart(date, frame, calendar);
  switch (frame) {
    case 'daily':
    case 'never':
      return addDays(start, 1);
    case 'weekly':
      return addDays(start, 7);
    case 'monthly':
      if (calendar === 'ethiopian') {
        const eth = toEthiopian(start);
        return addDays(start, daysInEthiopianMonth(eth.year, eth.month));
      }
      return new Date(start.getFullYear(), start.getMonth() + 1, 1);
    case 'yearly':
      if (calendar === 'ethiopian') {
        const eth = toEthiopian(start);
        return fromEthiopian({ year: eth.year + 1, month: 1, day: 1 });
      }
      return new Date(start.getFullYear() + 1, 0, 1);
  }
}

export function periodEndInclusive(date: Date, frame: PeriodFrame, calendar: CalendarKind = 'gregorian'): Date {
  return new Date(nextPeriodStart(date, frame, calendar).getTime() - 1);
}

export function previousPeriodStart(date: Date, frame: PeriodFrame, calendar: CalendarKind = 'gregorian'): Date {
  const start = periodStart(date, frame, calendar);
  return periodStart(addDays(start, -1), frame, calendar);
}

export function isWithin(date: Date, start: Date, endInclusive: Date): boolean {
  const t = date.getTime();
  return t >= start.getTime() && t <= endInclusive.getTime();
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Week of month as stored in the transactions table: floor((day - 1) / 7) + 1. */
export function weekOfMonth(date: Date): number {
  return Math.floor((date.getDate() - 1) / 7) + 1;
}
