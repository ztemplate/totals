import { formatEthiopian } from './ethiopianCalendar';

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatNumber(value: number, fractionDigits = 2): string {
  const fixed = Math.abs(value).toFixed(fractionDigits);
  const [whole, fraction] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = value < 0 ? '-' : '';
  return fraction ? `${sign}${grouped}.${fraction}` : `${sign}${grouped}`;
}

export function formatMoney(value: number, options: { compact?: boolean; hidden?: boolean; currency?: string } = {}): string {
  const currency = options.currency ?? 'ETB';
  if (options.hidden) return `${currency} ••••`;
  if (options.compact) return `${currency} ${formatCompact(value)}`;
  return `${currency} ${formatNumber(value)}`;
}

export function formatCompact(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return formatNumber(value, abs % 1 === 0 ? 0 : 2);
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export function formatTime(date: Date): string {
  const hours = date.getHours();
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${h12}:${pad(date.getMinutes())} ${hours < 12 ? 'AM' : 'PM'}`;
}

export function formatDate(date: Date, calendar: 'gregorian' | 'ethiopian' = 'gregorian'): string {
  if (calendar === 'ethiopian') return formatEthiopian(date);
  return `${MONTHS_SHORT[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

export function formatDateTime(date: Date, calendar: 'gregorian' | 'ethiopian' = 'gregorian'): string {
  return `${formatDate(date, calendar)} · ${formatTime(date)}`;
}

export function formatMonth(date: Date): string {
  return `${MONTHS_SHORT[date.getMonth()]} ${date.getFullYear()}`;
}

export function relativeDayLabel(date: Date, calendar: 'gregorian' | 'ethiopian' = 'gregorian'): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diff = Math.round((today - day) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return formatDate(date, calendar);
}

export function maskAccountNumber(accountNumber: string, visible = 4): string {
  const trimmed = accountNumber.trim();
  if (trimmed.length <= visible) return trimmed;
  return `•••• ${trimmed.substring(trimmed.length - visible)}`;
}

export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.substring(1))
    .join(' ');
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function parseAmountInput(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '').trim();
  if (!cleaned) return null;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}
