import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { isReimbursementCategory, type Category } from '../models/category';
import type { LoanDebtDirection } from '../models/loanDebt';
import { isCredit, isDebit, makeTransaction, type Transaction } from '../models/transaction';
import { CASH_ACCOUNT_NUMBER, CASH_BANK, CASH_BANK_ID } from '../utils/cashConstants';
import { formatNumber } from '../utils/format';
import { failedParseReviewService } from './failedParseReview';
import { intentFromPayload, notificationIntentBus } from './notificationIntentBus';
import { notificationSettings } from './notificationSettings';
import { prefs } from './prefs';

export const NotificationChannels = {
  transactions: 'transactions',
  failedParseReview: 'failed_parse_review',
  spendingSummaries: 'spending_summaries',
  accountSync: 'account_sync',
  accountSyncComplete: 'account_sync_complete',
  budgets: 'budgets',
  sharedExpenses: 'shared_expenses',
  loanDebtReminders: 'loan_debt_reminders',
  dataSync: 'data_sync',
} as const;

type ChannelId = (typeof NotificationChannels)[keyof typeof NotificationChannels];

const CHANNELS: { id: ChannelId; name: string; description: string; importance: Notifications.AndroidImportance }[] = [
  {
    id: 'transactions',
    name: 'Transactions',
    description: 'Notifications when a new transaction is detected',
    importance: Notifications.AndroidImportance.HIGH,
  },
  {
    id: 'failed_parse_review',
    name: 'Failed parse review',
    description: 'Prompts to confirm unparsed bank transactions',
    importance: Notifications.AndroidImportance.HIGH,
  },
  {
    id: 'spending_summaries',
    name: 'Spending summaries',
    description: 'Daily, weekly, and monthly spending summaries',
    importance: Notifications.AndroidImportance.DEFAULT,
  },
  {
    id: 'account_sync',
    name: 'Account sync',
    description: 'Background sync of account transactions',
    importance: Notifications.AndroidImportance.LOW,
  },
  {
    id: 'account_sync_complete',
    name: 'Account sync results',
    description: 'Completion summaries for account transaction syncs',
    importance: Notifications.AndroidImportance.DEFAULT,
  },
  {
    id: 'budgets',
    name: 'Budget Alerts',
    description: 'Notifications for budget warnings and alerts',
    importance: Notifications.AndroidImportance.DEFAULT,
  },
  {
    id: 'shared_expenses',
    name: 'Shared expenses',
    description: 'Nudges and reminders from shared expenses',
    importance: Notifications.AndroidImportance.HIGH,
  },
  {
    id: 'loan_debt_reminders',
    name: 'Loan and debt reminders',
    description: 'Return date reminders for loans and debts',
    importance: Notifications.AndroidImportance.HIGH,
  },
  {
    id: 'data_sync',
    name: 'Data Sync',
    description: 'Results of syncing your data to your backend',
    importance: Notifications.AndroidImportance.DEFAULT,
  },
];

const IDS = {
  dailySummary: 9001,
  dailySummaryTest: 9002,
  weeklySummary: 9003,
  weeklySummaryTest: 9004,
  monthlySummary: 9005,
  monthlySummaryTest: 9006,
  dataSync: 9008,
};

const HISTORY_KEY = 'notification_history_v1';
const HISTORY_LIMIT = 200;

/** Action identifiers. The transaction reference / review id travels in the notification data. */
const ACTION_COUNTERPARTY = 'txname';
const ACTION_QUICK_CATEGORY_PREFIX = 'cat:';
const ACTION_FAILED_PARSE_YES = 'fp_yes';
const ACTION_FAILED_PARSE_NO = 'fp_no';
const FAILED_PARSE_CATEGORY = 'failed_parse_review';

export interface NotificationHistoryEntry {
  channel: string;
  title: string;
  body: string;
  sentAt: string;
  transactionReference?: string | null;
}

interface NotificationData {
  payload?: string;
  reference?: string;
  reviewId?: string;
  [key: string]: unknown;
}

/** Same as the Flutter stableHash: deterministic across runs and platforms. */
export function stableHash(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) & 0x0fffffff;
  return hash;
}

function transactionNotificationId(tx: Transaction): number {
  const key = tx.reference.trim() || `${tx.time ?? ''}|${tx.amount}`;
  return stableHash(key) & 0x7fffffff;
}

const failedParseNotificationId = (reviewId: string) => 200000 + stableHash(reviewId);
const sharedExpenseNotificationId = (eventId: string) => 300000 + stableHash(eventId);
const loanDebtReminderId = (ref: string) => 700000 + stableHash(ref);
const loanDebtReminderTestId = (ref: string) => 1000000000 + stableHash(ref);
const accountSyncId = (bankId: number, accountNumber: string) => 8000 + stableHash(`${bankId}|${accountNumber}`);

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeToken(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

let initialized = false;
let responseSubscription: Notifications.EventSubscription | null = null;
let lastHandledResponseKey: string | null = null;

async function present(params: {
  id: number | string;
  channel: ChannelId;
  title: string;
  body: string;
  data?: NotificationData;
  categoryIdentifier?: string;
  trigger?: Date;
  sticky?: boolean;
}): Promise<void> {
  const content: Notifications.NotificationContentInput = {
    title: params.title,
    body: params.body,
    data: (params.data ?? {}) as Record<string, unknown>,
    sticky: params.sticky,
  };
  if (params.categoryIdentifier) content.categoryIdentifier = params.categoryIdentifier;
  const trigger: Notifications.NotificationTriggerInput = params.trigger
    ? { type: Notifications.SchedulableTriggerInputTypes.DATE, date: params.trigger, channelId: params.channel }
    : Platform.OS === 'android'
      ? { channelId: params.channel }
      : null;
  await Notifications.scheduleNotificationAsync({ identifier: String(params.id), content, trigger });
}

async function cancel(id: number | string): Promise<void> {
  const identifier = String(id);
  try {
    await Notifications.cancelScheduledNotificationAsync(identifier);
  } catch {
    // Not scheduled.
  }
  try {
    await Notifications.dismissNotificationAsync(identifier);
  } catch {
    // Not presented.
  }
}

async function recordHistory(entry: Omit<NotificationHistoryEntry, 'sentAt'>): Promise<void> {
  try {
    const history = (await prefs.getJson<NotificationHistoryEntry[]>(HISTORY_KEY)) ?? [];
    history.unshift({ ...entry, sentAt: new Date().toISOString() });
    await prefs.setJson(HISTORY_KEY, history.slice(0, HISTORY_LIMIT));
  } catch (error) {
    if (__DEV__) console.warn('debug: Failed to record notification history', error);
  }
}

async function hasPermission(): Promise<boolean> {
  try {
    const status = await Notifications.getPermissionsAsync();
    return status.granted;
  } catch {
    return false;
  }
}

async function loadCategories(): Promise<Category[]> {
  const { categoryRepository } = await import('../repositories/categoryRepository');
  return categoryRepository.getCategories();
}

async function knownBankTokens(): Promise<Set<string>> {
  const { bankRepository } = await import('../repositories/bankRepository');
  const tokens = new Set<string>();
  for (const bank of [...(await bankRepository.getBanks()), CASH_BANK]) {
    for (const raw of [bank.name, bank.shortName, ...bank.codes]) {
      const token = normalizeToken(raw);
      if (token) tokens.add(token);
    }
  }
  tokens.add(normalizeToken('Cash Wallet'));
  tokens.add(normalizeToken('Cash'));
  return tokens;
}

function counterpartyValue(tx: Transaction): string {
  const primary = isCredit(tx) ? tx.creditor : tx.receiver;
  const fallback = isCredit(tx) ? tx.receiver : tx.creditor;
  return (primary?.trim() || fallback?.trim() || '').trim();
}

function counterpartyRole(tx: Transaction): 'sender' | 'receiver' {
  return isCredit(tx) ? 'sender' : 'receiver';
}

async function needsCounterpartyInput(tx: Transaction): Promise<boolean> {
  const value = counterpartyValue(tx);
  if (!value) return true;
  return (await knownBankTokens()).has(normalizeToken(value));
}

function categoryLabel(tx: Transaction, categories: Category[]): string | null {
  const ids = [tx.categoryId, ...(tx.categoryIds ?? [])].filter((v): v is number => v != null);
  const names: string[] = [];
  for (const id of ids) {
    const name = categories.find((c) => c.id === id)?.name?.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  if (names.length === 0) return null;
  return names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
}

async function quickCategories(tx: Transaction, limit: number, categories: Category[]): Promise<Category[]> {
  if (limit <= 0) return [];
  const ids = isCredit(tx)
    ? await notificationSettings.getQuickCategorizeIncomeIds()
    : await notificationSettings.getQuickCategorizeExpenseIds();
  const out: Category[] = [];
  for (const id of ids) {
    const category = categories.find((c) => c.id === id);
    if (!category || isReimbursementCategory(category)) continue;
    out.push(category);
    if (out.length >= Math.min(limit, 3)) break;
  }
  return out;
}

/** Notification categories are keyed by their action set so identical layouts are reused. */
async function ensureTransactionCategory(needsInput: boolean, role: string, quick: Category[]): Promise<string | undefined> {
  if (!needsInput && quick.length === 0) return undefined;
  const identifier = `tx_${needsInput ? role : 'none'}_${quick.map((c) => c.id).join('-') || 'x'}`;
  const actions: Notifications.NotificationAction[] = [];
  if (needsInput) {
    actions.push({
      identifier: ACTION_COUNTERPARTY,
      buttonTitle: `add ${role}`,
      textInput: { submitButtonTitle: 'Save', placeholder: `Enter ${role} name` },
      options: { opensAppToForeground: false },
    });
  }
  for (const category of quick) {
    actions.push({
      identifier: `${ACTION_QUICK_CATEGORY_PREFIX}${category.id}`,
      buttonTitle: category.name,
      options: { opensAppToForeground: false },
    });
  }
  await Notifications.setNotificationCategoryAsync(identifier, actions);
  return identifier;
}

async function ensureFailedParseCategory(): Promise<void> {
  await Notifications.setNotificationCategoryAsync(FAILED_PARSE_CATEGORY, [
    { identifier: ACTION_FAILED_PARSE_YES, buttonTitle: 'Yes', options: { opensAppToForeground: false } },
    { identifier: ACTION_FAILED_PARSE_NO, buttonTitle: 'No', options: { opensAppToForeground: false } },
  ]);
}

function loanDebtContent(params: { personName: string; direction: LoanDebtDirection; amount: number | null }): {
  title: string;
  body: string;
} {
  const name = params.personName.trim() || 'this person';
  const amountPhrase = params.amount != null && params.amount > 0 ? ` ETB ${formatNumber(params.amount)}` : '';
  if (params.direction === 'borrowed') {
    return { title: 'Debt due today', body: `You're due to pay ${name}${amountPhrase} today.` };
  }
  return { title: 'Loan due today', body: `${name} is due to pay you${amountPhrase} today.` };
}

async function handleCounterpartyInput(reference: string, rawInput: string | undefined): Promise<void> {
  const input = rawInput?.trim();
  if (!input || !reference) return;
  const { transactionRepository } = await import('../repositories/transactionRepository');
  const tx = await transactionRepository.getTransactionByReference(reference);
  if (!tx) return;
  const updated = makeTransaction(isCredit(tx) ? { ...tx, creditor: input } : { ...tx, receiver: input });
  await transactionRepository.saveTransaction(updated, { skipAutoCategorization: true });
  await notificationService.showTransactionNotification(updated, { ignoreEnabledCheck: true, recordHistory: false });
}

async function handleQuickCategorize(reference: string, categoryId: number): Promise<void> {
  if (!reference || !Number.isFinite(categoryId)) return;
  const category = (await loadCategories()).find((c) => c.id === categoryId);
  if (!category || isReimbursementCategory(category)) return;
  const { transactionRepository } = await import('../repositories/transactionRepository');
  const tx = await transactionRepository.getTransactionByReference(reference);
  if (!tx) return;
  await transactionRepository.saveTransaction(makeTransaction({ ...tx, categoryId, categoryIds: [categoryId] }), {
    skipAutoCategorization: true,
  });
  await cancel(transactionNotificationId(tx));
}

/**
 * Handles a tap or action button. Exported so the background notification task can
 * process action buttons pressed while the app is not running.
 */
export async function handleNotificationResponse(response: Notifications.NotificationResponse): Promise<void> {
  const request = response.notification.request;
  const key = `${request.identifier}|${response.actionIdentifier}|${response.notification.date}`;
  if (key === lastHandledResponseKey) return;
  lastHandledResponseKey = key;

  const data = (request.content.data ?? {}) as NotificationData;
  const action = response.actionIdentifier;
  const reference = data.reference ?? '';
  try {
    if (action === ACTION_COUNTERPARTY) {
      await handleCounterpartyInput(reference, response.userText);
      return;
    }
    if (action.startsWith(ACTION_QUICK_CATEGORY_PREFIX)) {
      await handleQuickCategorize(reference, Number.parseInt(action.substring(ACTION_QUICK_CATEGORY_PREFIX.length), 10));
      return;
    }
    if (action === ACTION_FAILED_PARSE_YES || action === ACTION_FAILED_PARSE_NO) {
      const reviewId = data.reviewId ?? '';
      if (reviewId) {
        if (action === ACTION_FAILED_PARSE_YES) await failedParseReviewService.confirmCandidate(reviewId);
        else await failedParseReviewService.discardCandidate(reviewId);
      }
      await cancel(request.identifier);
      return;
    }
    const intent = intentFromPayload(data.payload);
    if (intent) notificationIntentBus.emit(intent);
  } catch (error) {
    if (__DEV__) console.warn('debug: Failed to handle notification response', error);
  }
}

export const notificationService = {
  async initialize(): Promise<void> {
    if (initialized) return;
    initialized = true;
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
    if (Platform.OS === 'android') {
      for (const channel of CHANNELS) {
        await Notifications.setNotificationChannelAsync(channel.id, {
          name: channel.name,
          description: channel.description,
          importance: channel.importance,
        });
      }
    }
    await ensureFailedParseCategory();
    responseSubscription?.remove();
    responseSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
      void handleNotificationResponse(response);
    });
  },

  async requestPermissions(): Promise<boolean> {
    if (await hasPermission()) return true;
    const result = await Notifications.requestPermissionsAsync();
    return result.granted;
  },

  hasPermission,

  /** Forwards the notification that launched the app (if any) to the intent bus. */
  async emitLaunchIntentIfAny(): Promise<void> {
    const response = await Notifications.getLastNotificationResponseAsync();
    if (!response) return;
    await handleNotificationResponse(response);
    await Notifications.clearLastNotificationResponseAsync?.();
  },

  // ---------------------------------------------------------------- transactions

  async showTransactionNotification(
    tx: Transaction,
    options: { ignoreEnabledCheck?: boolean; recordHistory?: boolean } = {},
  ): Promise<void> {
    try {
      if (!options.ignoreEnabledCheck && !(await notificationSettings.isTransactionNotificationsEnabled())) return;
      if (!(await hasPermission())) return;

      const { bankRepository } = await import('../repositories/bankRepository');
      const bank = await bankRepository.getBank(tx.bankId);
      const direction = isCredit(tx) ? 'Money In' : isDebit(tx) ? 'Money Out' : 'Transaction';
      const title = `${bank?.shortName || 'Totals'} • ${direction}`;
      const sign = isCredit(tx) ? '+' : isDebit(tx) ? '-' : '';
      const amount = `${sign}ETB ${formatNumber(Math.abs(tx.amount))}`;

      const categories = await loadCategories();
      const needsInput = await needsCounterpartyInput(tx);
      const role = counterpartyRole(tx);
      const counterparty = counterpartyValue(tx);
      const label = categoryLabel(tx, categories);

      let body: string;
      if (needsInput) {
        body = `${amount} • Expand notification to add ${role}`;
      } else if (label) {
        body = counterparty ? `${amount} • ${counterparty} • Categorized as ${label}` : `${amount} • Categorized as ${label}`;
      } else {
        body = counterparty ? `${amount} • ${counterparty} • Tap to categorize` : `${amount} • Tap to categorize`;
      }

      const quick = await quickCategories(tx, needsInput ? 2 : 3, categories);
      const categoryIdentifier = await ensureTransactionCategory(needsInput, role, quick);
      await present({
        id: transactionNotificationId(tx),
        channel: 'transactions',
        title,
        body,
        categoryIdentifier,
        data: { payload: `tx:${encodeURIComponent(tx.reference)}`, reference: tx.reference },
      });
      if (options.recordHistory ?? true) {
        await recordHistory({ channel: 'transactions', title, body, transactionReference: tx.reference });
      }
    } catch (error) {
      if (__DEV__) console.warn('debug: Failed to show transaction notification', error);
    }
  },

  async dismissTransactionNotification(tx: Transaction, options: { removeFromHistory?: boolean } = {}): Promise<void> {
    await cancel(transactionNotificationId(tx));
    if (options.removeFromHistory) await this.removeTransactionNotificationFromHistory(tx.reference);
  },

  async showTestTransactionNotification(): Promise<boolean> {
    if (!(await hasPermission())) return false;
    const tx = makeTransaction({
      amount: 123,
      reference: 'test_transaction_notification_cash',
      note: 'Test transaction notification',
      time: new Date().toISOString(),
      status: 'TEST',
      bankId: CASH_BANK_ID,
      type: 'DEBIT',
      accountNumber: CASH_ACCOUNT_NUMBER,
      ownerAccountNumber: CASH_ACCOUNT_NUMBER,
    });
    const { transactionRepository } = await import('../repositories/transactionRepository');
    await transactionRepository.saveTransaction(tx, { skipAutoCategorization: true });
    await this.showTransactionNotification(tx, { ignoreEnabledCheck: true });
    return true;
  },

  async showFailedParseReviewNotification(params: { reviewId: string; bankName: string; messageBody: string }): Promise<boolean> {
    try {
      if (!(await hasPermission())) return false;
      const collapsed = params.messageBody.replace(/\s+/g, ' ').trim();
      const preview = collapsed.length > 180 ? `${collapsed.substring(0, 177)}...` : collapsed;
      const title = `${params.bankName} transaction review`;
      const body = `Was this a transaction?\n${preview}`;
      await ensureFailedParseCategory();
      await present({
        id: failedParseNotificationId(params.reviewId),
        channel: 'failed_parse_review',
        title,
        body,
        categoryIdentifier: FAILED_PARSE_CATEGORY,
        data: { reviewId: params.reviewId },
      });
      await recordHistory({ channel: 'failed_parse_review', title, body });
      return true;
    } catch (error) {
      if (__DEV__) console.warn('debug: Failed to show failed parse review notification', error);
      return false;
    }
  },

  // ---------------------------------------------------------------- summaries

  async showDailySpendingSummary(params: { amount: number; ignoreEnabledCheck?: boolean; test?: boolean }): Promise<boolean> {
    if (!params.ignoreEnabledCheck && !(await notificationSettings.isDailySummaryEnabled())) return false;
    return this.showSpendingSummary(
      params.test ? IDS.dailySummaryTest : IDS.dailySummary,
      "Today's spending",
      `You've spent ${formatNumber(params.amount)} ETB today.`,
    );
  },

  async showWeeklySpendingSummary(params: { amount: number; ignoreEnabledCheck?: boolean; test?: boolean }): Promise<boolean> {
    if (!params.ignoreEnabledCheck && !(await notificationSettings.isWeeklySummaryEnabled())) return false;
    return this.showSpendingSummary(
      params.test ? IDS.weeklySummaryTest : IDS.weeklySummary,
      "This week's spending",
      `You've spent ${formatNumber(params.amount)} ETB this week.`,
    );
  },

  async showMonthlySpendingSummary(params: { amount: number; ignoreEnabledCheck?: boolean; test?: boolean }): Promise<boolean> {
    if (!params.ignoreEnabledCheck && !(await notificationSettings.isMonthlySummaryEnabled())) return false;
    return this.showSpendingSummary(
      params.test ? IDS.monthlySummaryTest : IDS.monthlySummary,
      "This month's spending",
      `You've spent ${formatNumber(params.amount)} ETB this month.`,
    );
  },

  async showSpendingSummary(id: number, title: string, body: string): Promise<boolean> {
    if (!(await hasPermission())) return false;
    try {
      await present({ id, channel: 'spending_summaries', title, body });
      await recordHistory({ channel: 'spending_summaries', title, body });
      return true;
    } catch (error) {
      if (__DEV__) console.warn('debug: Failed to show spending summary', error);
      return false;
    }
  },

  // ---------------------------------------------------------------- budgets

  async showBudgetAlertNotification(params: { id: number; title: string; body: string }): Promise<void> {
    if (!(await notificationSettings.isBudgetAlertsEnabled())) return;
    if (!(await hasPermission())) return;
    try {
      await present({ id: params.id, channel: 'budgets', title: params.title, body: params.body });
      await recordHistory({ channel: 'budgets', title: params.title, body: params.body });
    } catch (error) {
      if (__DEV__) console.warn('debug: Failed to show budget alert', error);
    }
  },

  // ---------------------------------------------------------------- loans and debts

  async scheduleLoanDebtReturnReminder(params: {
    transactionReference: string;
    personName: string;
    direction: LoanDebtDirection;
    returnDate: Date;
    amount: number | null;
  }): Promise<void> {
    const reference = params.transactionReference.trim();
    if (!reference) return;
    const id = loanDebtReminderId(reference);
    if (!(await notificationSettings.isLoanDebtReturnRemindersEnabled())) {
      await cancel(id);
      return;
    }
    const now = new Date();
    const dueDay = startOfDay(params.returnDate);
    if (dueDay.getTime() < startOfDay(now).getTime()) {
      await cancel(id);
      return;
    }
    let fireAt = new Date(dueDay.getFullYear(), dueDay.getMonth(), dueDay.getDate(), 9, 0);
    if (fireAt.getTime() <= now.getTime()) fireAt = new Date(now.getTime() + 60_000);
    const { title, body } = loanDebtContent(params);
    await cancel(id);
    await present({
      id,
      channel: 'loan_debt_reminders',
      title,
      body,
      trigger: fireAt,
      data: { payload: `loan_debt:${encodeURIComponent(reference)}`, reference },
    });
  },

  async showLoanDebtReturnReminderNow(params: {
    transactionReference: string;
    personName: string;
    direction: LoanDebtDirection;
    amount: number | null;
    useTestId?: boolean;
    ignoreEnabledCheck?: boolean;
  }): Promise<boolean> {
    const reference = params.transactionReference.trim();
    if (!reference) return false;
    if (!params.ignoreEnabledCheck && !(await notificationSettings.isLoanDebtReturnRemindersEnabled())) return false;
    if (!(await hasPermission())) return false;
    try {
      const { title, body } = loanDebtContent(params);
      await present({
        id: params.useTestId ? loanDebtReminderTestId(reference) : loanDebtReminderId(reference),
        channel: 'loan_debt_reminders',
        title,
        body,
        data: { payload: `loan_debt:${encodeURIComponent(reference)}`, reference },
      });
      await recordHistory({ channel: 'loan_debt_reminders', title, body, transactionReference: reference });
      return true;
    } catch (error) {
      if (__DEV__) console.warn('debug: Failed to show loan/debt reminder', error);
      return false;
    }
  },

  async cancelLoanDebtReturnReminder(transactionReference: string): Promise<void> {
    const reference = transactionReference.trim();
    if (!reference) return;
    await cancel(loanDebtReminderId(reference));
    await cancel(loanDebtReminderTestId(reference));
  },

  // ---------------------------------------------------------------- shared expenses

  async showSharedExpenseNudgeNotification(params: {
    nudgeId: string;
    groupName: string;
    payeeName?: string | null;
    amount: number;
    groupId?: string | null;
  }): Promise<void> {
    if (!(await notificationSettings.isSharedExpenseNotificationsEnabled())) return;
    if (!(await hasPermission())) return;
    const payee = params.payeeName?.trim();
    const title = payee ? `Settle up with ${payee}` : 'Settle up reminder';
    const body = `Pay ETB ${formatNumber(params.amount)} to ${payee || 'them'} on ${params.groupName}.`;
    await present({
      id: sharedExpenseNotificationId(params.nudgeId),
      channel: 'shared_expenses',
      title,
      body,
      data: {
        payload: params.groupId ? `shared_expenses:${encodeURIComponent(params.groupId)}` : 'shared_expenses',
      },
    });
    await recordHistory({ channel: 'shared_expenses', title, body });
  },

  async showSharedExpenseEventNotification(params: {
    eventId: string;
    title: string;
    body: string;
    groupId?: string | null;
  }): Promise<void> {
    if (!(await notificationSettings.isSharedExpenseNotificationsEnabled())) return;
    if (!(await hasPermission())) return;
    await present({
      id: sharedExpenseNotificationId(params.eventId),
      channel: 'shared_expenses',
      title: params.title,
      body: params.body,
      data: {
        payload: params.groupId ? `shared_expenses:${encodeURIComponent(params.groupId)}` : 'shared_expenses',
      },
    });
    await recordHistory({ channel: 'shared_expenses', title: params.title, body: params.body });
  },

  // ---------------------------------------------------------------- sync progress

  async showAccountSyncProgress(params: { bankId: number; accountNumber: string; bankName: string; processed: number; total: number }): Promise<void> {
    if (!(await hasPermission())) return;
    const percent = params.total > 0 ? Math.round((params.processed / params.total) * 100) : 0;
    await present({
      id: accountSyncId(params.bankId, params.accountNumber),
      channel: 'account_sync',
      title: `Syncing ${params.bankName}`,
      body: `${params.processed} of ${params.total} messages (${percent}%)`,
      sticky: true,
    });
  },

  async showAccountSyncComplete(params: { bankId: number; accountNumber: string; bankName: string; added: number }): Promise<void> {
    await cancel(accountSyncId(params.bankId, params.accountNumber));
    if (!(await hasPermission())) return;
    const title = `${params.bankName} sync complete`;
    const body =
      params.added === 0
        ? 'No new transactions found.'
        : `${params.added} transaction${params.added === 1 ? '' : 's'} added.`;
    await present({ id: accountSyncId(params.bankId, params.accountNumber) + 1, channel: 'account_sync_complete', title, body });
    await recordHistory({ channel: 'account_sync_complete', title, body });
  },

  async showDataSyncResult(params: { title: string; body: string }): Promise<void> {
    if (!(await hasPermission())) return;
    await present({ id: IDS.dataSync, channel: 'data_sync', title: params.title, body: params.body });
    await recordHistory({ channel: 'data_sync', title: params.title, body: params.body });
  },

  // ---------------------------------------------------------------- history

  async getNotificationHistory(): Promise<NotificationHistoryEntry[]> {
    const history = await prefs.getJson<NotificationHistoryEntry[]>(HISTORY_KEY);
    return Array.isArray(history) ? history : [];
  },

  async clearNotificationHistory(): Promise<void> {
    await prefs.remove(HISTORY_KEY);
  },

  async removeTransactionNotificationFromHistory(reference: string): Promise<void> {
    const history = await this.getNotificationHistory();
    const filtered = history.filter((entry) => entry.transactionReference !== reference);
    if (filtered.length !== history.length) await prefs.setJson(HISTORY_KEY, filtered);
  },

  /** Decodes a reference that was put into a payload with encodeURIComponent. */
  decodeReference: safeDecode,
};
