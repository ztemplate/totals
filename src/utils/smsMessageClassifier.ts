const TELEBIRR_ATM_AUTH_RE = /\bATM\s+withdraw(?:al)?\s+secret\s+code\s+is\s+(\d{4,8})\b/i;

const TELEBIRR_AIRTIME_RECEIPT_RES = [
  /you\s+have\s+received\s+ETB\s+[\d,.]+\s+airtime\s+from\s+\S+[\s\S]*?transaction\s+number\s+is\s+([A-Z0-9@-]+)/i,
  /[\d,.]+\s+ብር[\s\S]*?ተሞልቶሎታል[\s\S]*?ቁጥርዎ\s+([A-Z0-9@-]+)/i,
];

/** Telebirr sends a one-time code SMS before an ATM withdrawal; it is not a transaction. */
export function isTelebirrAtmAuthorization(bankId: number | null | undefined, body: string): boolean {
  return bankId === 6 && TELEBIRR_ATM_AUTH_RE.test(body);
}

/** Airtime receipts mirror a debit that already arrived as its own SMS. */
export function isTelebirrAirtimeReceipt(bankId: number | null | undefined, body: string): boolean {
  if (bankId !== 6) return false;
  return TELEBIRR_AIRTIME_RECEIPT_RES.some((re) => re.test(body));
}

const TRANSACTION_KEYWORDS = [
  'debited',
  'credited',
  'deposit',
  'withdraw',
  'withdrawal',
  'transfer',
  'transferred',
  'payment',
  'paid',
  'purchase',
  'received',
  'sent',
  'spent',
  'cash out',
  'cashout',
  'atm',
  'trx',
  'txn',
  'transaction',
];

const SUPPORTING_KEYWORDS = [
  'balance',
  'amount',
  'amt',
  'available balance',
  'ref',
  'reference',
  'account',
  'ac',
  'a/c',
  'card',
  'merchant',
  'pos',
  'wallet',
  'etb',
  'birr',
  'br',
];

const MONEY_RE = /(?:etb|birr|br)\s*\d|\d[\d,]*(?:\.\d{1,2})?\s*(?:etb|birr|br)/i;

function containsWord(haystack: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(haystack);
}

/** Heuristic used to record unparsed bank messages as failed parses. */
export function looksLikeTransaction(body: string): boolean {
  const lower = body.toLowerCase();
  const hasTransactionKeyword = TRANSACTION_KEYWORDS.some((k) => containsWord(lower, k));
  if (!hasTransactionKeyword) return false;
  return SUPPORTING_KEYWORDS.some((k) => containsWord(lower, k)) || MONEY_RE.test(lower);
}
