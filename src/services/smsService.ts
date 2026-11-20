import { AppRegistry, Platform } from 'react-native';
import {
  addSmsListener,
  getInbox,
  hasSmsPermission,
  SMS_HEADLESS_TASK,
  type RawSms,
} from '../../modules/sms-reader';
import { getDb } from '../db/database';
import type { Account } from '../models/account';
import type { Bank } from '../models/bank';
import type { TransactionSourceSms } from '../models/misc';
import type { SmsPattern } from '../models/smsPattern';
import { makeTransaction, OwnerAssignment, transactionFromJson, type Transaction } from '../models/transaction';
import { accountRepository } from '../repositories/accountRepository';
import { bankById, bankRepository } from '../repositories/bankRepository';
import { categoryRepository } from '../repositories/categoryRepository';
import { failedParseRepository } from '../repositories/failedParseRepository';
import { profileRepository } from '../repositories/profileRepository';
import { transactionRepository, type TransactionOwnershipUpdate } from '../repositories/transactionRepository';
import { checkSmsOwnership, type SmsOwnership, type SmsOwnershipCheck } from '../utils/accountIdentity';
import { findBankForSender, normalizeSender, senderAddressMatchesBank } from '../utils/bankSenderMatcher';
import { CASH_ACCOUNT_NUMBER, CASH_ATM_REFERENCE_PREFIX, CASH_BANK_ID } from '../utils/cashConstants';
import { parsePatternMessage } from '../utils/patternParser';
import { TransactionIndex } from '../utils/smsScanIndex';
import { transactionsToSuppress } from '../utils/selfTransfer';
import {
  isTelebirrAirtimeReceipt,
  isTelebirrAtmAuthorization,
  looksLikeTransaction,
} from '../utils/smsMessageClassifier';
import { buildSmsSource, scopeReference, SMS_SOURCE_TYPE, sourceToJson } from '../utils/smsTransactionSource';
import { autoCategorization, type AutoCategorizationSelection } from './autoCategorization';
import { dataChanged } from './dataChanged';
import { failedParseReviewService, NO_MATCHING_PATTERN_REASON } from './failedParseReview';
import { notificationService } from './notifications';
import { notificationSettings } from './notificationSettings';
import { PrefKeys, prefs } from './prefs';
import { smsConfigService } from './smsConfigService';

export type ParseStatus = 'success' | 'noBank' | 'noPattern' | 'duplicate' | 'unregisteredBank';

export interface ParseResult {
  status: ParseStatus;
  transaction?: Transaction | null;
  reason?: string | null;
  /** For duplicates: the stored transaction the message matched. */
  existing?: Transaction | null;
}

export interface TodaySmsSyncResult {
  processed: number;
  added: number;
  duplicates: number;
  noPattern: number;
  skipped: number;
  errors: number;
  permissionDenied: boolean;
}

const EMPTY_SYNC_RESULT: TodaySmsSyncResult = {
  processed: 0,
  added: 0,
  duplicates: 0,
  noPattern: 0,
  skipped: 0,
  errors: 0,
  permissionDenied: false,
};

const DASHEN_BANK_ID = 4;
const SCAN_OVERLAP_MS = 10 * 60 * 1000;
const CANONICAL_INBOX_LOOKUP_ATTEMPTS = 3;
const CANONICAL_INBOX_LOOKUP_DELAY_MS = 750;
const CANONICAL_INBOX_LOOKUP_WINDOW_MS = 2 * 60 * 1000;
const CANONICAL_INBOX_LOOKUP_FUTURE_SLACK_MS = 15 * 1000;

/** Imports write in batches of about this many rows, each batch in one SQLite transaction. */
const FLUSH_EVERY_WRITES = 400;
/** Batch scans give the UI thread a turn this often (messages). */
const YIELD_EVERY_MESSAGES = 50;
/** Catch-up scans notify for new transactions whose message is at most this old. */
const RECENT_NOTIFICATION_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Catch-up scans show at most this many individual notifications, then one summary. */
const MAX_INDIVIDUAL_CATCHUP_NOTIFICATIONS = 5;

/** Notifications are shown one at a time so self-transfer pairs can withdraw each other. */
let notificationTurn: Promise<void> = Promise.resolve();

/**
 * SMS processing (live messages, scans, retries) runs one job at a time. A scan works on an
 * in-memory snapshot of the transactions, so a live message handled in the middle of it
 * would be invisible to the scan (and the scan to it). Running them in turn also lets the
 * live listener see a row a scan just imported silently, and notify for it.
 */
let smsWorkChain: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = smsWorkChain.then(work);
  smsWorkChain = run.catch(() => undefined);
  return run;
}

interface ProcessOptions {
  messageDate?: Date | null;
  notifyUser?: boolean;
  skipDashenExpenseDuplicates?: boolean;
  skipAutoCategorization?: boolean;
  recordFailure?: boolean;
  sourceMessageId?: string | null;
  sourceSubscriptionId?: number | null;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Every bank sender code, normalized, for the native inbox prefilter. */
function senderCodesFor(banks: Bank[]): string[] {
  const codes = new Set<string>();
  for (const bank of banks) {
    for (const code of bank.codes) {
      const normalized = normalizeSender(code);
      if (normalized) codes.add(normalized);
    }
  }
  return [...codes];
}

function sortChronological(messages: RawSms[]): RawSms[] {
  // Oldest first, so the latest balance wins.
  return [...messages].sort((a, b) => (a.date ?? 0) - (b.date ?? 0));
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function smsDate(sms: RawSms, fallback: Date | null = null): Date | null {
  return sms.date == null ? fallback : new Date(sms.date);
}

function normalizedSubscriptionId(value: number | null | undefined): number | null {
  return value == null || value < 0 ? null : value;
}

// ------------------------------------------------------------------ amounts

export function sanitizeAmount(raw: string | null | undefined): number {
  if (raw == null) return 0;
  let cleaned = raw.trim().replace(/[^0-9.]/g, '');
  const firstDot = cleaned.indexOf('.');
  if (firstDot !== -1) {
    cleaned = cleaned.substring(0, firstDot + 1) + cleaned.substring(firstDot + 1).replace(/\./g, '');
  }
  if (cleaned.endsWith('.')) cleaned += '0';
  if (!cleaned) return 0;
  const value = Number.parseFloat(cleaned);
  return Number.isNaN(value) ? 0 : value;
}

// ------------------------------------------------------------------ bank lookup

async function getRelevantBank(address: string | null | undefined): Promise<Bank | null> {
  if (!address) return null;
  return findBankForSender(address, await bankRepository.getBanks());
}

async function isRelevantMessage(address: string | null | undefined): Promise<boolean> {
  return (await getRelevantBank(address)) !== null;
}

async function recordFailedParse(params: {
  address: string;
  body: string;
  reason: string;
  timestamp?: Date | null;
  bankId?: number | null;
}): Promise<void> {
  await failedParseRepository.add({
    address: params.address,
    body: params.body,
    reason: params.reason,
    timestamp: (params.timestamp ?? new Date()).toISOString(),
  });
}

// ------------------------------------------------------------------ canonical inbox copy

/**
 * Multipart SMS can reach the live listener as a partial or differently-encoded
 * body. The inbox copy written by the system is canonical, so look it up.
 */
function normalizeSmsComparisonText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function smsComparisonTokens(value: string): Set<string> {
  return new Set(
    normalizeSmsComparisonText(value)
      .split(/\s+/)
      .filter((token) => token.length >= 2),
  );
}

function bodiesLookRelated(originalBody: string, inboxBody: string): boolean {
  const original = normalizeSmsComparisonText(originalBody);
  const inbox = normalizeSmsComparisonText(inboxBody);
  if (!original || !inbox) return false;
  if (original === inbox) return originalBody.trim() !== inboxBody.trim();
  if (inbox.includes(original) || original.includes(inbox)) return true;

  const originalTokens = smsComparisonTokens(originalBody);
  const inboxTokens = smsComparisonTokens(inboxBody);
  if (originalTokens.size === 0 || inboxTokens.size === 0) return false;
  let overlap = 0;
  for (const token of originalTokens) if (inboxTokens.has(token)) overlap++;
  return overlap / Math.min(originalTokens.size, inboxTokens.size) >= 0.7;
}

function canonicalInboxCandidateScore(params: {
  message: RawSms;
  originalSenderAddress: string;
  originalBody: string;
  anchor: Date;
  bank: Bank;
  banks: Bank[];
}): number {
  const { message, originalBody, anchor, bank, banks } = params;
  const body = message.body;
  const address = message.address;
  if (body == null || address == null) return -1;
  if (!bodiesLookRelated(originalBody, body)) return -1;

  const sameSender = normalizeSender(address) === normalizeSender(params.originalSenderAddress);
  const sameBank = sameSender || senderAddressMatchesBank(bank, address, banks);
  if (!sameBank) return -1;

  const messageTime = smsDate(message, anchor)!;
  const distanceMs = Math.abs(messageTime.getTime() - anchor.getTime());
  if (distanceMs > CANONICAL_INBOX_LOOKUP_WINDOW_MS) return -1;

  let score = 0;
  if (sameSender) score += 40;
  if (looksLikeTransaction(body)) score += 20;
  if (body.length > originalBody.length) score += 10;
  score += 20 - Math.round((distanceMs / CANONICAL_INBOX_LOOKUP_WINDOW_MS) * 20);
  return score;
}

async function findCanonicalInboxCopy(params: {
  originalBody: string;
  senderAddress: string;
  messageDate: Date | null | undefined;
  bank: Bank;
  banks: Bank[];
}): Promise<RawSms | null> {
  const anchor = params.messageDate ?? new Date();
  // Only the same sender or this bank's senders can score; let the native side drop the rest.
  const sender = normalizeSender(params.senderAddress);
  const senderCodes = sender ? [sender, ...senderCodesFor([params.bank])] : null;
  const messages = await getInbox(
    anchor.getTime() - CANONICAL_INBOX_LOOKUP_WINDOW_MS,
    Date.now() + CANONICAL_INBOX_LOOKUP_FUTURE_SLACK_MS,
    { senderCodes },
  );
  let best: RawSms | null = null;
  let bestScore = -1;
  for (const message of messages) {
    const score = canonicalInboxCandidateScore({
      message,
      originalSenderAddress: params.senderAddress,
      originalBody: params.originalBody,
      anchor,
      bank: params.bank,
      banks: params.banks,
    });
    if (score > bestScore) {
      best = message;
      bestScore = score;
    }
  }
  return best;
}

/** Runs inside the SMS work lock (called from processInternal). */
async function retryCanonicalInboxCopy(params: {
  originalBody: string;
  senderAddress: string;
  messageDate: Date | null | undefined;
  bank: Bank;
  skipDashenExpenseDuplicates: boolean;
  skipAutoCategorization: boolean;
}): Promise<ParseResult | null> {
  if (!hasSmsPermission()) return null;
  const banks = await bankRepository.getBanks();
  for (let attempt = 0; attempt < CANONICAL_INBOX_LOOKUP_ATTEMPTS; attempt++) {
    await delay(CANONICAL_INBOX_LOOKUP_DELAY_MS);
    const inbox = await findCanonicalInboxCopy({
      originalBody: params.originalBody,
      senderAddress: params.senderAddress,
      messageDate: params.messageDate,
      bank: params.bank,
      banks,
    });
    if (!inbox?.body || !inbox.address) continue;

    const result = await processOneLocked(inbox.body, inbox.address, {
      messageDate: smsDate(inbox, params.messageDate ?? null),
      sourceMessageId: inbox.id ?? null,
      sourceSubscriptionId: normalizedSubscriptionId(inbox.subscriptionId),
      notifyUser: false,
      skipDashenExpenseDuplicates: params.skipDashenExpenseDuplicates,
      skipAutoCategorization: params.skipAutoCategorization,
      recordFailure: false,
    });
    if (result.status === 'success' || result.status === 'duplicate') return result;
  }
  return null;
}

// ------------------------------------------------------------------ scan context

interface PendingWrites {
  transactions: Transaction[];
  ownershipUpdates: TransactionOwnershipUpdate[];
  sourceSms: TransactionSourceSms[];
  /** Last balance per account; later messages overwrite earlier ones, like the sequential updates did. */
  balances: Map<string, { accountNumber: string; bank: number; balance: number }>;
}

interface AddedSmsTransaction {
  transaction: Transaction;
  messageDate: Date | null;
}

/**
 * Everything processInternal needs, loaded once per scan (or once per live message): banks,
 * patterns by bank, accounts, and an index over the stored transactions. Writes are buffered
 * and flushed in batches; the in-memory view is updated as rows are added or re-owned, so
 * later messages in the same scan see earlier ones exactly as if they had been re-read.
 */
interface ScanContext {
  banks: Bank[];
  patternsByBank: Map<number, SmsPattern[]>;
  accounts: Account[];
  index: TransactionIndex;
  atmCutoff: Date;
  pending: PendingWrites;
  /** SMS transactions added (not their ATM cash mirrors), in processing order. */
  added: AddedSmsTransaction[];
  addedDebit: boolean;
  categorization: Map<string, Promise<AutoCategorizationSelection | null>>;
}

function emptyPendingWrites(): PendingWrites {
  return { transactions: [], ownershipUpdates: [], sourceSms: [], balances: new Map() };
}

function pendingWriteCount(pending: PendingWrites): number {
  return pending.transactions.length + pending.ownershipUpdates.length + pending.sourceSms.length + pending.balances.size;
}

async function createScanContext(): Promise<ScanContext> {
  // First, since resolving the cutoff the first time may delete stale ATM cash rows.
  const atmCutoff = await getAtmCashTransferCutoff();
  const [banks, patterns, accounts, transactions] = await Promise.all([
    bankRepository.getBanks(),
    smsConfigService.getPatterns({ allowRemoteFetch: false }),
    accountRepository.getAccounts(),
    transactionRepository.getTransactions(),
  ]);
  const patternsByBank = new Map<number, SmsPattern[]>();
  for (const pattern of patterns) {
    const list = patternsByBank.get(pattern.bankId);
    if (list) list.push(pattern);
    else patternsByBank.set(pattern.bankId, [pattern]);
  }
  return {
    banks,
    patternsByBank,
    accounts,
    index: new TransactionIndex(transactions),
    atmCutoff,
    pending: emptyPendingWrites(),
    added: [],
    addedDebit: false,
    categorization: new Map(),
  };
}

/** Writes the buffered rows in one transaction (retried, since every write is idempotent). */
async function flushPendingWrites(ctx: ScanContext): Promise<void> {
  const pending = ctx.pending;
  if (pendingWriteCount(pending) === 0) return;
  ctx.pending = emptyPendingWrites();
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await transactionRepository.saveSmsImportBatch({
        transactions: pending.transactions,
        ownershipUpdates: pending.ownershipUpdates,
        sourceSms: pending.sourceSms,
      });
      lastError = null;
      break;
    } catch (error) {
      // Typically another transaction was open on the shared connection; try again shortly.
      lastError = error;
      await delay(100 * (attempt + 1));
    }
  }
  if (lastError) throw lastError;
  for (const b of pending.balances.values()) {
    await accountRepository.updateBalance(b.accountNumber, b.bank, b.balance);
  }
}

/** Same selection saveTransaction would make, memoized per scan (rules do not change mid-scan). */
async function prepareNewTransaction(
  ctx: ScanContext,
  transaction: Transaction,
  skipAutoCategorization: boolean,
): Promise<Transaction> {
  let tx = makeTransaction({ ...transaction, profileId: transaction.profileId ?? (await profileRepository.getActiveProfileId()) });
  if (skipAutoCategorization || tx.categoryId != null) return tx;
  const key = `${tx.type ?? ''}\u0000${tx.receiver ?? ''}\u0000${tx.creditor ?? ''}`;
  let selection = ctx.categorization.get(key);
  if (!selection) {
    selection = autoCategorization.getCategorySelectionForTransaction({
      type: tx.type,
      receiver: tx.receiver,
      creditor: tx.creditor,
    });
    ctx.categorization.set(key, selection);
  }
  const resolved = await selection;
  if (resolved && resolved.categoryIds.length > 0) {
    tx = makeTransaction({ ...tx, categoryId: resolved.primaryCategoryId, categoryIds: resolved.categoryIds });
  }
  return tx;
}

function queueInsert(ctx: ScanContext, tx: Transaction): void {
  ctx.pending.transactions.push(tx);
  ctx.index.add(tx);
}

function queueOwnershipFromSms(
  ctx: ScanContext,
  reference: string,
  check: SmsOwnershipCheck,
  sourceSubscriptionId: number | null,
  sourceMessageId: string | null | undefined,
): void {
  let update: TransactionOwnershipUpdate | null = null;
  if (check.conflict) {
    // Addressed to someone else's account: drop an automatic owner an older rule gave it.
    update = { reference, ownerAccountNumber: null, ownerAssignmentSource: OwnerAssignment.conflict };
  } else if (check.owner) {
    update = {
      reference,
      ownerAccountNumber: check.owner.account.accountNumber,
      ownerAssignmentSource: OwnerAssignment.automatic,
      sourceSubscriptionId,
      sourceMessageId: sourceMessageId ?? null,
    };
  }
  // Unchanged rows need no write: the index mirrors what the table holds.
  if (update && ctx.index.updateOwnership(reference, update)) ctx.pending.ownershipUpdates.push(update);
}

function queueBalance(ctx: ScanContext, account: Account, balance: number): void {
  const key = `${account.bank}|${account.accountNumber}`;
  ctx.pending.balances.delete(key);
  ctx.pending.balances.set(key, { accountNumber: account.accountNumber, bank: account.bank, balance });
  for (const a of ctx.accounts) {
    if (a.accountNumber === account.accountNumber && a.bank === account.bank) a.balance = balance;
  }
}

/** Keeps the raw text of every parsed bank SMS (success and duplicate paths). */
function captureTransactionSourceSms(
  ctx: ScanContext,
  params: {
    transactionReference: string;
    body: string;
    senderAddress: string;
    receivedAt: Date | null | undefined;
    messageId: string | null | undefined;
  },
): void {
  const reference = params.transactionReference.trim();
  if (!reference || !params.body.trim()) return;
  ctx.pending.sourceSms.push({
    transactionReference: reference,
    body: params.body,
    senderAddress: params.senderAddress.trim(),
    receivedAt: params.receivedAt ? params.receivedAt.toISOString() : null,
    messageId: params.messageId ?? null,
  });
}

// ------------------------------------------------------------------ ATM cash wallet

function isAtmWithdrawal(details: Record<string, unknown>, body: string): boolean {
  const type = String(details.type ?? '').toUpperCase();
  if (type !== 'DEBIT') return false;
  const description = typeof details.patternDescription === 'string' ? details.patternDescription.toLowerCase() : null;
  if (description?.includes('atm')) return true;
  const normalized = body.toLowerCase();
  return normalized.includes('atm') && normalized.includes('withdraw');
}

function currentCashWalletBalance(ctx: ScanContext): number {
  const base = ctx.accounts.filter((a) => a.bank === CASH_BANK_ID).reduce((sum, a) => sum + a.balance, 0);
  return base + ctx.index.cashWalletDelta();
}

async function cleanupHistoricalAtmCashTransactions(cutoff: Date): Promise<void> {
  const transactions = await transactionRepository.getTransactions();
  const stale = transactions
    .filter((tx) => {
      if (tx.bankId !== CASH_BANK_ID || !tx.reference.startsWith(CASH_ATM_REFERENCE_PREFIX)) return false;
      const time = tx.time ? Date.parse(tx.time) : Number.NaN;
      return !Number.isNaN(time) && time < cutoff.getTime();
    })
    .map((tx) => tx.reference);
  if (stale.length === 0) return;
  await transactionRepository.deleteTransactionsByReferences(stale);
  if (__DEV__) console.log(`debug: Removed ${stale.length} historical ATM cash transfer(s) before cutoff`);
}

/**
 * ATM withdrawals only move money into the cash wallet from the moment the
 * profile was created; older withdrawals are history, not cash on hand.
 */
async function getAtmCashTransferCutoff(): Promise<Date> {
  const profileId = await profileRepository.getActiveProfileId();
  const key = PrefKeys.atmCashCutoff(profileId);
  const existing = await prefs.getString(key);
  if (existing) {
    const parsed = new Date(existing);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const profile = (await profileRepository.getActiveProfile()) ?? (await profileRepository.getProfiles())[0] ?? null;
  const created = profile?.createdAt ? new Date(profile.createdAt) : null;
  const cutoff = created && !Number.isNaN(created.getTime()) ? created : new Date();
  await prefs.setString(key, cutoff.toISOString());
  await cleanupHistoricalAtmCashTransactions(cutoff);
  return cutoff;
}

async function createCashTransactionForAtmWithdrawal(ctx: ScanContext, withdrawal: Transaction): Promise<void> {
  const bankId = withdrawal.bankId;
  if (bankId == null || bankId === CASH_BANK_ID) return;

  const withdrawalTime = withdrawal.time ? Date.parse(withdrawal.time) : Number.NaN;
  if (!Number.isNaN(withdrawalTime) && withdrawalTime < ctx.atmCutoff.getTime()) return;

  const cashReference = `${CASH_ATM_REFERENCE_PREFIX}${withdrawal.reference}`;
  if (ctx.index.hasReference(cashReference)) return;

  // getAccounts() guarantees the cash wallet account exists.
  const balance = currentCashWalletBalance(ctx);
  const cashTx = await prepareNewTransaction(
    ctx,
    {
      amount: withdrawal.amount,
      reference: cashReference,
      creditor: 'ATM withdrawal',
      time: withdrawal.time ?? new Date().toISOString(),
      bankId: CASH_BANK_ID,
      type: 'CREDIT',
      currentBalance: (balance + withdrawal.amount).toFixed(2),
      transactionLink: withdrawal.reference,
      accountNumber: CASH_ACCOUNT_NUMBER,
      ownerAccountNumber: CASH_ACCOUNT_NUMBER,
    },
    false,
  );
  queueInsert(ctx, cashTx);
}

// ------------------------------------------------------------------ notifications

async function showTransactionNotificationUnlessSelfTransferNow(transaction: Transaction): Promise<void> {
  try {
    const [transactions, banks, accounts, categories] = await Promise.all([
      transactionRepository.getTransactions(),
      bankRepository.getBanksWithCash(),
      accountRepository.getAccounts(),
      categoryRepository.getCategories(),
    ]);
    const suppressed = transactionsToSuppress({ transaction, transactions, banks, accounts, categories });
    if (suppressed.length > 0) {
      const dismissed = new Set<string>();
      for (const tx of suppressed) {
        if (dismissed.has(tx.reference)) continue;
        dismissed.add(tx.reference);
        await notificationService.dismissTransactionNotification(tx, { removeFromHistory: true });
      }
      if (__DEV__) console.log('debug: Transaction notification skipped — self transfer detected');
      return;
    }
  } catch (error) {
    if (__DEV__) console.warn('debug: Could not check self-transfer notification', error);
  }
  await notificationService.showTransactionNotification(transaction);
}

/**
 * Shows the transaction notification unless this reference was already notified (by the
 * live listener, the headless task or a catch-up scan). Notifications run one at a time,
 * so the check-and-mark cannot race.
 */
function notifyTransactionOnce(transaction: Transaction): Promise<void> {
  const turn = notificationTurn.then(async () => {
    const reference = transaction.reference.trim();
    if (!reference) return;
    if ((await notificationService.getNotifiedTransactionReferences()).has(reference)) return;
    await notificationService.markTransactionsNotified([reference]);
    await showTransactionNotificationUnlessSelfTransferNow(transaction);
  });
  notificationTurn = turn.catch(() => undefined);
  return turn;
}

function isRecent(time: Date | string | null | undefined, now = Date.now()): boolean {
  if (time == null) return false;
  const ms = typeof time === 'string' ? Date.parse(time) : time.getTime();
  return Number.isFinite(ms) && ms >= now - RECENT_NOTIFICATION_WINDOW_MS && ms <= now + RECENT_NOTIFICATION_WINDOW_MS;
}

/**
 * After a catch-up scan: notifies for recent transactions it added that nobody notified yet
 * (the live receiver missed them, e.g. the app was killed). Capped, with one summary for the rest.
 */
async function notifyNewTransactionsFromScan(added: AddedSmsTransaction[]): Promise<void> {
  try {
    const now = Date.now();
    const recent = added
      .filter((a) => isRecent(a.messageDate ?? a.transaction.time ?? null, now))
      .map((a) => a.transaction)
      .reverse(); // newest first
    if (recent.length === 0) return;
    const notified = await notificationService.getNotifiedTransactionReferences();
    const fresh = recent.filter((tx) => !notified.has(tx.reference.trim()));
    for (const tx of fresh.slice(0, MAX_INDIVIDUAL_CATCHUP_NOTIFICATIONS)) await notifyTransactionOnce(tx);
    const rest = fresh.slice(MAX_INDIVIDUAL_CATCHUP_NOTIFICATIONS);
    if (rest.length > 0) {
      await notificationService.markTransactionsNotified(rest.map((tx) => tx.reference));
      await notificationService.showNewTransactionsSummary({ count: rest.length });
    }
  } catch (error) {
    if (__DEV__) console.warn('debug: Could not notify new transactions from scan', error);
  }
}

async function checkBudgetAlertsAfterImport(ctx: ScanContext): Promise<void> {
  if (!ctx.addedDebit) return;
  try {
    const { checkAndNotifyBudgetAlerts } = await import('./budgetAlert');
    await checkAndNotifyBudgetAlerts();
  } catch (error) {
    if (__DEV__) console.warn('debug: Error checking budget alerts after SMS transaction', error);
  }
}

// ------------------------------------------------------------------ core parsing

async function processInternal(
  body: string,
  sender: string,
  options: ProcessOptions,
  ctx: ScanContext,
): Promise<ParseResult> {
  const notifyUser = options.notifyUser ?? false;
  const skipDashen = options.skipDashenExpenseDuplicates ?? true;
  const skipAutoCategorization = options.skipAutoCategorization ?? false;
  const recordFailure = options.recordFailure ?? true;
  const messageDate = options.messageDate ?? null;
  const subscriptionId = normalizedSubscriptionId(options.sourceSubscriptionId);

  const bank = sender ? findBankForSender(sender, ctx.banks) : null;
  if (!bank) return { status: 'noBank', reason: 'No matching bank' };

  if (isTelebirrAtmAuthorization(bank.id, body)) {
    return { status: 'duplicate', reason: 'Ignored Telebirr ATM authorization notice' };
  }
  if (isTelebirrAirtimeReceipt(bank.id, body)) {
    return { status: 'duplicate', reason: 'Ignored Telebirr airtime receipt acknowledgement' };
  }

  // Messages from banks without a registered account are still saved. Their parsed account
  // numbers show up as unlabeled accounts the user can name later, without reparsing.
  const registeredAccounts = ctx.accounts;

  // 1-2. Parse with this bank's patterns.
  const parsed = parsePatternMessage({
    message: smsConfigService.cleanSmsText(body),
    patterns: ctx.patternsByBank.get(bank.id) ?? [],
    bank,
    bankId: bank.id,
    messageDate,
  });

  if (!parsed) {
    if (notifyUser && recordFailure) {
      try {
        // The caller notifies for a canonical success.
        const canonical = await retryCanonicalInboxCopy({
          originalBody: body,
          senderAddress: sender,
          messageDate,
          bank,
          skipDashenExpenseDuplicates: skipDashen,
          skipAutoCategorization,
        });
        if (canonical) return canonical;
      } catch (error) {
        if (__DEV__) console.warn('debug: Canonical inbox retry failed', error);
      }
    }
    if (recordFailure && looksLikeTransaction(body)) {
      if (notifyUser) {
        if (await notificationSettings.isFailedParseReviewNotificationsEnabled()) {
          const reviewId = await failedParseReviewService.storeCandidate({
            bank,
            address: sender,
            body,
            messageDate: messageDate ?? new Date(),
          });
          const shown = await notificationService.showFailedParseReviewNotification({
            reviewId,
            bankName: bank.shortName,
            messageBody: body,
          });
          if (!shown) {
            await failedParseReviewService.discardCandidate(reviewId);
            await recordFailedParse({
              address: sender,
              body,
              reason: NO_MATCHING_PATTERN_REASON,
              timestamp: messageDate,
              bankId: bank.id,
            });
          }
        }
      } else {
        await recordFailedParse({
          address: sender,
          body,
          reason: NO_MATCHING_PATTERN_REASON,
          timestamp: messageDate,
          bankId: bank.id,
        });
      }
    }
    return { status: 'noPattern', reason: NO_MATCHING_PATTERN_REASON };
  }

  // The message timestamp is more accurate than any time parsed from the body.
  const details: Record<string, unknown> = { ...parsed };
  if (messageDate) details.time = messageDate.toISOString();

  const parsedBankId = parsed.bankId ?? bank.id;
  const ownershipBank = parsedBankId === bank.id ? bank : bankById(ctx.banks, parsedBankId);
  let ownership: SmsOwnershipCheck = { owner: null, conflict: false };
  if (ownershipBank) {
    const bankAccounts: Account[] = registeredAccounts.filter((a) => a.bank === parsedBankId);
    ownership = checkSmsOwnership({
      body,
      bank: ownershipBank,
      accounts: bankAccounts,
      parsedAccountNumber: parsed.accountNumber,
      subscriptionId,
    });
    // Addressed to someone else's account: kept unowned so no fallback hands it to one of yours.
    if (ownership.conflict) details.ownerAssignmentSource = OwnerAssignment.conflict;
    const owner = ownership.owner;
    if (owner) {
      details.ownerAccountNumber = owner.account.accountNumber;
      details.ownerAssignmentSource = OwnerAssignment.automatic;
      if (subscriptionId != null) {
        details.sourceSubscriptionId = subscriptionId;
        // Learn a SIM binding only from explicit owner context; parsed wallet
        // numbers can describe the transfer counterparty.
        if (owner.matchedByGreeting) {
          const accountNumber = owner.account.accountNumber;
          if (await accountRepository.bindSmsSubscription(accountNumber, parsedBankId, subscriptionId)) {
            // Later messages in this scan must see the binding, as a re-read would.
            for (const a of ctx.accounts) {
              if (a.accountNumber === accountNumber && a.bank === parsedBankId) a.smsSubscriptionId = subscriptionId;
            }
          }
        }
      }
    }
  }
  const owner: SmsOwnership | null = ownership.owner;

  const source = buildSmsSource({
    bankId: parsedBankId,
    sender,
    body,
    messageId: options.sourceMessageId ?? null,
    subscriptionId,
  });
  Object.assign(details, sourceToJson(source));
  details.reference = scopeReference({
    bankId: parsedBankId,
    reference: parsed.reference,
    type: parsed.type,
    source,
  });

  // 3. Duplicates.
  const capture = (reference: string) =>
    captureTransactionSourceSms(ctx, {
      transactionReference: reference,
      body,
      senderAddress: sender,
      receivedAt: messageDate,
      messageId: options.sourceMessageId,
    });

  const sourceDuplicate = ctx.index.findSmsSourceDuplicate(details);
  if (sourceDuplicate) {
    queueOwnershipFromSms(ctx, sourceDuplicate.reference, ownership, subscriptionId, options.sourceMessageId);
    capture(sourceDuplicate.reference);
    return { status: 'duplicate', reason: 'Duplicate SMS source', existing: sourceDuplicate };
  }

  const newRef = typeof details.reference === 'string' ? details.reference : null;
  const referenceMatch = newRef ? ctx.index.getByReference(newRef) : null;
  if (newRef && referenceMatch) {
    // A shared bank reference is not ownership evidence. Telebirr legs are
    // scoped above; any remaining collision is the same logical row.
    queueOwnershipFromSms(ctx, newRef, ownership, subscriptionId, options.sourceMessageId);
    capture(newRef);
    if (isAtmWithdrawal(details, body)) {
      try {
        await createCashTransactionForAtmWithdrawal(ctx, referenceMatch);
      } catch (error) {
        if (__DEV__) console.warn('debug: Error reconciling cash transfer', error);
      }
    }
    const reason = `Duplicate transaction ${newRef}`;
    if (recordFailure) {
      await recordFailedParse({ address: sender, body, reason, timestamp: messageDate, bankId: parsedBankId });
    }
    return { status: 'duplicate', reason, existing: referenceMatch };
  }

  if (
    skipDashen &&
    details.bankId === DASHEN_BANK_ID &&
    typeof details.amount === 'number' &&
    ctx.index.hasExactAmountAndBalanceDuplicate(transactionFromJson(details))
  ) {
    const reason = 'Duplicate Dashen transaction by amount and balance';
    if (recordFailure) {
      await recordFailedParse({ address: sender, body, reason, timestamp: messageDate, bankId: parsedBankId });
    }
    return { status: 'duplicate', reason };
  }

  // 4. Balance, unless the account already has a newer message (scanning an older date range).
  if (owner && parsed.currentBalance != null) {
    const ownerAccount = owner.account;
    const at = messageDate?.getTime() ?? Date.now();
    const bankAccounts = registeredAccounts.filter((a) => a.bank === ownerAccount.bank);
    if (!ctx.index.hasNewerBalance({ account: ownerAccount, at, bank: ownershipBank, bankAccounts })) {
      queueBalance(ctx, ownerAccount, sanitizeAmount(parsed.currentBalance));
    }
  }

  // 5. Save.
  const saved = await prepareNewTransaction(ctx, transactionFromJson(details), skipAutoCategorization);
  queueInsert(ctx, saved);
  capture(saved.reference);

  if (isAtmWithdrawal(details, body)) {
    try {
      await createCashTransactionForAtmWithdrawal(ctx, saved);
    } catch (error) {
      if (__DEV__) console.warn('debug: Error creating cash transfer', error);
    }
  }

  ctx.added.push({ transaction: saved, messageDate });
  if (saved.type === 'DEBIT') ctx.addedDebit = true;
  return { status: 'success', transaction: saved };
}

/**
 * Parses and stores one message with a fresh context, then writes it. Must run inside the
 * SMS work lock. Does not notify; callers decide.
 */
async function processOneLocked(body: string, sender: string, options: ProcessOptions): Promise<ParseResult> {
  const ctx = await createScanContext();
  const result = await processInternal(body, sender, options, ctx);
  await flushPendingWrites(ctx);
  await checkBudgetAlertsAfterImport(ctx);
  if (ctx.added.length > 0) dataChanged.notify();
  return result;
}

async function processMessageLocked(
  body: string,
  sender: string,
  options: Omit<ProcessOptions, 'recordFailure'>,
): Promise<Transaction | null> {
  let effectiveBody = body;
  let effectiveSender = sender;
  let effectiveDate = options.messageDate ?? null;
  let effectiveMessageId = options.sourceMessageId ?? null;
  let effectiveSubscriptionId = normalizedSubscriptionId(options.sourceSubscriptionId);

  // SIM-based wallets need the inbox row's subscription id to resolve the owner.
  if ((effectiveMessageId == null || effectiveSubscriptionId == null) && hasSmsPermission()) {
    try {
      const bank = await getRelevantBank(sender);
      if (bank?.simBased) {
        const banks = await bankRepository.getBanks();
        for (let attempt = 0; attempt < CANONICAL_INBOX_LOOKUP_ATTEMPTS; attempt++) {
          if (attempt > 0) await delay(CANONICAL_INBOX_LOOKUP_DELAY_MS);
          const inbox = await findCanonicalInboxCopy({
            originalBody: body,
            senderAddress: sender,
            messageDate: options.messageDate,
            bank,
            banks,
          });
          if (!inbox?.body || !inbox.address) continue;
          effectiveBody = inbox.body;
          effectiveSender = inbox.address;
          effectiveDate = smsDate(inbox, options.messageDate ?? null);
          effectiveMessageId = inbox.id ?? null;
          effectiveSubscriptionId = normalizedSubscriptionId(inbox.subscriptionId);
          break;
        }
      }
    } catch (error) {
      if (__DEV__) console.warn('debug: Could not enrich incoming SMS ownership', error);
    }
  }

  const result = await processOneLocked(effectiveBody, effectiveSender, {
    ...options,
    messageDate: effectiveDate,
    sourceMessageId: effectiveMessageId,
    sourceSubscriptionId: effectiveSubscriptionId,
    recordFailure: true,
  });

  if (options.notifyUser) {
    if (result.status === 'success' && result.transaction) {
      await notifyTransactionOnce(result.transaction);
    } else if (result.status === 'duplicate' && result.existing && isRecent(result.existing.time)) {
      // A scan (startup catch-up, pull-to-refresh, manual scan) may have imported this
      // message silently just before the listener got its turn; notify once anyway.
      await notifyTransactionOnce(result.existing);
    }
  }
  return result.transaction ?? null;
}

function processMessage(
  body: string,
  sender: string,
  options: Omit<ProcessOptions, 'recordFailure'> = {},
): Promise<Transaction | null> {
  return exclusive(() => processMessageLocked(body, sender, options));
}

function retryFailedParse(
  body: string,
  sender: string,
  options: Omit<ProcessOptions, 'recordFailure' | 'notifyUser'> = {},
): Promise<ParseResult> {
  return exclusive(() => processOneLocked(body, sender, { ...options, notifyUser: false, recordFailure: false }));
}

// ------------------------------------------------------------------ inbox sync

interface BatchOptions {
  /** Called every `tickEvery` messages and after the last one. */
  onTick?: (processed: number, total: number) => void;
  tickEvery?: number;
}

/**
 * Parses messages oldest first against one scan context: O(1) duplicate lookups, writes
 * flushed in batched transactions, and a UI turn every few dozen messages. Must run inside
 * the SMS work lock.
 */
async function processBatchLocked(
  messages: RawSms[],
  options: BatchOptions = {},
): Promise<{ result: TodaySmsSyncResult; ctx: ScanContext }> {
  const result = { ...EMPTY_SYNC_RESULT };
  const chronological = sortChronological(messages);
  const ctx = await createScanContext();
  const tickEvery = options.tickEvery ?? 0;

  const flush = async () => {
    try {
      await flushPendingWrites(ctx);
    } catch (error) {
      // Counted as an error so scan cursors do not move past messages that were not saved.
      result.errors++;
      if (__DEV__) console.warn('debug: Could not save imported SMS batch', error);
    }
  };

  for (let i = 0; i < chronological.length; i++) {
    if (i > 0 && i % YIELD_EVERY_MESSAGES === 0) await yieldToUi();
    const message = chronological[i];
    const { body, address } = message;
    if (body == null || address == null || !findBankForSender(address, ctx.banks)) {
      result.skipped++;
    } else {
      result.processed++;
      try {
        const parsed = await processInternal(
          body,
          address,
          {
            messageDate: smsDate(message),
            sourceMessageId: message.id ?? null,
            sourceSubscriptionId: message.subscriptionId ?? null,
            notifyUser: false,
            recordFailure: false,
          },
          ctx,
        );
        switch (parsed.status) {
          case 'success':
            result.added++;
            break;
          case 'duplicate':
            result.duplicates++;
            break;
          case 'noPattern':
            result.noPattern++;
            break;
          default:
            result.skipped++;
        }
      } catch (error) {
        result.errors++;
        if (__DEV__) console.warn('debug: Error processing SMS', error);
      }
      if (pendingWriteCount(ctx.pending) >= FLUSH_EVERY_WRITES) await flush();
    }
    if (tickEvery > 0 && ((i + 1) % tickEvery === 0 || i + 1 === chronological.length)) {
      options.onTick?.(i + 1, chronological.length);
    }
  }
  await flush();
  await checkBudgetAlertsAfterImport(ctx);
  return { result, ctx };
}

async function processInboxMessages(
  messages: RawSms[],
  options: { notifyNewTransactions?: boolean } = {},
): Promise<TodaySmsSyncResult> {
  return exclusive(async () => {
    const { result, ctx } = await processBatchLocked(messages);
    if (options.notifyNewTransactions) await notifyNewTransactionsFromScan(ctx.added);
    return result;
  });
}

async function syncBankSmsRange(params: {
  start: Date;
  includeStart: boolean;
  end: Date;
  notifyNewTransactions?: boolean;
}): Promise<TodaySmsSyncResult> {
  const since = params.start.getTime() + (params.includeStart ? 0 : 1);
  const banks = await bankRepository.getBanks();
  const messages = await getInbox(since, params.end.getTime(), { senderCodes: senderCodesFor(banks) });
  return processInboxMessages(messages, { notifyNewTransactions: params.notifyNewTransactions });
}

async function getLastSmsCatchupAt(): Promise<Date | null> {
  const raw = await prefs.getNumber(PrefKeys.smsCatchupCursor(await profileRepository.getActiveProfileId()));
  return raw === null ? null : new Date(raw);
}

async function setLastSmsCatchupAt(time: Date): Promise<void> {
  await prefs.setNumber(PrefKeys.smsCatchupCursor(await profileRepository.getActiveProfileId()), time.getTime());
}

/** Imports every bank SMS received since midnight. */
async function syncTodayBankSms(): Promise<TodaySmsSyncResult> {
  if (!hasSmsPermission()) return { ...EMPTY_SYNC_RESULT, permissionDenied: true };
  await getAtmCashTransferCutoff();
  const scanEndedAt = new Date();
  const scanStart = startOfDay(scanEndedAt);
  const result = await syncBankSmsRange({ start: scanStart, includeStart: true, end: scanEndedAt });
  if (result.errors === 0) {
    await setLastSmsCatchupAt(scanEndedAt);
    await extendLastScanAt(scanStart, scanEndedAt);
  }
  if (result.added > 0) dataChanged.notify();
  return result;
}

/**
 * Imports bank SMS that arrived while the app was not listening (since the last catch-up today).
 * Runs at startup and from the periodic background task. Recent transactions it finds were
 * missed by the live receiver, so they are notified (once) unless this is the very first run.
 */
async function syncMissedBankSmsSinceLastCatchup(): Promise<TodaySmsSyncResult> {
  if (Platform.OS !== 'android') return { ...EMPTY_SYNC_RESULT };
  if (!hasSmsPermission()) return { ...EMPTY_SYNC_RESULT, permissionDenied: true };
  await getAtmCashTransferCutoff();

  const scanEndedAt = new Date();
  const dayStart = startOfDay(scanEndedAt);
  const lastCatchupAt = await getLastSmsCatchupAt();
  const hasCursor =
    lastCatchupAt !== null &&
    lastCatchupAt.getTime() > dayStart.getTime() &&
    lastCatchupAt.getTime() <= scanEndedAt.getTime();

  const scanStart = hasCursor ? lastCatchupAt : dayStart;
  const result = await syncBankSmsRange({
    start: scanStart,
    includeStart: !hasCursor,
    end: scanEndedAt,
    // No cursor at all means the first launch: today's messages are history, not news.
    notifyNewTransactions: lastCatchupAt !== null,
  });
  if (result.errors === 0) {
    await setLastSmsCatchupAt(scanEndedAt);
    await extendLastScanAt(scanStart, scanEndedAt);
  }
  if (result.added > 0) dataChanged.notify();
  return result;
}

async function reconcileAccountsBestEffort(): Promise<void> {
  try {
    const { reconcileAccounts } = await import('./accountLabeling');
    await reconcileAccounts();
  } catch (error) {
    if (__DEV__) console.warn('debug: Could not reconcile account owners', error);
  }
}

/**
 * Imports the whole SMS history of one bank, used right after an account is
 * registered (Flutter AccountRegistrationService._syncPreviousSms).
 */
async function syncBankHistory(params: {
  bankId: number;
  accountNumber: string;
  onProgress?: (processed: number, total: number) => void;
}): Promise<TodaySmsSyncResult> {
  if (Platform.OS !== 'android') return { ...EMPTY_SYNC_RESULT };
  if (!hasSmsPermission()) return { ...EMPTY_SYNC_RESULT, permissionDenied: true };
  const banks = await bankRepository.getBanks();
  const bank = bankById(banks, params.bankId);
  if (!bank) return { ...EMPTY_SYNC_RESULT };
  await getAtmCashTransferCutoff();

  const inbox = await getInbox(0, Date.now(), { senderCodes: senderCodesFor([bank]) });
  const seen = new Set<string>();
  const messages = inbox.filter((m) => {
    if (!m.address || !m.body || !senderAddressMatchesBank(bank, m.address, banks)) return false;
    const key = m.id ? `id:${m.id}` : `${m.date}_${m.address}_${m.body}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const notify = (processed: number) =>
    notificationService
      .showAccountSyncProgress({
        bankId: bank.id,
        accountNumber: params.accountNumber,
        bankName: bank.shortName,
        processed,
        total: messages.length,
      })
      .catch(() => undefined);

  const result = await exclusive(async () => {
    const batch = await processBatchLocked(messages, {
      tickEvery: 10,
      onTick: (processed, total) => {
        params.onProgress?.(processed, total);
        void notify(processed);
      },
    });
    await reconcileAccountsBestEffort();
    return batch.result;
  });

  await notificationService
    .showAccountSyncComplete({
      bankId: bank.id,
      accountNumber: params.accountNumber,
      bankName: bank.shortName,
      added: result.added,
    })
    .catch(() => undefined);
  dataChanged.notify();
  return result;
}

/** Whether the one-time import of every bank's SMS history has run for the active profile. */
async function hasImportedAllBankHistory(): Promise<boolean> {
  return prefs.getBool(PrefKeys.allBankHistoryImported(await profileRepository.getActiveProfileId()));
}

type ScanProgress = (processed: number, total: number) => void;

/** Every supported bank message received in [sinceMs, untilMs], without duplicates. */
async function bankInbox(sinceMs: number, untilMs: number): Promise<RawSms[]> {
  const banks = await bankRepository.getBanks();
  // The native side drops other senders; the exact best-bank check stays here.
  const inbox = await getInbox(sinceMs, untilMs, { senderCodes: senderCodesFor(banks) });
  const seen = new Set<string>();
  return inbox.filter((m) => {
    if (!m.address || !m.body || !findBankForSender(m.address, banks)) return false;
    const key = m.id ? `id:${m.id}` : `${m.date}_${m.address}_${m.body}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Parses bank messages oldest first with progress, then re-checks account owners and balances. */
async function runBankScan(
  messages: RawSms[],
  onProgress?: ScanProgress,
  options: { notifyNewTransactions?: boolean } = {},
): Promise<TodaySmsSyncResult> {
  await getAtmCashTransferCutoff();
  const progressNotice = { bankId: 0, accountNumber: 'all', bankName: 'bank messages' };
  const total = messages.length;
  onProgress?.(0, total);
  const result = await exclusive(async () => {
    const batch = await processBatchLocked(messages, {
      tickEvery: 25,
      onTick: (processed, count) => {
        onProgress?.(processed, count);
        if (count > 50) {
          void notificationService
            .showAccountSyncProgress({ ...progressNotice, processed, total: count })
            .catch(() => undefined);
        }
      },
    });
    await reconcileAccountsBestEffort();
    // After reconciling, so self-transfer detection sees the final owners.
    if (options.notifyNewTransactions) await notifyNewTransactionsFromScan(batch.ctx.added);
    return batch.result;
  });
  if (total > 50) {
    await notificationService.showAccountSyncComplete({ ...progressNotice, added: result.added }).catch(() => undefined);
  }
  dataChanged.notify();
  return result;
}

async function getStoredLastScanAt(): Promise<Date | null> {
  const raw = await prefs.getNumber(PrefKeys.smsLastScanAt(await profileRepository.getActiveProfileId()));
  return raw === null ? null : new Date(raw);
}

async function setLastFullScanAt(time: Date): Promise<void> {
  await prefs.setNumber(PrefKeys.smsLastScanAt(await profileRepository.getActiveProfileId()), time.getTime());
}

/** Moves the last-scan time forward only when [scanStart, scanEnd] continues from it without a gap. */
async function extendLastScanAt(scanStart: Date, scanEnd: Date): Promise<void> {
  const last = await getStoredLastScanAt();
  if (last && last.getTime() >= scanStart.getTime() && last.getTime() < scanEnd.getTime()) await setLastFullScanAt(scanEnd);
}

/**
 * When the inbox was last read without gaps up to: the last scan, or for imports made before
 * this was tracked, the newest bank message already imported. Null when nothing was scanned yet.
 */
async function getLastScanAt(): Promise<Date | null> {
  const stored = await getStoredLastScanAt();
  if (stored && stored.getTime() <= Date.now()) return stored;
  if (!(await hasImportedAllBankHistory())) return null;
  let newest: number | null = null;
  for (const tx of await transactionRepository.getTransactions()) {
    if (tx.sourceType !== SMS_SOURCE_TYPE || !tx.time) continue;
    const time = new Date(tx.time).getTime();
    if (Number.isFinite(time) && (newest === null || time > newest)) newest = time;
  }
  return newest === null ? null : new Date(newest);
}

/**
 * Parses the whole inbox once for every supported bank, whether or not an account is
 * registered for it. Accounts found in the messages show up as unlabeled accounts, so
 * labeling one later doesn't need another pass over the inbox. Never notifies per transaction.
 */
async function syncAllBankHistory(params: { onProgress?: ScanProgress } = {}): Promise<TodaySmsSyncResult> {
  if (Platform.OS !== 'android') return { ...EMPTY_SYNC_RESULT };
  if (!hasSmsPermission()) return { ...EMPTY_SYNC_RESULT, permissionDenied: true };
  const scanEndedAt = new Date();
  const result = await runBankScan(await bankInbox(0, scanEndedAt.getTime()), params.onProgress);
  if (result.errors === 0) {
    await prefs.setBool(PrefKeys.allBankHistoryImported(await profileRepository.getActiveProfileId()), true);
    await setLastFullScanAt(scanEndedAt);
  }
  return result;
}

/**
 * Reads only the bank messages received since the last scan (a few minutes of overlap catch
 * messages that arrived while that scan ran; duplicates are skipped). Without an earlier scan
 * this is the full import. New recent transactions are notified once, like a catch-up.
 */
async function syncBankSmsSinceLastScan(params: { onProgress?: ScanProgress } = {}): Promise<TodaySmsSyncResult & { since: Date | null }> {
  if (Platform.OS !== 'android') return { ...EMPTY_SYNC_RESULT, since: null };
  if (!hasSmsPermission()) return { ...EMPTY_SYNC_RESULT, permissionDenied: true, since: null };
  const since = await getLastScanAt();
  if (!since) return { ...(await syncAllBankHistory(params)), since: null };
  const scanEndedAt = new Date();
  const from = Math.max(0, since.getTime() - SCAN_OVERLAP_MS);
  const result = await runBankScan(await bankInbox(from, scanEndedAt.getTime()), params.onProgress, {
    notifyNewTransactions: true,
  });
  if (result.errors === 0) {
    await setLastFullScanAt(scanEndedAt);
    await setLastSmsCatchupAt(scanEndedAt);
  }
  return { ...result, since };
}

/** Reads the bank messages received between two dates (inclusive). The last-scan time is unchanged. */
async function syncBankSmsBetween(params: { start: Date; end: Date; onProgress?: ScanProgress }): Promise<TodaySmsSyncResult> {
  if (Platform.OS !== 'android') return { ...EMPTY_SYNC_RESULT };
  if (!hasSmsPermission()) return { ...EMPTY_SYNC_RESULT, permissionDenied: true };
  const end = Math.min(params.end.getTime(), Date.now());
  return runBankScan(await bankInbox(params.start.getTime(), end), params.onProgress);
}

// ------------------------------------------------------------------ incoming SMS

async function handleIncomingSms(sms: RawSms): Promise<Transaction | null> {
  const { body, address } = sms;
  if (!body || !address) return null;
  if (!(await isRelevantMessage(address))) return null;
  return processMessage(body, address, {
    notifyUser: true,
    messageDate: smsDate(sms),
    sourceMessageId: sms.id ?? null,
    sourceSubscriptionId: sms.subscriptionId ?? null,
  });
}

/**
 * The headless SMS task and the periodic background task can run in a JS runtime where App
 * never booted: open the database and set up notification channels/handler first.
 * Patterns need nothing: getPatterns falls back to the stored or bundled set without network.
 */
export async function prepareBackgroundRuntime(): Promise<void> {
  await getDb();
  try {
    await notificationService.initialize();
  } catch (error) {
    if (__DEV__) console.warn('debug: Notification setup in background runtime failed', error);
  }
}

let listenerSubscription: { remove(): void } | null = null;

/** Listens for SMS while the JS runtime is alive (foreground or backgrounded app). */
export function startSmsListener(onSaved?: (tx: Transaction) => void): () => void {
  listenerSubscription?.remove();
  const subscription = addSmsListener((sms) => {
    void handleIncomingSms(sms)
      .then((tx) => {
        if (tx && onSaved) onSaved(tx);
      })
      .catch((error) => {
        if (__DEV__) console.warn('debug: Error processing incoming SMS', error);
      });
  });
  listenerSubscription = subscription;
  return () => {
    subscription.remove();
    if (listenerSubscription === subscription) listenerSubscription = null;
  };
}

/**
 * The native SMS receiver starts this headless task when a message arrives while no JS
 * listener is registered (app killed, or the runtime is still booting).
 */
export function registerSmsHeadlessTask(): void {
  if (Platform.OS !== 'android') return;
  AppRegistry.registerHeadlessTask(SMS_HEADLESS_TASK, () => async (data: RawSms) => {
    try {
      await prepareBackgroundRuntime();
      await handleIncomingSms(data);
    } catch (error) {
      if (__DEV__) console.warn('debug: Headless SMS processing failed', error);
    }
  });
}

export const smsService = {
  syncTodayBankSms,
  syncMissedBankSmsSinceLastCatchup,
  syncBankHistory,
  syncAllBankHistory,
  syncBankSmsSinceLastScan,
  syncBankSmsBetween,
  getLastScanAt,
  hasImportedAllBankHistory,
  processMessage,
  retryFailedParse,
  getRelevantBank,
  isRelevantMessage,
  sanitizeAmount,
  getAtmCashTransferCutoff,
};
