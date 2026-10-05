import { AppRegistry, Platform } from 'react-native';
import {
  addSmsListener,
  getInbox,
  hasSmsPermission,
  SMS_HEADLESS_TASK,
  type RawSms,
} from '../../modules/sms-reader';
import type { Account } from '../models/account';
import type { Bank } from '../models/bank';
import { OwnerAssignment, transactionFromJson, type Transaction } from '../models/transaction';
import { accountRepository } from '../repositories/accountRepository';
import { bankById, bankRepository } from '../repositories/bankRepository';
import { categoryRepository } from '../repositories/categoryRepository';
import { failedParseRepository } from '../repositories/failedParseRepository';
import { profileRepository } from '../repositories/profileRepository';
import { sourceSmsRepository } from '../repositories/sourceSmsRepository';
import { transactionRepository } from '../repositories/transactionRepository';
import { checkSmsOwnership, transactionBelongsToAccount, type SmsOwnership, type SmsOwnershipCheck } from '../utils/accountIdentity';
import { findBankForSender, normalizeSender, senderAddressMatchesBank } from '../utils/bankSenderMatcher';
import { CASH_ACCOUNT_NUMBER, CASH_ATM_REFERENCE_PREFIX, CASH_BANK_ID } from '../utils/cashConstants';
import { hasExactAmountAndBalanceDuplicate } from '../utils/duplicateDetector';
import { parsePatternMessage } from '../utils/patternParser';
import { transactionsToSuppress } from '../utils/selfTransfer';
import {
  isTelebirrAirtimeReceipt,
  isTelebirrAtmAuthorization,
  looksLikeTransaction,
} from '../utils/smsMessageClassifier';
import { buildSmsSource, scopeReference, SMS_SOURCE_TYPE, sourceToJson } from '../utils/smsTransactionSource';
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

/** Notifications are shown one at a time so self-transfer pairs can withdraw each other. */
let notificationTurn: Promise<void> = Promise.resolve();

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
  const messages = await getInbox(
    anchor.getTime() - CANONICAL_INBOX_LOOKUP_WINDOW_MS,
    Date.now() + CANONICAL_INBOX_LOOKUP_FUTURE_SLACK_MS,
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

    const result = await processInternal(inbox.body, inbox.address, {
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

// ------------------------------------------------------------------ ATM cash wallet

function isAtmWithdrawal(details: Record<string, unknown>, body: string): boolean {
  const type = String(details.type ?? '').toUpperCase();
  if (type !== 'DEBIT') return false;
  const description = typeof details.patternDescription === 'string' ? details.patternDescription.toLowerCase() : null;
  if (description?.includes('atm')) return true;
  const normalized = body.toLowerCase();
  return normalized.includes('atm') && normalized.includes('withdraw');
}

async function currentCashWalletBalance(existing: Transaction[]): Promise<number> {
  const accounts = await accountRepository.getAccounts();
  const base = accounts.filter((a) => a.bank === CASH_BANK_ID).reduce((sum, a) => sum + a.balance, 0);
  const delta = existing
    .filter((t) => t.bankId === CASH_BANK_ID)
    .reduce((sum, t) => (t.type === 'DEBIT' ? sum - t.amount : t.type === 'CREDIT' ? sum + t.amount : sum), 0);
  return base + delta;
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

async function createCashTransactionForAtmWithdrawal(withdrawal: Transaction, existing: Transaction[]): Promise<void> {
  const bankId = withdrawal.bankId;
  if (bankId == null || bankId === CASH_BANK_ID) return;

  const withdrawalTime = withdrawal.time ? Date.parse(withdrawal.time) : Number.NaN;
  if (!Number.isNaN(withdrawalTime) && withdrawalTime < (await getAtmCashTransferCutoff()).getTime()) {
    return;
  }

  const cashReference = `${CASH_ATM_REFERENCE_PREFIX}${withdrawal.reference}`;
  if (existing.some((t) => t.reference === cashReference)) return;

  // getAccounts() guarantees the cash wallet account exists.
  const balance = await currentCashWalletBalance(existing);
  await transactionRepository.saveTransaction({
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
  });
}

// ------------------------------------------------------------------ duplicates and provenance

function findSmsSourceDuplicate(details: Record<string, unknown>, existing: Transaction[]): Transaction | null {
  const sourceType = typeof details.sourceType === 'string' ? details.sourceType.trim() : null;
  if (sourceType !== SMS_SOURCE_TYPE) return null;

  const messageId = details.sourceMessageId != null ? String(details.sourceMessageId).trim() : '';
  const fingerprint = details.sourceFingerprint != null ? String(details.sourceFingerprint).trim() : '';
  if (!messageId && !fingerprint) return null;

  for (const tx of existing) {
    if (tx.sourceType !== SMS_SOURCE_TYPE) continue;
    if (fingerprint && tx.sourceFingerprint === fingerprint) return tx;
    if (!messageId || tx.sourceMessageId !== messageId) continue;
    const existingFingerprint = tx.sourceFingerprint?.trim();
    if (!fingerprint || !existingFingerprint || existingFingerprint === fingerprint) return tx;
  }
  return null;
}

function isDashenExactDuplicate(details: Record<string, unknown>, existing: Transaction[]): boolean {
  if (details.bankId !== DASHEN_BANK_ID || typeof details.amount !== 'number') return false;
  return hasExactAmountAndBalanceDuplicate(transactionFromJson(details), existing);
}

async function captureTransactionSourceSms(params: {
  transactionReference: string;
  body: string;
  senderAddress: string;
  receivedAt: Date | null | undefined;
  messageId: string | null | undefined;
}): Promise<void> {
  const reference = params.transactionReference.trim();
  if (!reference || !params.body.trim()) return;
  try {
    await sourceSmsRepository.upsert({
      transactionReference: reference,
      body: params.body,
      senderAddress: params.senderAddress.trim(),
      receivedAt: params.receivedAt ? params.receivedAt.toISOString() : null,
      messageId: params.messageId ?? null,
    });
  } catch (error) {
    if (__DEV__) console.warn(`debug: Could not retain source SMS for ${reference}`, error);
  }
}

async function updateOwnershipFromSms(
  reference: string,
  check: SmsOwnershipCheck,
  options: ProcessOptions,
): Promise<void> {
  if (check.conflict) {
    // Addressed to someone else's account: drop an automatic owner an older rule gave it.
    await transactionRepository.updateTransactionOwnership({
      reference,
      ownerAccountNumber: null,
      ownerAssignmentSource: OwnerAssignment.conflict,
    });
    return;
  }
  const owner = check.owner;
  if (!owner) return;
  await transactionRepository.updateTransactionOwnership({
    reference,
    ownerAccountNumber: owner.account.accountNumber,
    ownerAssignmentSource: OwnerAssignment.automatic,
    sourceSubscriptionId: options.sourceSubscriptionId ?? null,
    sourceMessageId: options.sourceMessageId ?? null,
  });
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

function showTransactionNotificationUnlessSelfTransfer(transaction: Transaction): Promise<void> {
  const turn = notificationTurn.then(() => showTransactionNotificationUnlessSelfTransferNow(transaction));
  notificationTurn = turn.catch(() => undefined);
  return turn;
}

// ------------------------------------------------------------------ core parsing

async function processInternal(body: string, sender: string, options: ProcessOptions): Promise<ParseResult> {
  const notifyUser = options.notifyUser ?? false;
  const skipDashen = options.skipDashenExpenseDuplicates ?? true;
  const skipAutoCategorization = options.skipAutoCategorization ?? false;
  const recordFailure = options.recordFailure ?? true;
  const messageDate = options.messageDate ?? null;
  const subscriptionId = normalizedSubscriptionId(options.sourceSubscriptionId);

  const bank = await getRelevantBank(sender);
  if (!bank) return { status: 'noBank', reason: 'No matching bank' };

  if (isTelebirrAtmAuthorization(bank.id, body)) {
    return { status: 'duplicate', reason: 'Ignored Telebirr ATM authorization notice' };
  }
  if (isTelebirrAirtimeReceipt(bank.id, body)) {
    return { status: 'duplicate', reason: 'Ignored Telebirr airtime receipt acknowledgement' };
  }

  // Messages from banks without a registered account are still saved. Their parsed account
  // numbers show up as unlabeled accounts the user can name later, without reparsing.
  const registeredAccounts = await accountRepository.getAccounts();

  // 1. Patterns for this bank.
  const patterns = (await smsConfigService.getPatterns({ allowRemoteFetch: false })).filter((p) => p.bankId === bank.id);

  // 2. Parse.
  const parsed = parsePatternMessage({
    message: smsConfigService.cleanSmsText(body),
    patterns,
    bank,
    bankId: bank.id,
    messageDate,
  });

  if (!parsed) {
    if (notifyUser && recordFailure) {
      try {
        const canonical = await retryCanonicalInboxCopy({
          originalBody: body,
          senderAddress: sender,
          messageDate,
          bank,
          skipDashenExpenseDuplicates: skipDashen,
          skipAutoCategorization,
        });
        if (canonical) {
          if (canonical.status === 'success' && canonical.transaction) {
            await showTransactionNotificationUnlessSelfTransfer(canonical.transaction);
          }
          return canonical;
        }
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
  const ownershipBank = parsedBankId === bank.id ? bank : bankById(await bankRepository.getBanks(), parsedBankId);
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
          await accountRepository.bindSmsSubscription(owner.account.accountNumber, parsedBankId, subscriptionId);
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
  const existing = await transactionRepository.getTransactions();
  const capture = (reference: string) =>
    captureTransactionSourceSms({
      transactionReference: reference,
      body,
      senderAddress: sender,
      receivedAt: messageDate,
      messageId: options.sourceMessageId,
    });

  const sourceDuplicate = findSmsSourceDuplicate(details, existing);
  if (sourceDuplicate) {
    await updateOwnershipFromSms(sourceDuplicate.reference, ownership, { ...options, sourceSubscriptionId: subscriptionId });
    await capture(sourceDuplicate.reference);
    return { status: 'duplicate', reason: 'Duplicate SMS source' };
  }

  const newRef = typeof details.reference === 'string' ? details.reference : null;
  if (newRef && existing.some((t) => t.reference === newRef)) {
    // A shared bank reference is not ownership evidence. Telebirr legs are
    // scoped above; any remaining collision is the same logical row.
    await updateOwnershipFromSms(newRef, ownership, { ...options, sourceSubscriptionId: subscriptionId });
    await capture(newRef);
    if (isAtmWithdrawal(details, body)) {
      try {
        const match = existing.find((t) => t.reference === newRef);
        if (match) await createCashTransactionForAtmWithdrawal(match, existing);
      } catch (error) {
        if (__DEV__) console.warn('debug: Error reconciling cash transfer', error);
      }
    }
    const reason = `Duplicate transaction ${newRef}`;
    if (recordFailure) {
      await recordFailedParse({ address: sender, body, reason, timestamp: messageDate, bankId: parsedBankId });
    }
    return { status: 'duplicate', reason };
  }

  if (skipDashen && isDashenExactDuplicate(details, existing)) {
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
    const hasNewer = existing.some((t) => {
      if (t.bankId !== ownerAccount.bank || !t.currentBalance?.trim() || !t.time) return false;
      const time = new Date(t.time).getTime();
      return time > at && transactionBelongsToAccount(t, ownerAccount, ownershipBank, bankAccounts);
    });
    if (!hasNewer) {
      await accountRepository.updateBalance(ownerAccount.accountNumber, ownerAccount.bank, sanitizeAmount(parsed.currentBalance));
    }
  }

  // 5. Save.
  const newTx = transactionFromJson(details);
  await transactionRepository.saveTransaction(newTx, { skipAutoCategorization });
  const saved = (await transactionRepository.getTransactionByReference(newTx.reference)) ?? newTx;
  await capture(saved.reference);

  if (isAtmWithdrawal(details, body)) {
    try {
      await createCashTransactionForAtmWithdrawal(saved, existing);
    } catch (error) {
      if (__DEV__) console.warn('debug: Error creating cash transfer', error);
    }
  }

  if (notifyUser) await showTransactionNotificationUnlessSelfTransfer(saved);

  if (saved.type === 'DEBIT') {
    try {
      const { checkAndNotifyBudgetAlerts } = await import('./budgetAlert');
      await checkAndNotifyBudgetAlerts();
    } catch (error) {
      if (__DEV__) console.warn('debug: Error checking budget alerts after SMS transaction', error);
    }
  }

  dataChanged.notify();
  return { status: 'success', transaction: saved };
}

async function processMessage(
  body: string,
  sender: string,
  options: Omit<ProcessOptions, 'recordFailure'> = {},
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

  const result = await processInternal(effectiveBody, effectiveSender, {
    ...options,
    messageDate: effectiveDate,
    sourceMessageId: effectiveMessageId,
    sourceSubscriptionId: effectiveSubscriptionId,
    recordFailure: true,
  });
  return result.transaction ?? null;
}

function retryFailedParse(
  body: string,
  sender: string,
  options: Omit<ProcessOptions, 'recordFailure' | 'notifyUser'> = {},
): Promise<ParseResult> {
  return processInternal(body, sender, { ...options, notifyUser: false, recordFailure: false });
}

// ------------------------------------------------------------------ inbox sync

async function processInboxMessages(messages: RawSms[]): Promise<TodaySmsSyncResult> {
  const result = { ...EMPTY_SYNC_RESULT };
  // Oldest first, so the latest balance wins.
  const chronological = [...messages].sort((a, b) => (a.date ?? 0) - (b.date ?? 0));
  for (const message of chronological) {
    const { body, address } = message;
    if (body == null || address == null) {
      result.skipped++;
      continue;
    }
    if (!(await getRelevantBank(address))) {
      result.skipped++;
      continue;
    }
    result.processed++;
    try {
      const parsed = await processInternal(body, address, {
        messageDate: smsDate(message),
        sourceMessageId: message.id ?? null,
        sourceSubscriptionId: message.subscriptionId ?? null,
        notifyUser: false,
        recordFailure: false,
      });
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
  }
  return result;
}

async function syncBankSmsRange(params: { start: Date; includeStart: boolean; end: Date }): Promise<TodaySmsSyncResult> {
  const since = params.start.getTime() + (params.includeStart ? 0 : 1);
  const messages = await getInbox(since, params.end.getTime());
  return processInboxMessages(messages);
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

/** Imports bank SMS that arrived while the app was not listening (since the last catch-up today). */
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
  const result = await syncBankSmsRange({ start: scanStart, includeStart: !hasCursor, end: scanEndedAt });
  if (result.errors === 0) {
    await setLastSmsCatchupAt(scanEndedAt);
    await extendLastScanAt(scanStart, scanEndedAt);
  }
  if (result.added > 0) dataChanged.notify();
  return result;
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

  const inbox = await getInbox(0, Date.now());
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

  const result = { ...EMPTY_SYNC_RESULT };
  const chronological = [...messages].sort((a, b) => (a.date ?? 0) - (b.date ?? 0));
  for (let i = 0; i < chronological.length; i++) {
    const message = chronological[i];
    result.processed++;
    try {
      const parsed = await processInternal(message.body!, message.address!, {
        messageDate: smsDate(message),
        sourceMessageId: message.id ?? null,
        sourceSubscriptionId: message.subscriptionId ?? null,
        notifyUser: false,
        recordFailure: false,
      });
      if (parsed.status === 'success') result.added++;
      else if (parsed.status === 'duplicate') result.duplicates++;
      else if (parsed.status === 'noPattern') result.noPattern++;
      else result.skipped++;
    } catch (error) {
      result.errors++;
      if (__DEV__) console.warn('debug: Error importing SMS history', error);
    }
    if ((i + 1) % 10 === 0 || i + 1 === chronological.length) {
      params.onProgress?.(i + 1, chronological.length);
      void notify(i + 1);
    }
  }

  try {
    const { reconcileAccounts } = await import('./accountLabeling');
    await reconcileAccounts();
  } catch (error) {
    if (__DEV__) console.warn('debug: Could not reconcile account owners', error);
  }
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
  const inbox = await getInbox(sinceMs, untilMs);
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
async function runBankScan(messages: RawSms[], onProgress?: ScanProgress): Promise<TodaySmsSyncResult> {
  await getAtmCashTransferCutoff();
  const progressNotice = { bankId: 0, accountNumber: 'all', bankName: 'bank messages' };
  const result = { ...EMPTY_SYNC_RESULT };
  const chronological = [...messages].sort((a, b) => (a.date ?? 0) - (b.date ?? 0));
  onProgress?.(0, chronological.length);
  for (let i = 0; i < chronological.length; i++) {
    const message = chronological[i];
    result.processed++;
    try {
      const parsed = await processInternal(message.body!, message.address!, {
        messageDate: smsDate(message),
        sourceMessageId: message.id ?? null,
        sourceSubscriptionId: message.subscriptionId ?? null,
        notifyUser: false,
        recordFailure: false,
      });
      if (parsed.status === 'success') result.added++;
      else if (parsed.status === 'duplicate') result.duplicates++;
      else if (parsed.status === 'noPattern') result.noPattern++;
      else result.skipped++;
    } catch (error) {
      result.errors++;
      if (__DEV__) console.warn('debug: Error importing bank SMS', error);
    }
    if ((i + 1) % 25 === 0 || i + 1 === chronological.length) {
      onProgress?.(i + 1, chronological.length);
      if (chronological.length > 50) {
        void notificationService
          .showAccountSyncProgress({ ...progressNotice, processed: i + 1, total: chronological.length })
          .catch(() => undefined);
      }
    }
  }
  try {
    const { reconcileAccounts } = await import('./accountLabeling');
    await reconcileAccounts();
  } catch (error) {
    if (__DEV__) console.warn('debug: Could not reconcile account owners', error);
  }
  if (chronological.length > 50) {
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
 * labeling one later doesn't need another pass over the inbox.
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
 * this is the full import.
 */
async function syncBankSmsSinceLastScan(params: { onProgress?: ScanProgress } = {}): Promise<TodaySmsSyncResult & { since: Date | null }> {
  if (Platform.OS !== 'android') return { ...EMPTY_SYNC_RESULT, since: null };
  if (!hasSmsPermission()) return { ...EMPTY_SYNC_RESULT, permissionDenied: true, since: null };
  const since = await getLastScanAt();
  if (!since) return { ...(await syncAllBankHistory(params)), since: null };
  const scanEndedAt = new Date();
  const from = Math.max(0, since.getTime() - SCAN_OVERLAP_MS);
  const result = await runBankScan(await bankInbox(from, scanEndedAt.getTime()), params.onProgress);
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
  if (!sms.body || !sms.address) return null;
  if (!(await isRelevantMessage(sms.address))) return null;
  return processMessage(sms.body, sms.address, {
    notifyUser: true,
    messageDate: smsDate(sms),
    sourceMessageId: sms.id ?? null,
    sourceSubscriptionId: sms.subscriptionId ?? null,
  });
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
 * The native SMS receiver starts this headless task when a message arrives
 * while no React context is running (app killed).
 */
export function registerSmsHeadlessTask(): void {
  if (Platform.OS !== 'android') return;
  AppRegistry.registerHeadlessTask(SMS_HEADLESS_TASK, () => async (data: RawSms) => {
    try {
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
