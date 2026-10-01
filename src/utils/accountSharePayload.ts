import type { Bank } from '../models/bank';

/** Port of account_share_payload.dart: the QR format used to share account numbers between Totals users. */

export interface AccountShareEntry {
  bankId: number;
  accountNumber: string;
  name: string | null;
  bankName: string | null;
  bankShortName: string | null;
}

export interface AccountSharePayload {
  version: number;
  name: string;
  accounts: AccountShareEntry[];
}

export const ACCOUNT_SHARE_PREFIX = 'totals:accounts:';
const CURRENT_VERSION = 2;
const DEFAULT_NAME = 'Imported Account';

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  const text = asText(value);
  if (!text || !/^-?\d+$/.test(text)) return null;
  return Number.parseInt(text, 10);
}

function normalizeLookupKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function buildBankLookup(banks: Bank[]): Map<string, number> {
  const lookup = new Map<string, number>();
  const add = (value: string, id: number) => {
    const key = normalizeLookupKey(value);
    if (key && !lookup.has(key)) lookup.set(key, id);
  };
  for (const bank of banks) {
    add(bank.name, bank.id);
    add(bank.shortName, bank.id);
    for (const code of bank.codes) add(code, bank.id);
  }
  return lookup;
}

function resolveBankId(json: Record<string, unknown>, banks: Bank[], lookup: Map<string, number>): number | null {
  const explicit = asInt(json.bankId) ?? asInt(json.bank_id) ?? asInt(json.bankID);
  if (explicit !== null) return explicit;

  const bankValue = json.bank;
  if (typeof bankValue === 'number' && Number.isFinite(bankValue)) return Math.trunc(bankValue);
  const bankText = asText(bankValue);
  if (bankText) {
    const parsed = asInt(bankText);
    if (parsed !== null && banks.some((b) => b.id === parsed)) return parsed;
  }
  const candidates = [bankText, asText(json.bankName), asText(json.bankShort), asText(json.bankShortName), asText(json.shortName)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = lookup.get(normalizeLookupKey(candidate));
    if (resolved !== undefined) return resolved;
  }
  return null;
}

function entryFromJson(json: Record<string, unknown>, banks: Bank[], lookup: Map<string, number>): AccountShareEntry | null {
  const bankId = resolveBankId(json, banks, lookup);
  const accountNumber = asText(json.accountNumber ?? json.number ?? json.account ?? json.accountNo ?? json.account_number);
  if (bankId === null || !accountNumber) return null;
  const bankValue = json.bank;
  const bankName =
    typeof bankValue === 'string' && asInt(bankValue) === null ? asText(bankValue) : asText(json.bankName);
  return {
    bankId,
    accountNumber,
    name: asText(json.name ?? json.accountName ?? json.label ?? json.title),
    bankName,
    bankShortName: asText(json.bankShort ?? json.bankShortName ?? json.shortName),
  };
}

function parseEntries(raw: unknown, banks: Bank[], lookup: Map<string, number>): AccountShareEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: AccountShareEntry[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const parsed = entryFromJson(item as Record<string, unknown>, banks, lookup);
      if (parsed) entries.push(parsed);
    }
  }
  return entries;
}

function payloadFromJson(json: Record<string, unknown>, banks: Bank[], lookup: Map<string, number>): AccountSharePayload | null {
  const entries = parseEntries(json.accounts ?? json.entries ?? json.items, banks, lookup);
  if (entries.length === 0) {
    // Also accept single-account payloads.
    const single = entryFromJson(json, banks, lookup);
    if (single) entries.push(single);
  }
  if (entries.length === 0) return null;
  const name =
    asText(json.profile) ??
    asText(json.name) ??
    asText(json.displayName) ??
    asText(json.accountHolderName) ??
    asText(json.holderName) ??
    asText(json.fullName) ??
    entries.map((e) => e.name).find((n): n is string => !!n) ??
    DEFAULT_NAME;
  const version = asInt(json.version) ?? asInt(json.schemaVersion) ?? asInt(json.v) ?? CURRENT_VERSION;
  return { version, name, accounts: entries };
}

function parseJsonPayload(raw: string, banks: Bank[], lookup: Map<string, number>): AccountSharePayload | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (Array.isArray(value)) {
    const entries = parseEntries(value, banks, lookup);
    return entries.length > 0 ? { version: 0, name: DEFAULT_NAME, accounts: entries } : null;
  }
  if (value && typeof value === 'object') return payloadFromJson(value as Record<string, unknown>, banks, lookup);
  return null;
}

// --- base64url + UTF-8, implemented locally so it does not depend on runtime globals ---

function utf8Encode(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out += String.fromCharCode(cp);
    else if (cp < 0x800) out += String.fromCharCode(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000)
      out += String.fromCharCode(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else
      out += String.fromCharCode(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
  }
  return out;
}

function utf8Decode(bytes: string): string | null {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes.charCodeAt(i);
    let cp: number;
    let extra: number;
    if (b0 < 0x80) {
      cp = b0;
      extra = 0;
    } else if ((b0 & 0xe0) === 0xc0) {
      cp = b0 & 0x1f;
      extra = 1;
    } else if ((b0 & 0xf0) === 0xe0) {
      cp = b0 & 0x0f;
      extra = 2;
    } else if ((b0 & 0xf8) === 0xf0) {
      cp = b0 & 0x07;
      extra = 3;
    } else {
      return null;
    }
    if (i + extra >= bytes.length && extra > 0) return null;
    for (let k = 1; k <= extra; k++) {
      const b = bytes.charCodeAt(i + k);
      if (Number.isNaN(b) || (b & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (b & 0x3f);
    }
    out += String.fromCodePoint(cp);
    i += extra + 1;
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Encodes a binary (byte-per-char) string as unpadded base64url. */
function bytesToBase64Url(bytes: string): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes.charCodeAt(i);
    const b1 = i + 1 < bytes.length ? bytes.charCodeAt(i + 1) : -1;
    const b2 = i + 2 < bytes.length ? bytes.charCodeAt(i + 2) : -1;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 < 0 ? 0 : b1 >> 4)];
    if (b1 >= 0) out += B64[((b1 & 15) << 2) | (b2 < 0 ? 0 : b2 >> 6)];
    if (b2 >= 0) out += B64[b2 & 63];
  }
  return out;
}

/** Decodes base64 or base64url (padding optional) to a binary string. */
function base64ToBytes(raw: string): string | null {
  const cleaned = raw.replace(/\s+/g, '').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (!cleaned || cleaned.length % 4 === 1) return null;
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const ch of cleaned) {
    const value = B64.indexOf(ch);
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return out;
}

function base64UrlEncode(text: string): string {
  return bytesToBase64Url(utf8Encode(text));
}

function base64UrlDecode(raw: string): string | null {
  const bytes = base64ToBytes(raw);
  return bytes === null ? null : utf8Decode(bytes);
}

export function encodeAccountSharePayload(payload: { name: string; accounts: AccountShareEntry[] }): string {
  const json = {
    profile: payload.name,
    accounts: payload.accounts.map((entry) => {
      const name = asText(entry.name) ?? asText(payload.name);
      return { ...(name ? { name } : {}), bankId: String(entry.bankId), number: entry.accountNumber };
    }),
  };
  return `${ACCOUNT_SHARE_PREFIX}${base64UrlEncode(JSON.stringify(json))}`;
}

export function decodeAccountSharePayload(raw: string, banks: Bank[]): AccountSharePayload | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lookup = buildBankLookup(banks);
  if (trimmed.startsWith(ACCOUNT_SHARE_PREFIX)) {
    const encoded = trimmed.substring(ACCOUNT_SHARE_PREFIX.length);
    if (!encoded) return null;
    const decoded = base64UrlDecode(encoded);
    const fromBase64 = decoded ? parseJsonPayload(decoded, banks, lookup) : null;
    if (fromBase64) return fromBase64;
    // Backward compatibility: legacy prefixed raw JSON.
    return parseJsonPayload(encoded, banks, lookup);
  }
  const fromJson = parseJsonPayload(trimmed, banks, lookup);
  if (fromJson) return fromJson;
  const decoded = base64UrlDecode(trimmed);
  return decoded ? parseJsonPayload(decoded, banks, lookup) : null;
}
