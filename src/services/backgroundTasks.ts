import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { addDays, nextPeriodStart, periodStart, sameDay, startOfWeek, type CalendarKind } from '../utils/periodUtils';
import { checkAndNotifyBudgetAlerts } from './budgetAlert';
import { runScheduledDriveBackup } from './driveSync';
import { handleNotificationResponse, notificationService } from './notifications';
import { notificationSettings, type TimeOfDay } from './notificationSettings';
import { PrefKeys, prefs } from './prefs';
import { registerSmsHeadlessTask, smsService } from './smsService';
import { spendingSummary } from './spendingSummary';

export const PERIODIC_TASK = 'totals-periodic-refresh';
export const NOTIFICATION_RESPONSE_TASK = 'totals-notification-response';

function isAfterOrEqualTimeOfDay(now: Date, time: TimeOfDay): boolean {
  if (now.getHours() !== time.hour) return now.getHours() > time.hour;
  return now.getMinutes() >= time.minute;
}

export function isWeeklySummarySendDay(date: Date): boolean {
  return date.getDay() === 0;
}

/** Last day of the month: Gregorian, or Ethiopian (day 30, or the last day of Pagume). */
export function isMonthlySummarySendDay(date: Date, calendar: CalendarKind = 'gregorian'): boolean {
  return sameDay(addDays(date, 1), nextPeriodStart(date, 'monthly', calendar));
}

async function storedCalendar(): Promise<CalendarKind> {
  return (await prefs.getString(PrefKeys.calendar)) === 'ethiopian' ? 'ethiopian' : 'gregorian';
}

async function syncMissedBankSmsBestEffort(): Promise<void> {
  try {
    const result = await smsService.syncMissedBankSmsSinceLastCatchup();
    if (__DEV__ && result.added > 0) console.warn(`debug: Background SMS catch-up added ${result.added} transaction(s)`);
  } catch (error) {
    if (__DEV__) console.warn('debug: Background SMS catch-up failed', error);
  }
}

async function sendSpendingSummariesIfDue(now: Date): Promise<void> {
  if (!isAfterOrEqualTimeOfDay(now, await notificationSettings.getDailySummaryTime())) return;

  if (await notificationSettings.isDailySummaryEnabled()) {
    const lastSent = await notificationSettings.getDailySummaryLastSentAt();
    if (!lastSent || !sameDay(lastSent, now)) {
      const amount = await spendingSummary.getTodaySpending(now);
      if (await notificationService.showDailySpendingSummary({ amount })) {
        await notificationSettings.setDailySummaryLastSentAt(now);
      }
    }
  }

  if ((await notificationSettings.isWeeklySummaryEnabled()) && isWeeklySummarySendDay(now)) {
    const lastSent = await notificationSettings.getWeeklySummaryLastSentAt();
    if (!lastSent || lastSent.getTime() < startOfWeek(now).getTime()) {
      const amount = await spendingSummary.getCurrentWeekSpending(now);
      if (await notificationService.showWeeklySpendingSummary({ amount })) {
        await notificationSettings.setWeeklySummaryLastSentAt(now);
      }
    }
  }

  const calendar = await storedCalendar();
  if ((await notificationSettings.isMonthlySummaryEnabled()) && isMonthlySummarySendDay(now, calendar)) {
    const lastSent = await notificationSettings.getMonthlySummaryLastSentAt();
    const monthStart = periodStart(now, 'monthly', calendar);
    if (!lastSent || lastSent.getTime() < monthStart.getTime()) {
      const amount = await spendingSummary.getCurrentMonthSpending(now, calendar);
      if (await notificationService.showMonthlySpendingSummary({ amount })) {
        await notificationSettings.setMonthlySummaryLastSentAt(now);
      }
    }
  }
}

/** Same work the Flutter workmanager callback did for the daily summary task. */
export async function runPeriodicWork(now = new Date()): Promise<void> {
  await syncMissedBankSmsBestEffort();
  try {
    await sendSpendingSummariesIfDue(now);
  } catch (error) {
    if (__DEV__) console.warn('debug: Spending summary failed', error);
  }
  try {
    await checkAndNotifyBudgetAlerts();
  } catch (error) {
    if (__DEV__) console.warn('debug: Budget alert check failed', error);
  }
  try {
    await runScheduledDriveBackup(now);
  } catch (error) {
    if (__DEV__) console.warn('debug: Scheduled Drive backup failed', error);
  }
}

// Task definitions must run at module load so the OS can start them headlessly.
TaskManager.defineTask(PERIODIC_TASK, async () => {
  try {
    await runPeriodicWork();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (error) {
    if (__DEV__) console.warn('debug: Periodic background task failed', error);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

TaskManager.defineTask<unknown>(NOTIFICATION_RESPONSE_TASK, async ({ data, error }) => {
  if (error || !data || typeof data !== 'object') return;
  // Action buttons pressed while the app is not running arrive as a notification response.
  const candidate = data as Partial<Notifications.NotificationResponse>;
  if (typeof candidate.actionIdentifier === 'string' && candidate.notification) {
    await handleNotificationResponse(candidate as Notifications.NotificationResponse);
  }
});

registerSmsHeadlessTask();

export async function registerBackgroundTasks(): Promise<void> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status === BackgroundTask.BackgroundTaskStatus.Available) {
      if (!(await TaskManager.isTaskRegisteredAsync(PERIODIC_TASK))) {
        await BackgroundTask.registerTaskAsync(PERIODIC_TASK, { minimumInterval: 15 });
      }
    }
  } catch (error) {
    if (__DEV__) console.warn('debug: Failed to register periodic task', error);
  }
  if (Platform.OS === 'web') return;
  try {
    if (!(await TaskManager.isTaskRegisteredAsync(NOTIFICATION_RESPONSE_TASK))) {
      await Notifications.registerTaskAsync(NOTIFICATION_RESPONSE_TASK);
    }
  } catch (error) {
    if (__DEV__) console.warn('debug: Failed to register notification task', error);
  }
}
