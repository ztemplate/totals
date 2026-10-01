import { describe, expect, test } from 'bun:test';
import { daysInEthiopianMonth, formatEthiopian, fromEthiopian, toEthiopian } from '../src/utils/ethiopianCalendar';
import { nextPeriodStart, periodStart } from '../src/utils/periodUtils';

describe('ethiopian calendar', () => {
  test('Enkutatash 2017 is September 11, 2024', () => {
    expect(toEthiopian(new Date(2024, 8, 11))).toEqual({ year: 2017, month: 1, day: 1 });
    expect(fromEthiopian({ year: 2017, month: 1, day: 1 }).getTime()).toBe(new Date(2024, 8, 11).getTime());
  });

  test('Genna (Tahsas 29, 2017) is January 7, 2025', () => {
    expect(toEthiopian(new Date(2025, 0, 7))).toEqual({ year: 2017, month: 4, day: 29 });
    expect(formatEthiopian(new Date(2025, 0, 7))).toBe('Tahsas 29, 2017');
  });

  test('Pagume has 6 days in leap years', () => {
    expect(daysInEthiopianMonth(2015, 13)).toBe(6);
    expect(daysInEthiopianMonth(2016, 13)).toBe(5);
    expect(daysInEthiopianMonth(2016, 4)).toBe(30);
    // 2015 was a leap year, so its new year fell on Sep 12, 2023.
    expect(toEthiopian(new Date(2023, 8, 11))).toEqual({ year: 2015, month: 13, day: 6 });
    expect(toEthiopian(new Date(2023, 8, 12))).toEqual({ year: 2016, month: 1, day: 1 });
  });

  test('round trips every day of a year', () => {
    for (let i = 0; i < 366; i++) {
      const date = new Date(2024, 0, 1 + i);
      expect(fromEthiopian(toEthiopian(date)).getTime()).toBe(date.getTime());
    }
  });
});

describe('period utils', () => {
  test('gregorian monthly period', () => {
    expect(periodStart(new Date(2024, 9, 15, 13), 'monthly').getTime()).toBe(new Date(2024, 9, 1).getTime());
    expect(nextPeriodStart(new Date(2024, 9, 15), 'monthly').getTime()).toBe(new Date(2024, 10, 1).getTime());
  });

  test('ethiopian monthly period', () => {
    // Tikimt 1, 2017 = Oct 11, 2024; Hidar 1 = Nov 10, 2024.
    expect(periodStart(new Date(2024, 9, 15), 'monthly', 'ethiopian').getTime()).toBe(new Date(2024, 9, 11).getTime());
    expect(nextPeriodStart(new Date(2024, 9, 15), 'monthly', 'ethiopian').getTime()).toBe(new Date(2024, 10, 10).getTime());
  });

  test('weeks start on Monday', () => {
    // Oct 1, 2026 is a Thursday.
    expect(periodStart(new Date(2026, 9, 1), 'weekly').getTime()).toBe(new Date(2026, 8, 28).getTime());
  });
});
