import type { Bank } from '../models/bank';
import type { SmsPattern } from '../models/smsPattern';
import { extractReferenceFromLink, extractTransactionLinkFromMessage } from './transactionLinkUtils';

export interface ParsedSms {
  type: string;
  amount: number;
  reference: string | null;
  currentBalance: string | null;
  accountNumber: string | null;
  creditor: string | null;
  receiver: string | null;
  serviceCharge: number | null;
  vat: number | null;
  rawTime: string | null;
  time: string;
  transactionLink: string | null;
  bankId: number;
  patternDescription: string;
}

export function cleanNumber(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  let cleaned = value.replace(/,/g, '').trim();
  cleaned = cleaned.replace(/[^0-9.]$/, '');
  cleaned = cleaned.replace(/\.+$/, '');
  return cleaned.length === 0 ? null : cleaned;
}

function group(match: RegExpMatchArray, name: string): string | null {
  const value = match.groups?.[name];
  if (value === undefined || value === null) return null;
  return value;
}

function hasGroup(regexSource: string, name: string): boolean {
  return regexSource.includes(`(?<${name}>`);
}

function firstGroup(match: RegExpMatchArray, names: string[]): string | null {
  for (const name of names) {
    const value = group(match, name);
    if (value !== null && value.trim() !== '') return value;
  }
  return null;
}

function parseOptionalDouble(raw: string | null): number | null {
  const cleaned = cleanNumber(raw);
  if (cleaned === null) return null;
  const value = Number.parseFloat(cleaned);
  return Number.isNaN(value) ? null : value;
}

const COUNTERPARTY_FALLBACKS = [
  /from\s+(.+?)\s+(?:to|on|at|ref|reference|transaction|balance)/i,
  /by\s+(.+?)\s+(?:on|through|ref|reference|transaction|balance)/i,
  /with\s+agent\s+(.+?)\s+(?:on|at|ref|reference|transaction|balance)/i,
];

function fallbackCounterparty(message: string): string | null {
  for (const re of COUNTERPARTY_FALLBACKS) {
    const match = message.match(re);
    const candidate = match?.[1]?.trim();
    if (!candidate) continue;
    const lower = candidate.toLowerCase();
    if (lower.includes('your account') || lower.includes('your telebirr') || lower.includes('your mpesa')) continue;
    return candidate;
  }
  return null;
}

/** Compiles Dart-style regex strings for JS (multiLine, caseInsensitive, dotAll). */
const regexCache = new Map<string, RegExp | null>();
function compile(source: string): RegExp | null {
  if (regexCache.has(source)) return regexCache.get(source)!;
  let compiled: RegExp | null = null;
  try {
    compiled = new RegExp(source, 'ims');
  } catch {
    try {
      // Patterns written for Dart sometimes use inline flags JS does not accept.
      compiled = new RegExp(source.replace(/^\(\?[a-z]+\)/i, ''), 'ims');
    } catch {
      compiled = null;
    }
  }
  regexCache.set(source, compiled);
  return compiled;
}

interface CompiledPattern {
  source: string;
  re: RegExp | null;
  hasBalanceGroup: boolean;
  hasAccountGroup: boolean;
}

/** Per pattern object, so a scan does not look up every regex source string for every message. */
const compiledPatterns = new WeakMap<SmsPattern, CompiledPattern>();
function compiledFor(pattern: SmsPattern): CompiledPattern {
  const cached = compiledPatterns.get(pattern);
  if (cached && cached.source === pattern.regex) return cached;
  const compiled: CompiledPattern = {
    source: pattern.regex,
    re: compile(pattern.regex),
    hasBalanceGroup: hasGroup(pattern.regex, 'balance'),
    hasAccountGroup: hasGroup(pattern.regex, 'account'),
  };
  compiledPatterns.set(pattern, compiled);
  return compiled;
}

export function parsePatternMessage(params: {
  message: string;
  patterns: SmsPattern[];
  bank: Bank | null | undefined;
  bankId: number;
  messageDate?: Date | null;
}): ParsedSms | null {
  const { message, patterns, bank, bankId } = params;
  for (const pattern of patterns) {
    try {
      const compiled = compiledFor(pattern);
      const re = compiled.re;
      if (!re) continue;
      const match = message.match(re);
      if (!match) continue;

      const amount = parseOptionalDouble(group(match, 'amount'));
      if (amount === null) continue;

      const balance = cleanNumber(group(match, 'balance'));
      if (compiled.hasBalanceGroup && balance === null) continue;

      let account = group(match, 'account')?.trim() ?? null;
      if (account === '') account = null;
      const maskPattern = bank?.maskPattern ?? 0;
      if (account && bank?.uniformMasking && maskPattern > 0 && account.length >= maskPattern) {
        account = account.substring(account.length - maskPattern);
      }

      let reference = group(match, 'reference')?.trim() ?? null;
      if (reference === '') reference = null;

      let type = pattern.type.trim().toUpperCase();
      const typeGroup = group(match, 'type')?.trim().toLowerCase();
      if (typeGroup) {
        if (typeGroup.includes('debit')) type = 'DEBIT';
        else if (typeGroup.includes('credit')) type = 'CREDIT';
      }

      let creditor = group(match, 'creditor')?.trim() || null;
      const receiver = group(match, 'receiver')?.trim() || null;

      const serviceCharge = parseOptionalDouble(
        firstGroup(match, ['serviceCharge', 'ServiceCharge', 'servicecharge', 'service_charge']),
      );
      const vat = parseOptionalDouble(firstGroup(match, ['vat', 'VAT']));

      let counterparty = firstGroup(match, ['sender', 'source', 'agent', 'payer', 'from']);
      if (type === 'CREDIT' && !counterparty) {
        counterparty = fallbackCounterparty(message);
      }
      if (!creditor && counterparty) creditor = counterparty.trim();

      const rawTime = group(match, 'time');

      const transactionLink = extractTransactionLinkFromMessage({
        message,
        bankId,
        reference,
        patternDescription: pattern.description,
        patternRegex: pattern.regex,
      });
      if (!reference && transactionLink) {
        reference = extractReferenceFromLink(transactionLink);
      }

      if (pattern.refRequired === false && !reference) {
        reference = `${bankId}_${(params.messageDate ?? new Date()).toISOString()}`;
      }

      if (pattern.refRequired && !reference) continue;
      if (pattern.hasAccount && compiled.hasAccountGroup && !account) continue;

      return {
        type,
        amount,
        reference,
        currentBalance: balance,
        accountNumber: account,
        creditor,
        receiver,
        serviceCharge,
        vat,
        rawTime,
        time: new Date().toISOString(),
        transactionLink,
        bankId,
        patternDescription: pattern.description,
      };
    } catch {
      continue;
    }
  }
  return null;
}
