import type { Budget, BudgetStatus } from '../models/budget';
import { budgetService } from './budgetService';
import { notificationService } from './notifications';
import { notificationSettings } from './notificationSettings';
import { prefs } from './prefs';

const BUDGET_NOTIFICATION_ID_BASE = 10000;
const ALERT_SENT_PREFIX = 'budget_alert_sent';

export type BudgetAlertType = 'approaching' | 'exceeded';

export interface BudgetAlert {
  budget: Budget;
  status: BudgetStatus;
  alertType: BudgetAlertType;
  message: string;
}

function formatCurrency(amount: number): string {
  return `ETB ${amount.toFixed(2)}`;
}

function exceededMessage(status: BudgetStatus): string {
  return `${status.budget.name} budget exceeded by ${formatCurrency(status.spent - status.budget.amount)}`;
}

function approachingMessage(status: BudgetStatus): string {
  return `${status.budget.name} budget is ${status.percentageUsed.toFixed(1)}% used`;
}

function alertForStatus(status: BudgetStatus): BudgetAlert | null {
  if (status.isExceeded) {
    return { budget: status.budget, status, alertType: 'exceeded', message: exceededMessage(status) };
  }
  if (status.isApproachingLimit) {
    return { budget: status.budget, status, alertType: 'approaching', message: approachingMessage(status) };
  }
  return null;
}

/** One alert per budget, type and period. */
function alertKey(alert: BudgetAlert): string {
  return `${ALERT_SENT_PREFIX}:${alert.budget.id ?? 0}:${alert.alertType}:${alert.status.periodStart.getTime()}`;
}

export async function checkBudgetAlerts(): Promise<BudgetAlert[]> {
  const statuses = await budgetService.getAllBudgetStatuses();
  return statuses.map(alertForStatus).filter((a): a is BudgetAlert => a !== null);
}

export async function sendBudgetAlertNotification(alert: BudgetAlert): Promise<void> {
  if (!(await notificationSettings.isBudgetAlertsEnabled())) return;
  const key = alertKey(alert);
  if (await prefs.getBool(key, false)) return;

  await notificationService.showBudgetAlertNotification({
    id: BUDGET_NOTIFICATION_ID_BASE + (alert.budget.id ?? 0),
    title: alert.alertType === 'exceeded' ? 'Budget Exceeded' : 'Budget Warning',
    body: alert.message,
  });
  await prefs.setBool(key, true);
}

export async function checkAndNotifyBudgetAlerts(): Promise<void> {
  for (const alert of await checkBudgetAlerts()) {
    await sendBudgetAlertNotification(alert);
  }
}

export async function checkAndNotifyBudgetAlert(budget: Budget): Promise<void> {
  try {
    const status = await budgetService.getCurrentBudgetStatus(budget);
    const alert = status ? alertForStatus(status) : null;
    if (alert) await sendBudgetAlertNotification(alert);
  } catch (error) {
    if (__DEV__) console.warn(`debug: Failed to check budget alert for budget ${budget.id}`, error);
  }
}

export async function checkAndNotifyBudgetAlertsForCategory(categoryId: number): Promise<void> {
  try {
    for (const budget of await budgetService.getBudgetsByCategory(categoryId)) {
      await checkAndNotifyBudgetAlert(budget);
    }
  } catch (error) {
    if (__DEV__) console.warn(`debug: Failed to check budget alerts for category ${categoryId}`, error);
  }
}
