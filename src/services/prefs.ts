import AsyncStorage from '@react-native-async-storage/async-storage';

/** Thin typed wrapper over AsyncStorage, mirroring SharedPreferences usage in Flutter. */
export const prefs = {
  async getString(key: string): Promise<string | null> {
    return AsyncStorage.getItem(key);
  },
  async setString(key: string, value: string): Promise<void> {
    await AsyncStorage.setItem(key, value);
  },
  async getBool(key: string, fallback = false): Promise<boolean> {
    const raw = await AsyncStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === 'true';
  },
  async setBool(key: string, value: boolean): Promise<void> {
    await AsyncStorage.setItem(key, value ? 'true' : 'false');
  },
  async getNumber(key: string): Promise<number | null> {
    const raw = await AsyncStorage.getItem(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  },
  async setNumber(key: string, value: number): Promise<void> {
    await AsyncStorage.setItem(key, String(value));
  },
  async getJson<T>(key: string): Promise<T | null> {
    const raw = await AsyncStorage.getItem(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },
  async setJson(key: string, value: unknown): Promise<void> {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  },
  async remove(key: string): Promise<void> {
    await AsyncStorage.removeItem(key);
  },
};

export const PrefKeys = {
  activeProfileId: 'active_profile_id',
  themeMode: 'theme_mode',
  calendar: 'calendar_mode',
  hideBalances: 'hide_balances',
  appLockEnabled: 'app_lock_enabled',
  onboardingComplete: 'onboarding_complete',
  notificationsEnabled: 'notifications_enabled',
  transactionNotifications: 'transaction_notifications_enabled',
  budgetAlertsEnabled: 'budget_alerts_enabled',
  dailySummaryEnabled: 'daily_summary_enabled',
  autoCategorizationEnabled: 'auto_categorization_enabled',
  autoCategorizationPromptEnabled: 'auto_categorization_prompt_enabled',
  lastPatternRefresh: 'last_pattern_refresh_iso',
  budgetAlertsSent: 'budget_alerts_sent',
  accountHubName: 'account_hub_display_name',
  homeHiddenBanks: 'home_hidden_banks',
  smsCatchupCursor: (profileId: number | null | undefined) =>
    `sms_last_catchup_epoch_ms_profile_${profileId ?? 'default'}`,
  smsLastScanAt: (profileId: number | null | undefined) =>
    `sms_last_inbox_scan_epoch_ms_profile_${profileId ?? 'default'}`,
  allBankHistoryImported: (profileId: number | null | undefined) =>
    `all_bank_sms_history_imported_profile_${profileId ?? 'default'}`,
  driveBackup: 'google_drive_backup_state',
  atmCashCutoff: (profileId: number | null | undefined) =>
    `atm_cash_transfer_cutoff_iso_profile_${profileId ?? 'default'}`,
};
