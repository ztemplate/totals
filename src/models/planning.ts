import { parseDateInput } from '../utils/dates';
import {
  LIQUIDITY_LEVELS,
  PLAN_PRIORITIES,
  type IncomeCertainty,
  type IncomeFrequency,
  type Liquidity,
  type PlanPriority,
  type Strain,
} from '../utils/planning';

/** Something you plan to buy. Dates are stored as YYYY-MM-DD (Gregorian) and shown in the chosen calendar. */
export interface PlannedItem {
  id: number;
  name: string;
  price: number;
  priority: PlanPriority;
  neededBy: string | null;
  saved: number;
  note: string | null;
  bought: boolean;
  boughtAt: string | null;
  profileId?: number | null;
  createdAt: string;
  updatedAt?: string | null;
}

/** Money you expect: a salary, rent you collect, a one-off payment… */
export interface IncomeSource {
  id: number;
  name: string;
  amount: number;
  frequency: IncomeFrequency;
  startDate: string;
  endDate: string | null;
  certainty: IncomeCertainty;
  note: string | null;
  profileId?: number | null;
  createdAt: string;
  updatedAt?: string | null;
}

export interface Asset {
  id: number;
  name: string;
  value: number;
  liquidity: Liquidity;
  note: string | null;
  profileId?: number | null;
  createdAt: string;
  updatedAt?: string | null;
}

/** A possible way to make money, rated by effort and reward. */
export interface MoneyOpportunity {
  id: number;
  name: string;
  reward: number;
  hours: number;
  strain: Strain;
  chance: number;
  note: string | null;
  done: boolean;
  profileId?: number | null;
  createdAt: string;
  updatedAt?: string | null;
}

export const INCOME_FREQUENCIES: { value: IncomeFrequency; label: string }[] = [
  { value: 'once', label: 'One time' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Every 3 months' },
  { value: 'yearly', label: 'Yearly' },
];

export const INCOME_CERTAINTIES: { value: IncomeCertainty; label: string }[] = [
  { value: 'certain', label: 'Certain' },
  { value: 'likely', label: 'Likely' },
  { value: 'uncertain', label: 'Maybe' },
];

export const LIQUIDITY_OPTIONS: { value: Liquidity; label: string; hint: string }[] = [
  { value: 'cash', label: 'Cash', hint: 'Cash, savings, money owed to you on demand' },
  { value: 'days', label: 'Days', hint: 'Sells in a few days near full price (phone, gold)' },
  { value: 'weeks', label: 'Weeks', hint: 'Takes weeks to sell (car, equipment)' },
  { value: 'months', label: 'Months', hint: 'Takes months (land share, business stake)' },
  { value: 'hard', label: 'Hard', hint: 'Hard to sell at all (house you live in, locked funds)' },
];

export const PRIORITY_META: Record<PlanPriority, { label: string; hint: string }> = {
  must: { label: 'Must', hint: 'Can’t go without: rent, school fees, medicine' },
  need: { label: 'Need', hint: 'Should get soon, but could wait a little' },
  want: { label: 'Want', hint: 'Nice to have' },
};

export function priorityFromStorage(value: unknown): PlanPriority {
  return PLAN_PRIORITIES.includes(value as PlanPriority) ? (value as PlanPriority) : 'need';
}

export function frequencyFromStorage(value: unknown): IncomeFrequency {
  return INCOME_FREQUENCIES.some((f) => f.value === value) ? (value as IncomeFrequency) : 'once';
}

export function certaintyFromStorage(value: unknown): IncomeCertainty {
  return INCOME_CERTAINTIES.some((c) => c.value === value) ? (value as IncomeCertainty) : 'certain';
}

export function liquidityFromStorage(value: unknown): Liquidity {
  return LIQUIDITY_LEVELS.includes(value as Liquidity) ? (value as Liquidity) : 'weeks';
}

export function strainFromStorage(value: unknown): Strain {
  const n = Math.round(Number(value));
  return (n >= 1 && n <= 5 ? n : 3) as Strain;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** A stored YYYY-MM-DD, or null when missing or invalid. */
export function dateFromStorage(value: unknown): string | null {
  return typeof value === 'string' && parseDateInput(value) ? value : null;
}

export function plannedItemFromDb(row: Record<string, any>): PlannedItem {
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    price: num(row.price),
    priority: priorityFromStorage(row.priority),
    neededBy: dateFromStorage(row.neededBy),
    saved: num(row.saved),
    note: text(row.note),
    bought: !!row.bought,
    boughtAt: text(row.boughtAt),
    profileId: row.profileId ?? null,
    createdAt: row.createdAt ?? new Date().toISOString(),
    updatedAt: row.updatedAt ?? null,
  };
}

export function incomeSourceFromDb(row: Record<string, any>): IncomeSource {
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    amount: num(row.amount),
    frequency: frequencyFromStorage(row.frequency),
    startDate: dateFromStorage(row.startDate) ?? String(row.createdAt ?? '').slice(0, 10),
    endDate: dateFromStorage(row.endDate),
    certainty: certaintyFromStorage(row.certainty),
    note: text(row.note),
    profileId: row.profileId ?? null,
    createdAt: row.createdAt ?? new Date().toISOString(),
    updatedAt: row.updatedAt ?? null,
  };
}

export function assetFromDb(row: Record<string, any>): Asset {
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    value: num(row.value),
    liquidity: liquidityFromStorage(row.liquidity),
    note: text(row.note),
    profileId: row.profileId ?? null,
    createdAt: row.createdAt ?? new Date().toISOString(),
    updatedAt: row.updatedAt ?? null,
  };
}

export function opportunityFromDb(row: Record<string, any>): MoneyOpportunity {
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    reward: num(row.reward),
    hours: num(row.hours),
    strain: strainFromStorage(row.strain),
    chance: Math.min(100, Math.max(0, num(row.chance))),
    note: text(row.note),
    done: !!row.done,
    profileId: row.profileId ?? null,
    createdAt: row.createdAt ?? new Date().toISOString(),
    updatedAt: row.updatedAt ?? null,
  };
}
