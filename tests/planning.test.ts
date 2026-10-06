import { describe, expect, test } from 'bun:test';
import { fromEthiopian, toEthiopian } from '../src/utils/ethiopianCalendar';
import { formatMonth } from '../src/utils/format';
import { addDays, nextPeriodStart, periodEndInclusive, periodStart, previousPeriodStart, sameDay } from '../src/utils/periodUtils';
import {
  addCalendarMonths,
  addCalendarYears,
  benchmarkHourlyRate,
  incomeForYear,
  incomeOccurrences,
  monthlyEquivalent,
  planShortfall,
  scoreOpportunity,
  summarizeAssets,
  type PlanItemInput,
} from '../src/utils/planning';

const eth = (year: number, month: number, day: number) => fromEthiopian({ year, month, day });

describe('ethiopian months everywhere', () => {
  test('month labels use Ethiopian month names', () => {
    expect(formatMonth(eth(2018, 1, 1), 'ethiopian')).toBe('Meskerem 2018');
    expect(formatMonth(eth(2018, 2, 15), 'ethiopian')).toBe('Tikimt 2018');
  });

  test('monthly periods are 30 days, then Pagume, then a new year', () => {
    const nehase = eth(2018, 12, 10);
    expect(periodStart(nehase, 'monthly', 'ethiopian').getTime()).toBe(eth(2018, 12, 1).getTime());
    expect(toEthiopian(periodEndInclusive(nehase, 'monthly', 'ethiopian'))).toEqual({ year: 2018, month: 12, day: 30 });
    const pagume = nextPeriodStart(nehase, 'monthly', 'ethiopian');
    expect(toEthiopian(pagume)).toEqual({ year: 2018, month: 13, day: 1 });
    // 2018 is not a leap year: Pagume has 5 days.
    expect(toEthiopian(periodEndInclusive(pagume, 'monthly', 'ethiopian'))).toEqual({ year: 2018, month: 13, day: 5 });
    expect(toEthiopian(nextPeriodStart(pagume, 'monthly', 'ethiopian'))).toEqual({ year: 2019, month: 1, day: 1 });
    expect(toEthiopian(previousPeriodStart(eth(2019, 1, 1), 'monthly', 'ethiopian'))).toEqual({ year: 2018, month: 13, day: 1 });
    // 2019 is a leap year: Pagume has 6 days.
    expect(toEthiopian(periodEndInclusive(eth(2019, 13, 1), 'monthly', 'ethiopian'))).toEqual({ year: 2019, month: 13, day: 6 });
  });

  test('the monthly summary goes out on the last day of the Ethiopian month', () => {
    const isLastDay = (d: Date) => sameDay(addDays(d, 1), nextPeriodStart(d, 'monthly', 'ethiopian'));
    expect(isLastDay(eth(2018, 2, 30))).toBe(true);
    expect(isLastDay(eth(2018, 2, 29))).toBe(false);
    expect(isLastDay(eth(2018, 13, 5))).toBe(true);
    expect(isLastDay(eth(2019, 13, 5))).toBe(false);
    expect(isLastDay(eth(2019, 13, 6))).toBe(true);
  });

  test('the year runs Meskerem 1 to the end of Pagume', () => {
    const now = eth(2018, 6, 12);
    expect(toEthiopian(periodStart(now, 'yearly', 'ethiopian'))).toEqual({ year: 2018, month: 1, day: 1 });
    expect(toEthiopian(nextPeriodStart(now, 'yearly', 'ethiopian'))).toEqual({ year: 2019, month: 1, day: 1 });
  });
});

describe('calendar arithmetic', () => {
  test('Gregorian months clamp to the end of shorter months', () => {
    expect(addCalendarMonths(new Date(2025, 0, 31), 1, 'gregorian').getTime()).toBe(new Date(2025, 1, 28).getTime());
    expect(addCalendarMonths(new Date(2025, 0, 31), 2, 'gregorian').getTime()).toBe(new Date(2025, 2, 31).getTime());
    expect(addCalendarYears(new Date(2024, 1, 29), 1, 'gregorian').getTime()).toBe(new Date(2025, 1, 28).getTime());
  });

  test('Ethiopian months keep the day and skip Pagume', () => {
    expect(toEthiopian(addCalendarMonths(eth(2018, 12, 30), 1, 'ethiopian'))).toEqual({ year: 2019, month: 1, day: 30 });
    expect(toEthiopian(addCalendarMonths(eth(2018, 1, 15), 13, 'ethiopian'))).toEqual({ year: 2019, month: 2, day: 15 });
    // A start inside Pagume counts as Nehase 30.
    expect(toEthiopian(addCalendarMonths(eth(2018, 13, 3), 1, 'ethiopian'))).toEqual({ year: 2019, month: 1, day: 30 });
  });

  test('Ethiopian years clamp Pagume 6 in non-leap years', () => {
    expect(toEthiopian(addCalendarYears(eth(2019, 13, 6), 1, 'ethiopian'))).toEqual({ year: 2020, month: 13, day: 5 });
    expect(toEthiopian(addCalendarYears(eth(2018, 3, 10), 2, 'ethiopian'))).toEqual({ year: 2020, month: 3, day: 10 });
  });
});

describe('expected income', () => {
  test('a monthly salary is paid 12 times in an Ethiopian year, never in Pagume', () => {
    const salary = { amount: 20_000, frequency: 'monthly' as const, start: eth(2017, 5, 25), end: null };
    const year = incomeForYear(salary, eth(2018, 6, 12), 'ethiopian');
    expect(year.count).toBe(12);
    expect(year.total).toBe(240_000);
    // Meskerem 25 … Tir 25 have been paid (5 months), Yekatit 25 onward is still to come.
    expect(year.received).toBe(5 * 20_000);
    expect(year.toCome).toBe(7 * 20_000);
    expect(toEthiopian(year.next!)).toEqual({ year: 2018, month: 6, day: 25 });
    const dates = incomeOccurrences(salary, year.yearStart, addDays(year.yearEnd, -1), 'ethiopian');
    expect(dates.every((d) => toEthiopian(d).month !== 13)).toBe(true);
  });

  test('a salary that starts mid-year only counts from its start', () => {
    const salary = { amount: 10_000, frequency: 'monthly' as const, start: eth(2018, 10, 1), end: null };
    expect(incomeForYear(salary, eth(2018, 2, 1), 'ethiopian').count).toBe(3);
  });

  test('an end date stops the payments', () => {
    const contract = { amount: 5_000, frequency: 'monthly' as const, start: new Date(2025, 0, 15), end: new Date(2025, 5, 15) };
    expect(incomeForYear(contract, new Date(2025, 2, 1), 'gregorian').count).toBe(6);
  });

  test('weekly, yearly and one-time income', () => {
    const weekly = { amount: 1_000, frequency: 'weekly' as const, start: new Date(2025, 0, 1), end: null };
    expect(incomeForYear(weekly, new Date(2025, 6, 1), 'gregorian').count).toBe(53);

    const bonus = { amount: 50_000, frequency: 'yearly' as const, start: new Date(2023, 11, 20), end: null };
    expect(incomeForYear(bonus, new Date(2025, 0, 5), 'gregorian').total).toBe(50_000);

    const once = { amount: 8_000, frequency: 'once' as const, start: new Date(2026, 1, 1), end: null };
    expect(incomeForYear(once, new Date(2025, 5, 1), 'gregorian').total).toBe(0);
    expect(incomeForYear(once, new Date(2026, 5, 1), 'gregorian').received).toBe(8_000);
  });

  test('monthly equivalents', () => {
    expect(monthlyEquivalent({ amount: 1_200, frequency: 'yearly' })).toBe(100);
    expect(monthlyEquivalent({ amount: 300, frequency: 'quarterly' })).toBe(100);
    expect(monthlyEquivalent({ amount: 500, frequency: 'once' })).toBe(0);
  });
});

describe('planned spending', () => {
  const item = (id: number, priority: PlanItemInput['priority'], price: number, saved = 0, neededBy: Date | null = null): PlanItemInput => ({
    id,
    priority,
    price,
    saved,
    neededBy,
  });

  test('money goes to musts first, then needs, then wants', () => {
    const result = planShortfall([item(1, 'want', 3_000), item(2, 'must', 5_000, 1_000), item(3, 'need', 4_000)], 6_000);
    expect(result.tiers.must).toMatchObject({ count: 1, total: 5_000, saved: 1_000, remaining: 4_000, covered: 4_000, short: 0 });
    expect(result.tiers.need).toMatchObject({ remaining: 4_000, covered: 2_000, short: 2_000 });
    expect(result.tiers.want).toMatchObject({ remaining: 3_000, covered: 0, short: 3_000 });
    expect(result.short).toBe(5_000);
    expect(result.leftover).toBe(0);
  });

  test('within a tier the earliest deadline is covered first', () => {
    const result = planShortfall([item(1, 'must', 1_000, 0, new Date(2025, 5, 1)), item(2, 'must', 1_000, 0, new Date(2025, 2, 1)), item(3, 'must', 1_000)], 1_500);
    expect(result.coveredById.get(2)).toBe(1_000);
    expect(result.coveredById.get(1)).toBe(500);
    expect(result.coveredById.get(3)).toBe(0);
  });

  test('extra money is left over when everything is covered', () => {
    const result = planShortfall([item(1, 'need', 2_000)], 5_000);
    expect(result.short).toBe(0);
    expect(result.leftover).toBe(3_000);
    expect(planShortfall([item(1, 'need', 2_000)], -400).short).toBe(2_000);
  });
});

describe('assets and ways to earn', () => {
  test('quick-sale value discounts slow-to-sell assets', () => {
    const summary = summarizeAssets([
      { value: 10_000, liquidity: 'cash' },
      { value: 20_000, liquidity: 'days' },
      { value: 100_000, liquidity: 'months' },
    ]);
    expect(summary.worth).toBe(130_000);
    expect(summary.withinWeek).toBe(10_000 + 19_000);
    expect(summary.quickSale).toBe(10_000 + 19_000 + 70_000);
  });

  test('score is expected money per effort-hour', () => {
    const score = scoreOpportunity({ reward: 10_000, hours: 10, strain: 3, chance: 50 }, 100);
    expect(score.expected).toBe(5_000);
    expect(score.effortHours).toBe(15);
    expect(score.perEffortHour).toBeCloseTo(333.33, 1);
    expect(score.verdict).toBe('great');
    expect(score.quickWin).toBe(false);

    const quick = scoreOpportunity({ reward: 1_000, hours: 4, strain: 1, chance: 90 }, 400);
    expect(quick.perEffortHour).toBe(225);
    expect(quick.verdict).toBe('fair');
    expect(quick.quickWin).toBe(true);

    expect(scoreOpportunity({ reward: 1_000, hours: 20, strain: 5, chance: 50 }, 100).verdict).toBe('poor');
    expect(scoreOpportunity({ reward: 1_000, hours: 1, strain: 1, chance: 50 }, null).verdict).toBeNull();
  });

  test('the benchmark is yearly income over 2080 hours, or the median idea', () => {
    expect(benchmarkHourlyRate(208_000, [])).toBe(100);
    const ideas = [
      { reward: 100, hours: 1, strain: 1 as const, chance: 100 },
      { reward: 300, hours: 1, strain: 1 as const, chance: 100 },
      { reward: 900, hours: 1, strain: 1 as const, chance: 100 },
    ];
    expect(benchmarkHourlyRate(0, ideas)).toBe(300);
    expect(benchmarkHourlyRate(0, [])).toBeNull();
  });
});
