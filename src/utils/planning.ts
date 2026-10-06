import { daysInEthiopianMonth, fromEthiopian, toEthiopian } from './ethiopianCalendar';
import { addDays, nextPeriodStart, periodStart, startOfDay, type CalendarKind } from './periodUtils';

// ---------------------------------------------------------------------------------------------
// Planned spending
// ---------------------------------------------------------------------------------------------

export type PlanPriority = 'must' | 'need' | 'want';
export const PLAN_PRIORITIES: PlanPriority[] = ['must', 'need', 'want'];

export interface PlanItemInput {
  id: number;
  price: number;
  /** Money already put aside for this item. */
  saved: number;
  priority: PlanPriority;
  /** Local midnight, or null when there is no deadline. */
  neededBy: Date | null;
}

export interface TierShortfall {
  count: number;
  /** Sum of prices. */
  total: number;
  saved: number;
  /** Price minus what is already saved. */
  remaining: number;
  /** Part of the remaining cost the available money covers. */
  covered: number;
  short: number;
}

export interface PlanShortfall {
  available: number;
  tiers: Record<PlanPriority, TierShortfall>;
  remaining: number;
  short: number;
  /** Available money left after every item is covered. */
  leftover: number;
  /** How much of each item's remaining cost is covered, by item id. */
  coveredById: Map<number, number>;
}

/** Musts first, then needs, then wants; within a tier the earliest deadline first, undated last. */
export function comparePlanItems(a: PlanItemInput, b: PlanItemInput): number {
  const p = PLAN_PRIORITIES.indexOf(a.priority) - PLAN_PRIORITIES.indexOf(b.priority);
  if (p !== 0) return p;
  const ta = a.neededBy?.getTime() ?? Number.POSITIVE_INFINITY;
  const tb = b.neededBy?.getTime() ?? Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.id - b.id;
}

/**
 * Hands the available money to the planned items in priority order (must → need → want, earliest
 * deadline first) and reports what each tier is still short.
 */
export function planShortfall(items: PlanItemInput[], available: number): PlanShortfall {
  const empty = (): TierShortfall => ({ count: 0, total: 0, saved: 0, remaining: 0, covered: 0, short: 0 });
  const tiers: Record<PlanPriority, TierShortfall> = { must: empty(), need: empty(), want: empty() };
  const coveredById = new Map<number, number>();
  let pool = Math.max(0, available);
  for (const item of [...items].sort(comparePlanItems)) {
    const tier = tiers[item.priority];
    const price = Math.max(0, item.price);
    const saved = Math.min(price, Math.max(0, item.saved));
    const remaining = price - saved;
    const covered = Math.min(pool, remaining);
    pool -= covered;
    tier.count += 1;
    tier.total += price;
    tier.saved += saved;
    tier.remaining += remaining;
    tier.covered += covered;
    tier.short += remaining - covered;
    coveredById.set(item.id, covered);
  }
  const remaining = PLAN_PRIORITIES.reduce((sum, p) => sum + tiers[p].remaining, 0);
  const short = PLAN_PRIORITIES.reduce((sum, p) => sum + tiers[p].short, 0);
  return { available: Math.max(0, available), tiers, remaining, short, leftover: pool, coveredById };
}

/** Whole days from today until the date; negative when it has passed. */
export function daysUntil(date: Date, now = new Date()): number {
  return Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / 86_400_000);
}

// ---------------------------------------------------------------------------------------------
// Expected income
// ---------------------------------------------------------------------------------------------

export type IncomeFrequency = 'once' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';
export type IncomeCertainty = 'certain' | 'likely' | 'uncertain';

export interface IncomeInput {
  amount: number;
  frequency: IncomeFrequency;
  /** First (or only) payment day, local midnight. */
  start: Date;
  /** Last day a payment can fall on, or null when it keeps going. */
  end: Date | null;
}

/**
 * The date `months` months after `date`, keeping the day of the month. Gregorian days past the end
 * of a shorter month land on its last day (Jan 31 → Feb 28). On the Ethiopian calendar months are
 * always 30 days, and monthly payments skip Pagume (salaries are paid 12 times a year); a start
 * inside Pagume counts as Nehase 30.
 */
export function addCalendarMonths(date: Date, months: number, calendar: CalendarKind): Date {
  if (calendar === 'ethiopian') {
    const eth = toEthiopian(date);
    const day = eth.month === 13 ? 30 : eth.day;
    const index = eth.year * 12 + (Math.min(eth.month, 12) - 1) + months;
    return fromEthiopian({ year: Math.floor(index / 12), month: (index % 12) + 1, day });
  }
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), last));
}

/** The same calendar date `years` later; Pagume 6 becomes Pagume 5 and Feb 29 becomes Feb 28 in short years. */
export function addCalendarYears(date: Date, years: number, calendar: CalendarKind): Date {
  if (calendar === 'ethiopian') {
    const eth = toEthiopian(date);
    const year = eth.year + years;
    return fromEthiopian({ year, month: eth.month, day: Math.min(eth.day, daysInEthiopianMonth(year, eth.month)) });
  }
  return addCalendarMonths(date, years * 12, 'gregorian');
}

/** The n-th payment date (n = 0 is the first). */
export function incomeOccurrence(income: IncomeInput, n: number, calendar: CalendarKind): Date {
  const start = startOfDay(income.start);
  switch (income.frequency) {
    case 'once':
      return start;
    case 'weekly':
      return addDays(start, 7 * n);
    case 'biweekly':
      return addDays(start, 14 * n);
    case 'monthly':
      return addCalendarMonths(start, n, calendar);
    case 'quarterly':
      return addCalendarMonths(start, 3 * n, calendar);
    case 'yearly':
      return addCalendarYears(start, n, calendar);
  }
}

/** Payment dates from `from` to `to` (both inclusive, by day). */
export function incomeOccurrences(income: IncomeInput, from: Date, to: Date, calendar: CalendarKind): Date[] {
  const first = startOfDay(from).getTime();
  const last = startOfDay(to).getTime();
  const end = income.end ? startOfDay(income.end).getTime() : Number.POSITIVE_INFINITY;
  const dates: Date[] = [];
  const limit = income.frequency === 'once' ? 1 : 2000;
  for (let n = 0; n < limit; n++) {
    const date = incomeOccurrence(income, n, calendar);
    const t = date.getTime();
    if (t > last || t > end) break;
    if (t >= first) dates.push(date);
  }
  return dates;
}

export interface IncomeYear {
  /** First day of the year on the chosen calendar. */
  yearStart: Date;
  /** First day of the next year. */
  yearEnd: Date;
  /** Every payment this year. */
  total: number;
  /** Payments due up to today. */
  received: number;
  /** Payments after today. */
  toCome: number;
  count: number;
  next: Date | null;
}

/** What one income source pays in the calendar year containing `now`. */
export function incomeForYear(income: IncomeInput, now: Date, calendar: CalendarKind): IncomeYear {
  const yearStart = periodStart(now, 'yearly', calendar);
  const yearEnd = nextPeriodStart(now, 'yearly', calendar);
  const today = startOfDay(now).getTime();
  const dates = incomeOccurrences(income, yearStart, addDays(yearEnd, -1), calendar);
  let received = 0;
  let toCome = 0;
  for (const d of dates) {
    if (d.getTime() <= today) received += income.amount;
    else toCome += income.amount;
  }
  const upcoming = incomeOccurrences(income, addDays(startOfDay(now), 1), addDays(startOfDay(now), 3660), calendar);
  return {
    yearStart,
    yearEnd,
    total: received + toCome,
    received,
    toCome,
    count: dates.length,
    next: upcoming[0] ?? null,
  };
}

/** Rough monthly figure, for comparing sources with different schedules. */
export function monthlyEquivalent(income: Pick<IncomeInput, 'amount' | 'frequency'>): number {
  switch (income.frequency) {
    case 'once':
      return 0;
    case 'weekly':
      return (income.amount * 52) / 12;
    case 'biweekly':
      return (income.amount * 26) / 12;
    case 'monthly':
      return income.amount;
    case 'quarterly':
      return income.amount / 3;
    case 'yearly':
      return income.amount / 12;
  }
}

// ---------------------------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------------------------

export type Liquidity = 'cash' | 'days' | 'weeks' | 'months' | 'hard';
export const LIQUIDITY_LEVELS: Liquidity[] = ['cash', 'days', 'weeks', 'months', 'hard'];

/**
 * Share of the estimated worth you can expect when you need the money soon. Selling fast usually
 * means a lower price, and the harder something is to sell the bigger the discount.
 */
export const LIQUIDITY_FACTOR: Record<Liquidity, number> = {
  cash: 1,
  days: 0.95,
  weeks: 0.85,
  months: 0.7,
  hard: 0.5,
};

export function quickSaleValue(value: number, liquidity: Liquidity): number {
  return Math.max(0, value) * LIQUIDITY_FACTOR[liquidity];
}

export interface AssetSummary {
  worth: number;
  quickSale: number;
  /** Money you could have within about a week (cash-like and sellable within days). */
  withinWeek: number;
  byLiquidity: Record<Liquidity, number>;
}

export function summarizeAssets(assets: { value: number; liquidity: Liquidity }[]): AssetSummary {
  const byLiquidity: Record<Liquidity, number> = { cash: 0, days: 0, weeks: 0, months: 0, hard: 0 };
  let worth = 0;
  let quickSale = 0;
  let withinWeek = 0;
  for (const a of assets) {
    const value = Math.max(0, a.value);
    worth += value;
    byLiquidity[a.liquidity] += value;
    quickSale += quickSaleValue(value, a.liquidity);
    if (a.liquidity === 'cash' || a.liquidity === 'days') withinWeek += quickSaleValue(value, a.liquidity);
  }
  return { worth, quickSale, withinWeek, byLiquidity };
}

// ---------------------------------------------------------------------------------------------
// Ways to earn: effort vs reward
// ---------------------------------------------------------------------------------------------

/** 1 = easy or even enjoyable … 5 = draining, stressful or risky. */
export type Strain = 1 | 2 | 3 | 4 | 5;

export interface OpportunityInput {
  /** Money it pays if it works out. */
  reward: number;
  /** Hours of your time it takes, including travel and follow-up. */
  hours: number;
  strain: Strain;
  /** Chance it pays off, 0–100. */
  chance: number;
}

export type OpportunityVerdict = 'great' | 'good' | 'fair' | 'poor';

export interface OpportunityScore {
  /** reward × chance. */
  expected: number;
  /** hours × strain multiplier: an hour of draining work counts as up to two easy hours. */
  effortHours: number;
  /** Expected money per effort-hour: the number opportunities are ranked by. */
  perEffortHour: number;
  /** perEffortHour compared with the benchmark hourly rate (1 = as good as your usual hour). */
  ratio: number | null;
  verdict: OpportunityVerdict | null;
  /** Little time, good odds. */
  quickWin: boolean;
}

export function strainMultiplier(strain: number): number {
  const s = Math.min(5, Math.max(1, Math.round(strain)));
  return 1 + (s - 1) * 0.25;
}

/** Working hours in a year (40 h × 52 weeks), for turning yearly income into an hourly rate. */
export const WORK_HOURS_PER_YEAR = 2080;

export function scoreOpportunity(o: OpportunityInput, benchmarkPerHour: number | null): OpportunityScore {
  const chance = Math.min(100, Math.max(0, o.chance)) / 100;
  const expected = Math.max(0, o.reward) * chance;
  const effortHours = Math.max(0.25, o.hours) * strainMultiplier(o.strain);
  const perEffortHour = expected / effortHours;
  const ratio = benchmarkPerHour && benchmarkPerHour > 0 ? perEffortHour / benchmarkPerHour : null;
  let verdict: OpportunityVerdict | null = null;
  if (ratio !== null) verdict = ratio >= 2 ? 'great' : ratio >= 1 ? 'good' : ratio >= 0.5 ? 'fair' : 'poor';
  return { expected, effortHours, perEffortHour, ratio, verdict, quickWin: o.hours <= 8 && chance >= 0.7 && expected > 0 };
}

/**
 * What an ordinary hour of your time earns, used as the yardstick for opportunities: expected
 * yearly income over 2080 working hours. Without income, the median of the opportunities themselves.
 */
export function benchmarkHourlyRate(yearlyIncome: number, opportunities: OpportunityInput[]): number | null {
  if (yearlyIncome > 0) return yearlyIncome / WORK_HOURS_PER_YEAR;
  const rates = opportunities
    .map((o) => scoreOpportunity(o, null).perEffortHour)
    .filter((r) => r > 0)
    .sort((a, b) => a - b);
  if (rates.length === 0) return null;
  const mid = Math.floor(rates.length / 2);
  return rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;
}
