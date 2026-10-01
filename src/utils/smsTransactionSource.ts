/** SMS provenance helpers: fingerprints, Telebirr leg scoping, display references. */

const TELEBIRR_BANK_ID = 6;
const LEG_SUFFIX = '__totals_tb_leg_';
const LEG_SUFFIX_RE = /__totals_tb_leg_(debit|credit)$/i;

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

export const SMS_SOURCE_TYPE = 'sms';

function utf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (const char of value) {
    let code = char.codePointAt(0)!;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      code = Math.min(code, 0x10ffff);
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

export function fnv1a64Hex(value: string): string {
  let hash = FNV_OFFSET;
  for (const byte of utf8Bytes(value)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

export function smsFingerprint(bankId: number | null | undefined, sender: string | null | undefined, body: string): string {
  const normalizedSender = (sender ?? '').trim().toLowerCase();
  const normalizedBody = body.trim().replace(/\s+/g, ' ');
  return fnv1a64Hex(`sms|v2|${bankId ?? ''}|${normalizedSender}|${normalizedBody}`);
}

export interface SmsTransactionSource {
  bankId?: number | null;
  messageId?: string | null;
  fingerprint?: string | null;
  subscriptionId?: number | null;
}

export function buildSmsSource(params: {
  bankId: number | null | undefined;
  sender: string | null | undefined;
  body: string;
  messageId?: string | null;
  subscriptionId?: number | null;
}): SmsTransactionSource {
  const messageId = params.messageId?.trim() ? params.messageId.trim() : null;
  return {
    bankId: params.bankId ?? null,
    messageId,
    fingerprint: smsFingerprint(params.bankId, params.sender, params.body),
    subscriptionId: params.subscriptionId ?? null,
  };
}

export function hasIdentity(source: SmsTransactionSource | null | undefined): boolean {
  if (!source) return false;
  return !!source.messageId?.trim() || !!source.fingerprint?.trim();
}

/** Bank reference with internal Telebirr leg markers removed. */
export function displayReference(bankId: number | null | undefined, reference: string | null | undefined): string {
  const value = reference ?? '';
  if (bankId !== TELEBIRR_BANK_ID) return value;
  return value.replace(LEG_SUFFIX_RE, '');
}

/**
 * Telebirr can deliver a debit and a credit SMS for the same bank reference
 * (self transfers); scope the stored reference per leg so both rows persist.
 */
export function scopeReference(params: {
  bankId: number | null | undefined;
  reference: string | null | undefined;
  type: string | null | undefined;
  source?: SmsTransactionSource | null;
}): string | null {
  const display = displayReference(params.bankId, params.reference).trim();
  if (!display) return null;
  if (params.bankId !== TELEBIRR_BANK_ID || !hasIdentity(params.source)) return display;
  const direction = (params.type ?? '').trim().toLowerCase();
  if (direction !== 'debit' && direction !== 'credit') return display;
  return `${display}${LEG_SUFFIX}${direction}`;
}

export function canonicalReference(bankId: number | null | undefined, reference: string | null | undefined): string {
  return displayReference(bankId, reference)
    .trim()
    .replace(/[\s.,;:]+$/, '')
    .replace(/\s+/g, '')
    .toUpperCase();
}

export function logicalLegKey(bankId: number | null | undefined, reference: string | null | undefined, type: string | null | undefined): string {
  return `${bankId ?? ''}|${canonicalReference(bankId, reference)}|${(type ?? '').trim().toUpperCase()}`;
}

export function sourceToJson(source: SmsTransactionSource | null | undefined): Record<string, unknown> {
  if (!source || !hasIdentity(source)) return {};
  const json: Record<string, unknown> = { sourceType: SMS_SOURCE_TYPE };
  if (source.messageId) json.sourceMessageId = source.messageId;
  if (source.fingerprint) json.sourceFingerprint = source.fingerprint;
  if (source.subscriptionId != null && source.subscriptionId >= 0) {
    json.sourceSubscriptionId = source.subscriptionId;
  }
  return json;
}
