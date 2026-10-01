import { isReimbursementCategory } from '../models/category';
import { prefs } from './prefs';

const K = {
  transactionEnabled: 'notifications_transaction_enabled',
  failedParseReviewEnabled: 'notifications_failed_parse_review_enabled',
  budgetEnabled: 'notifications_budget_enabled',
  sharedExpensesEnabled: 'notifications_shared_expenses_enabled',
  loanDebtReturnRemindersEnabled: 'notifications_loan_debt_return_reminders_enabled',
  dailyEnabled: 'notifications_daily_enabled',
  dailyHour: 'notifications_daily_hour',
  dailyMinute: 'notifications_daily_minute',
  dailyLastSent: 'notifications_daily_last_sent_epoch_ms',
  weeklyEnabled: 'notifications_weekly_enabled',
  weeklyLastSent: 'notifications_weekly_last_sent_epoch_ms',
  monthlyEnabled: 'notifications_monthly_enabled',
  monthlyLastSent: 'notifications_monthly_last_sent_epoch_ms',
  quickIncomeIds: 'quick_categorize_income_ids',
  quickExpenseIds: 'quick_categorize_expense_ids',
};

const DEFAULT_QUICK_INCOME_KEYS = ['income_salary', 'income_business', 'income_side_hustle'];
const DEFAULT_QUICK_EXPENSE_KEYS = ['expense_groceries', 'expense_transport', 'expense_airtime'];

export interface TimeOfDay {
  hour: number;
  minute: number;
}

async function getDate(key: string): Promise<Date | null> {
  const raw = await prefs.getNumber(key);
  return raw === null ? null : new Date(raw);
}

async function resolveDefaultQuickCategorizeIds(flow: 'income' | 'expense'): Promise<number[]> {
  // Imported lazily: the category repository pulls in the database layer.
  const { categoryRepository } = await import('../repositories/categoryRepository');
  const preferredKeys = flow === 'income' ? DEFAULT_QUICK_INCOME_KEYS : DEFAULT_QUICK_EXPENSE_KEYS;
  const eligible = (await categoryRepository.getCategories()).filter(
    (c) => c.id != null && c.flow === flow && !c.uncategorized && !isReimbursementCategory(c),
  );
  const defaults: number[] = [];
  for (const key of preferredKeys) {
    const id = eligible.find((c) => c.builtInKey === key)?.id;
    if (id != null && !defaults.includes(id)) defaults.push(id);
  }
  for (const c of eligible) {
    if (defaults.length >= 3) break;
    if (c.id != null && !defaults.includes(c.id)) defaults.push(c.id);
  }
  return defaults.slice(0, 3);
}

async function getQuickIds(key: string, flow: 'income' | 'expense'): Promise<number[]> {
  const raw = await prefs.getJson<unknown[]>(key);
  if (!Array.isArray(raw)) {
    const defaults = await resolveDefaultQuickCategorizeIds(flow);
    await prefs.setJson(key, defaults.map(String));
    return defaults;
  }
  return raw.map((v) => Number.parseInt(String(v), 10)).filter((v) => Number.isFinite(v));
}

export const notificationSettings = {
  isTransactionNotificationsEnabled: () => prefs.getBool(K.transactionEnabled, true),
  setTransactionNotificationsEnabled: (v: boolean) => prefs.setBool(K.transactionEnabled, v),

  isFailedParseReviewNotificationsEnabled: () => prefs.getBool(K.failedParseReviewEnabled, true),
  setFailedParseReviewNotificationsEnabled: (v: boolean) => prefs.setBool(K.failedParseReviewEnabled, v),

  isBudgetAlertsEnabled: () => prefs.getBool(K.budgetEnabled, true),
  setBudgetAlertsEnabled: (v: boolean) => prefs.setBool(K.budgetEnabled, v),

  isSharedExpenseNotificationsEnabled: () => prefs.getBool(K.sharedExpensesEnabled, true),
  setSharedExpenseNotificationsEnabled: (v: boolean) => prefs.setBool(K.sharedExpensesEnabled, v),

  isLoanDebtReturnRemindersEnabled: () => prefs.getBool(K.loanDebtReturnRemindersEnabled, true),
  setLoanDebtReturnRemindersEnabled: (v: boolean) => prefs.setBool(K.loanDebtReturnRemindersEnabled, v),

  isDailySummaryEnabled: () => prefs.getBool(K.dailyEnabled, true),
  setDailySummaryEnabled: (v: boolean) => prefs.setBool(K.dailyEnabled, v),

  async getDailySummaryTime(): Promise<TimeOfDay> {
    return { hour: (await prefs.getNumber(K.dailyHour)) ?? 20, minute: (await prefs.getNumber(K.dailyMinute)) ?? 0 };
  },
  async setDailySummaryTime(time: TimeOfDay): Promise<void> {
    await prefs.setNumber(K.dailyHour, time.hour);
    await prefs.setNumber(K.dailyMinute, time.minute);
  },

  getDailySummaryLastSentAt: () => getDate(K.dailyLastSent),
  setDailySummaryLastSentAt: (d: Date) => prefs.setNumber(K.dailyLastSent, d.getTime()),
  clearDailySummaryLastSentAt: () => prefs.remove(K.dailyLastSent),

  isWeeklySummaryEnabled: () => prefs.getBool(K.weeklyEnabled, true),
  setWeeklySummaryEnabled: (v: boolean) => prefs.setBool(K.weeklyEnabled, v),
  getWeeklySummaryLastSentAt: () => getDate(K.weeklyLastSent),
  setWeeklySummaryLastSentAt: (d: Date) => prefs.setNumber(K.weeklyLastSent, d.getTime()),
  clearWeeklySummaryLastSentAt: () => prefs.remove(K.weeklyLastSent),

  isMonthlySummaryEnabled: () => prefs.getBool(K.monthlyEnabled, false),
  setMonthlySummaryEnabled: (v: boolean) => prefs.setBool(K.monthlyEnabled, v),
  getMonthlySummaryLastSentAt: () => getDate(K.monthlyLastSent),
  setMonthlySummaryLastSentAt: (d: Date) => prefs.setNumber(K.monthlyLastSent, d.getTime()),
  clearMonthlySummaryLastSentAt: () => prefs.remove(K.monthlyLastSent),

  async isAnySpendingSummaryEnabled(): Promise<boolean> {
    return (
      (await this.isDailySummaryEnabled()) || (await this.isWeeklySummaryEnabled()) || (await this.isMonthlySummaryEnabled())
    );
  },

  getQuickCategorizeIncomeIds: () => getQuickIds(K.quickIncomeIds, 'income'),
  setQuickCategorizeIncomeIds: (ids: number[]) => prefs.setJson(K.quickIncomeIds, ids.slice(0, 3).map(String)),
  getQuickCategorizeExpenseIds: () => getQuickIds(K.quickExpenseIds, 'expense'),
  setQuickCategorizeExpenseIds: (ids: number[]) => prefs.setJson(K.quickExpenseIds, ids.slice(0, 3).map(String)),
};
