/** Ethiopian (Amete Mihret) calendar conversions via Julian Day Numbers. */

/** Julian Day Number of the Amete Mihret epoch (Meskerem 1, year 1 is epoch + 365). */
const ETHIOPIAN_EPOCH = 1723856;

export const ETHIOPIAN_MONTHS = [
  'Meskerem',
  'Tikimt',
  'Hidar',
  'Tahsas',
  'Tir',
  'Yekatit',
  'Megabit',
  'Miyazya',
  'Ginbot',
  'Sene',
  'Hamle',
  'Nehase',
  'Pagume',
];

export interface EthiopianDate {
  year: number;
  month: number;
  day: number;
}

function gregorianToJdn(year: number, month: number, day: number): number {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return (
    day +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045
  );
}

function jdnToGregorian(jdn: number): { year: number; month: number; day: number } {
  const a = jdn + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor((146097 * b) / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  return {
    day: e - Math.floor((153 * m + 2) / 5) + 1,
    month: m + 3 - 12 * Math.floor(m / 10),
    year: 100 * b + d - 4800 + Math.floor(m / 10),
  };
}

function ethiopianToJdn(year: number, month: number, day: number): number {
  return ETHIOPIAN_EPOCH + 365 + 365 * (year - 1) + Math.floor(year / 4) + 30 * month + day - 31;
}

function jdnToEthiopian(jdn: number): EthiopianDate {
  const r = (((jdn - ETHIOPIAN_EPOCH) % 1461) + 1461) % 1461;
  const n = (r % 365) + 365 * Math.floor(r / 1460);
  const year = 4 * Math.floor((jdn - ETHIOPIAN_EPOCH) / 1461) + Math.floor(r / 365) - Math.floor(r / 1460);
  return { year, month: Math.floor(n / 30) + 1, day: (n % 30) + 1 };
}

export function toEthiopian(date: Date): EthiopianDate {
  return jdnToEthiopian(gregorianToJdn(date.getFullYear(), date.getMonth() + 1, date.getDate()));
}

/** Local-midnight Gregorian date for an Ethiopian date. */
export function fromEthiopian(eth: EthiopianDate): Date {
  const g = jdnToGregorian(ethiopianToJdn(eth.year, eth.month, eth.day));
  return new Date(g.year, g.month - 1, g.day);
}

export function isEthiopianLeapYear(year: number): boolean {
  return year % 4 === 3;
}

export function daysInEthiopianMonth(year: number, month: number): number {
  if (month < 13) return 30;
  return isEthiopianLeapYear(year) ? 6 : 5;
}

export function formatEthiopian(date: Date, withYear = true): string {
  const eth = toEthiopian(date);
  const name = ETHIOPIAN_MONTHS[eth.month - 1];
  return withYear ? `${name} ${eth.day}, ${eth.year}` : `${name} ${eth.day}`;
}

export function ethiopianMonthLabel(date: Date): string {
  const eth = toEthiopian(date);
  return `${ETHIOPIAN_MONTHS[eth.month - 1]} ${eth.year}`;
}
