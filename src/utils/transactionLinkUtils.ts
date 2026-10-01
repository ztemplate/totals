import type { Transaction } from '../models/transaction';
import { displayReference } from './smsTransactionSource';

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const SAFE_REFERENCE_RE = /^[A-Za-z0-9@.\-]+$/;

export function normalizeLink(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/[\].,;:)\s]+$/, '');
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

export function extractUrls(message: string): string[] {
  const urls: string[] = [];
  for (const match of message.matchAll(URL_RE)) {
    const normalized = normalizeLink(match[0]);
    if (normalized) urls.push(normalized);
  }
  return urls;
}

function isReceiptLike(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('receipt') ||
    lower.includes('branchreceipt') ||
    lower.includes('?trx=') ||
    lower.includes('?id=') ||
    lower.includes('share.zemenbank.com/rt/')
  );
}

export function inferTransactionLink(bankId: number | null | undefined, reference: string | null | undefined): string | null {
  const ref = (reference ?? '').trim();
  if (!ref) return null;
  switch (bankId) {
    case 1:
      return `https://apps.cbe.come.et:100/?id=${encodeURIComponent(ref)}`;
    case 5:
      return `https://share.zemenbank.com/rt/${encodeURIComponent(ref)}/pdf`;
    case 6: {
      const cleaned = ref.replace(/[.,;:]+$/, '');
      if (!SAFE_REFERENCE_RE.test(cleaned)) return null;
      return `https://transactioninfo.ethiotelecom.et/receipt/${encodeURIComponent(cleaned)}`;
    }
    default:
      return null;
  }
}

export function extractTransactionLinkFromMessage(params: {
  message: string;
  bankId: number | null | undefined;
  reference?: string | null;
  patternDescription?: string | null;
  patternRegex?: string | null;
}): string | null {
  const urls = extractUrls(params.message);
  const ref = (params.reference ?? '').trim().toLowerCase();
  if (urls.length > 0) {
    if (ref) {
      const withRef = urls.find((url) => url.toLowerCase().includes(ref));
      if (withRef) return withRef;
    }
    const context = `${params.patternDescription ?? ''}${params.patternRegex ?? ''}${params.message}`;
    if (urls.length === 1 || isReceiptLike(context)) return urls[urls.length - 1];
  }
  return inferTransactionLink(params.bankId, params.reference);
}

export function extractReferenceFromLink(link: string | null | undefined): string | null {
  const normalized = normalizeLink(link);
  if (!normalized) return null;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }
  for (const key of ['id', 'reference', 'trx']) {
    let value: string | null = null;
    try {
      value = url.searchParams.get(key);
    } catch {
      const match = normalized.match(new RegExp(`[?&]${key}=([^&#]+)`, 'i'));
      value = match ? decodeURIComponent(match[1]) : null;
    }
    if (value && SAFE_REFERENCE_RE.test(value.trim())) return value.trim();
  }
  const segments = url.pathname.split('/').filter(Boolean);
  const receiptIndex = segments.findIndex((s) => s.toLowerCase() === 'receipt');
  if (receiptIndex >= 0 && receiptIndex + 1 < segments.length) {
    const candidate = decodeURIComponent(segments[receiptIndex + 1]).trim();
    if (candidate) return candidate;
  }
  return null;
}

/** Persisted link first, otherwise a link inferred from the display reference. */
export function resolveReferenceLink(tx: Transaction): string | null {
  const persisted = normalizeLink(tx.transactionLink);
  if (persisted) return persisted;
  return inferTransactionLink(tx.bankId, displayReference(tx.bankId, tx.reference));
}
