import { useIsFocused } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { hasSmsPermission, isSmsSupported, requestSmsPermission } from '../../modules/sms-reader';
import { confirm, showError } from '../components/dialogs';
import { CategoryIcon } from '../components/finance';
import {
  Button,
  Card,
  Chip,
  Divider,
  EmptyState,
  Icon,
  IconButton,
  ListRow,
  Loading,
  Pill,
  Screen,
  SectionTitle,
  SegmentedControl,
  Sheet,
  TextField,
  ToggleRow,
  styles as ui,
} from '../components/ui';
import { resetDatabase } from '../db/database';
import {
  CATEGORY_ICON_KEYS,
  categoryIconName,
  categoryTypeLabel,
  isManagedCategory,
  isReimbursementCategory,
  type Category,
  type CategoryFlow,
} from '../models/category';
import type { AutoCategoryPromptDismissal, AutoCategoryRule, FailedParse } from '../models/misc';
import { useAppNavigation, type StackScreenProps } from '../navigation/types';
import { categoryRepository } from '../repositories/categoryRepository';
import { failedParseRepository } from '../repositories/failedParseRepository';
import { profileRepository } from '../repositories/profileRepository';
import { appLock } from '../services/appLock';
import { autoCategorization } from '../services/autoCategorization';
import { exportAndShareBackup, pickAndImportBackup } from '../services/backup';
import { notificationService, type NotificationHistoryEntry } from '../services/notifications';
import { notificationSettings } from '../services/notificationSettings';
import { smsConfigService } from '../services/smsConfigService';
import { smsService, startSmsListener, type ParseStatus } from '../services/smsService';
import { spendingSummary } from '../services/spendingSummary';
import { notifyDataChanged, useData } from '../store/dataStore';
import { useSettings, useTheme, type ThemeMode } from '../store/settingsStore';
import { categoryColor, categoryColors, spacing } from '../theme/colors';
import { formatDate, formatDateTime } from '../utils/format';
import type { CalendarKind } from '../utils/periodUtils';

const APP_VERSION = '1.4.4';

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const CALENDAR_OPTIONS: { value: CalendarKind; label: string }[] = [
  { value: 'gregorian', label: 'Gregorian' },
  { value: 'ethiopian', label: 'Ethiopian' },
];

const FLOW_OPTIONS: { value: CategoryFlow; label: string }[] = [
  { value: 'expense', label: 'Expense' },
  { value: 'income', label: 'Income' },
];

type CategoryWithId = Category & { id: number };

function hasId(category: Category): category is CategoryWithId {
  return category.id != null;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

// ------------------------------------------------------------------ settings tab

type BusyAction = 'lock' | 'sms' | 'sync' | 'patterns' | 'export' | 'import' | 'reset';

export function SettingsScreen() {
  const colors = useTheme();
  const navigation = useAppNavigation();
  const isFocused = useIsFocused();
  const { themeMode, calendar, hideBalances, setThemeMode, setCalendar, setHideBalances } = useSettings();
  const { profiles, activeProfileId, accounts, categories, version } = useData();
  const [lockEnabled, setLockEnabled] = useState(false);
  const [failedCount, setFailedCount] = useState(0);
  const [patternCount, setPatternCount] = useState<number | null>(null);
  const [smsGranted, setSmsGranted] = useState(() => hasSmsPermission());
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const smsSupported = isSmsSupported();
  const activeProfile = profiles.find((p) => p.id === activeProfileId) ?? null;

  useEffect(() => {
    if (!isFocused) return;
    let cancelled = false;
    Promise.all([appLock.isEnabled(), failedParseRepository.count(), smsConfigService.patternCount()])
      .then(([lock, failed, patterns]) => {
        if (cancelled) return;
        setLockEnabled(lock);
        setFailedCount(failed);
        setPatternCount(patterns);
        setSmsGranted(hasSmsPermission());
      })
      .catch((error) => {
        if (__DEV__) console.warn('debug: Failed to load settings state', error);
      });
    return () => {
      cancelled = true;
    };
  }, [version, isFocused]);

  const run = useCallback(async (action: BusyAction, errorTitle: string, task: () => Promise<void>) => {
    setBusy(action);
    try {
      await task();
    } catch (error) {
      showError(errorTitle, error);
    } finally {
      setBusy(null);
    }
  }, []);

  const toggleLock = (value: boolean) =>
    void run('lock', 'App lock', async () => {
      if (await appLock.setEnabled(value)) {
        setLockEnabled(value);
        return;
      }
      const availability = await appLock.getAvailability();
      Alert.alert(
        'App lock',
        !availability.hasHardware && !availability.isEnrolled
          ? 'Set up a screen lock (PIN, pattern, password or biometrics) on this device first.'
          : 'Authentication was not completed, so app lock was not changed.',
      );
    });

  const requestSms = () =>
    void run('sms', 'SMS permission', async () => {
      const granted = await requestSmsPermission();
      setSmsGranted(granted || hasSmsPermission());
      if (granted) {
        // Boot only starts the listener when permission was already granted.
        startSmsListener(() => notifyDataChanged());
        return;
      }
      Alert.alert('SMS permission', 'Totals needs SMS access to read bank messages. You can allow it from system settings.');
    });

  const syncToday = () =>
    void run('sync', 'SMS sync', async () => {
      const result = await smsService.syncTodayBankSms();
      if (result.permissionDenied) {
        Alert.alert('SMS sync', 'Allow SMS access first.');
        return;
      }
      const lines = [
        `Checked ${result.processed} bank message${result.processed === 1 ? '' : 's'} from today.`,
        `Added: ${result.added}`,
        `Already recorded: ${result.duplicates}`,
        `No matching pattern: ${result.noPattern}`,
        result.skipped > 0 ? `Skipped: ${result.skipped}` : null,
        result.errors > 0 ? `Errors: ${result.errors}` : null,
      ];
      Alert.alert('SMS sync', lines.filter(Boolean).join('\n'));
    });

  const refreshPatterns = () =>
    void run('patterns', 'SMS patterns', async () => {
      const count = await smsConfigService.refreshPatternsFromInternet();
      setPatternCount(count);
      Alert.alert('SMS patterns', `Downloaded ${count} patterns.`);
    });

  const exportBackup = () =>
    void run('export', 'Export failed', async () => {
      await exportAndShareBackup();
    });

  const importBackup = async () => {
    const ok = await confirm(
      'Import backup',
      'Data from the backup is added to what you already have. Existing transactions are kept and duplicates are skipped.',
      'Choose file',
    );
    if (!ok) return;
    await run('import', 'Import failed', async () => {
      const summary = await pickAndImportBackup();
      if (!summary) return;
      Alert.alert(
        'Import complete',
        `Added ${summary.transactions} transactions, ${summary.accounts} accounts, ${summary.budgets} budgets and ${summary.categories} categories.`,
      );
    });
  };

  const deleteAllData = async () => {
    const ok = await confirm(
      'Delete all data',
      'This permanently deletes every transaction, account, budget, loan, rule and custom category on this device. Export a backup first if you might need it.',
      'Delete everything',
      true,
    );
    if (!ok) return;
    await run('reset', 'Could not delete data', async () => {
      await resetDatabase();
      await notificationService.clearNotificationHistory();
      notifyDataChanged();
      Alert.alert('Delete all data', 'All data was deleted.');
    });
  };

  const spinner = (action: BusyAction) => (busy === action ? <ActivityIndicator color={colors.primary} /> : undefined);

  return (
    <Screen>
      <SectionTitle title="Appearance" />
      <Card style={styles.cardGap}>
        <Text style={[styles.label, { color: colors.textSecondary }]}>Theme</Text>
        <SegmentedControl options={THEME_OPTIONS} value={themeMode} onChange={(mode) => void setThemeMode(mode)} />
        <Text style={[styles.label, { color: colors.textSecondary }]}>Calendar</Text>
        <SegmentedControl options={CALENDAR_OPTIONS} value={calendar} onChange={(kind) => void setCalendar(kind)} />
        <ToggleRow
          title="Hide balances"
          subtitle="Mask amounts until you tap to reveal"
          icon="visibility-off"
          value={hideBalances}
          onValueChange={(hidden) => void setHideBalances(hidden)}
        />
      </Card>

      <SectionTitle title="Security" />
      <Card>
        <ToggleRow
          title="App lock"
          subtitle="Require biometrics or your device PIN to open Totals"
          icon="lock"
          value={lockEnabled}
          disabled={busy === 'lock'}
          onValueChange={toggleLock}
        />
      </Card>

      <SectionTitle title="Your data" />
      <Card>
        <ListRow
          title="Profiles"
          subtitle={activeProfile ? `Active: ${activeProfile.name}` : null}
          icon="person"
          chevron
          onPress={() => navigation.navigate('Profiles')}
        />
        <Divider />
        <ListRow
          title="Accounts"
          subtitle={`${accounts.length} registered`}
          icon="account-balance"
          chevron
          onPress={() => navigation.navigate('Accounts')}
        />
        <Divider />
        <ListRow
          title="Categories"
          subtitle={`${categories.length} categories`}
          icon="category"
          chevron
          onPress={() => navigation.navigate('Categories')}
        />
        <Divider />
        <ListRow
          title="Auto-categorization"
          subtitle="Rules learned from the people and merchants you pay"
          icon="auto-awesome"
          chevron
          onPress={() => navigation.navigate('AutoCategorization')}
        />
        <Divider />
        <ListRow
          title="People"
          subtitle="Who you send money to and receive from"
          icon="people"
          chevron
          onPress={() => navigation.navigate('People')}
        />
        <Divider />
        <ListRow
          title="Loans & debts"
          subtitle="Money you lent or borrowed"
          icon="request-quote"
          chevron
          onPress={() => navigation.navigate('Loans', undefined)}
        />
      </Card>

      <SectionTitle title="SMS" />
      <Card>
        {smsSupported ? (
          <>
            <ListRow
              title="SMS access"
              subtitle={smsGranted ? 'Bank messages are read automatically' : 'Tap to allow reading bank messages'}
              icon="sms"
              onPress={smsGranted ? undefined : requestSms}
              right={
                spinner('sms') ?? (
                  <Pill label={smsGranted ? 'Allowed' : 'Off'} color={smsGranted ? colors.income : colors.warning} />
                )
              }
            />
            <Divider />
            <ListRow
              title="Sync today's bank SMS"
              subtitle="Import bank messages received since midnight"
              icon="sync"
              disabled={busy !== null}
              onPress={syncToday}
              right={spinner('sync')}
            />
            <Divider />
          </>
        ) : (
          <>
            <ListRow
              title="SMS reading unavailable"
              subtitle="Reading bank SMS needs an Android development or release build."
              icon="sms"
              disabled
            />
            <Divider />
          </>
        )}
        <ListRow
          title="Refresh SMS patterns"
          subtitle={patternCount === null ? 'Download the latest bank message formats' : `${patternCount} patterns installed`}
          icon="cloud-download"
          disabled={busy !== null}
          onPress={refreshPatterns}
          right={spinner('patterns')}
        />
        <Divider />
        <ListRow
          title="Failed SMS parses"
          subtitle="Bank messages Totals could not read"
          icon="sms-failed"
          value={failedCount > 0 ? String(failedCount) : undefined}
          chevron
          onPress={() => navigation.navigate('FailedParses')}
        />
      </Card>

      <SectionTitle title="Notifications" />
      <Card>
        <ListRow
          title="Notification settings"
          subtitle="Alerts, summaries and quick categorize"
          icon="notifications"
          chevron
          onPress={() => navigation.navigate('NotificationSettings')}
        />
        <Divider />
        <ListRow
          title="Notification history"
          icon="history"
          chevron
          onPress={() => navigation.navigate('NotificationHistory')}
        />
      </Card>

      <SectionTitle title="Backup" />
      <Card>
        <ListRow
          title="Export data"
          subtitle="Save a JSON backup you can import later"
          icon="file-upload"
          disabled={busy !== null}
          onPress={exportBackup}
          right={spinner('export')}
        />
        <Divider />
        <ListRow
          title="Import data"
          subtitle="Restore from a Totals backup file"
          icon="file-download"
          disabled={busy !== null}
          onPress={() => void importBackup()}
          right={spinner('import')}
        />
      </Card>

      <SectionTitle title="Danger zone" />
      <Card>
        <ListRow
          title="Delete all data"
          subtitle="Remove everything stored on this device"
          icon="delete-forever"
          destructive
          disabled={busy !== null}
          onPress={() => void deleteAllData()}
          right={spinner('reset')}
        />
      </Card>

      <View style={styles.about}>
        <Text style={[styles.brand, { color: colors.primary }]}>Totals</Text>
        <Text style={{ color: colors.textMuted }}>Version {APP_VERSION}</Text>
      </View>
    </Screen>
  );
}

// ------------------------------------------------------------------ categories

function emptyCategory(flow: CategoryFlow): Category {
  return {
    id: null,
    name: '',
    essential: false,
    uncategorized: false,
    iconKey: null,
    colorKey: null,
    description: '',
    flow,
    recurring: false,
    builtIn: false,
    builtInKey: null,
  };
}

export function CategoriesScreen({ navigation }: StackScreenProps<'Categories'>) {
  const colors = useTheme();
  const { categories } = useData();
  const [flow, setFlow] = useState<CategoryFlow>('expense');
  const [editor, setEditor] = useState<{ original: Category | null; draft: Category } | null>(null);
  const [saving, setSaving] = useState(false);

  const openNew = useCallback(() => setEditor({ original: null, draft: emptyCategory(flow) }), [flow]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: 'Categories',
      headerRight: () => <IconButton name="add" accessibilityLabel="Add category" onPress={openNew} />,
    });
  }, [navigation, openNew]);

  const visible = useMemo(() => categories.filter((c) => c.flow === flow), [categories, flow]);

  const update = (patch: Partial<Category>) => setEditor((e) => (e ? { ...e, draft: { ...e.draft, ...patch } } : e));

  const save = async () => {
    if (!editor) return;
    const { draft, original } = editor;
    const name = draft.name.trim();
    if (!name) {
      Alert.alert('Category', 'Enter a name.');
      return;
    }
    const duplicate = categories.some(
      (c) => c.id !== draft.id && c.flow === draft.flow && c.name.trim().toLowerCase() === name.toLowerCase(),
    );
    if (duplicate) {
      Alert.alert('Category', `An ${draft.flow} category named "${name}" already exists.`);
      return;
    }
    const description = draft.description?.trim() || null;
    setSaving(true);
    try {
      if (original) {
        await categoryRepository.updateCategory({ ...draft, name, description });
      } else {
        await categoryRepository.createCategory({
          name,
          essential: draft.essential,
          iconKey: draft.iconKey,
          colorKey: draft.colorKey,
          description,
          flow: draft.flow,
          recurring: draft.recurring,
        });
      }
      setEditor(null);
      notifyDataChanged();
    } catch (error) {
      showError('Could not save category', error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const target = editor?.original;
    if (!target || target.builtIn) return;
    const ok = await confirm(
      'Delete category',
      `Delete "${target.name}"? Transactions in it become uncategorized and budgets stop tracking it.`,
      'Delete',
      true,
    );
    if (!ok) return;
    try {
      await categoryRepository.deleteCategory(target);
      setEditor(null);
      notifyDataChanged();
    } catch (error) {
      showError('Could not delete category', error);
    }
  };

  const draft = editor?.draft ?? null;
  const accent = draft ? categoryColor(draft.colorKey, draft.id) : colors.primary;

  return (
    <Screen edges={['left', 'right', 'bottom']}>
      <SegmentedControl options={FLOW_OPTIONS} value={flow} onChange={setFlow} />
      {visible.length === 0 ? (
        <EmptyState
          icon="category"
          title={`No ${flow} categories`}
          action={{ label: 'Add category', onPress: openNew }}
        />
      ) : (
        <Card style={styles.listCard}>
          {visible.map((category, index) => (
            <React.Fragment key={category.id ?? category.name}>
              {index > 0 ? <Divider /> : null}
              <ListRow
                title={category.name}
                subtitle={[categoryTypeLabel(category), category.recurring ? 'Recurring' : null, category.description]
                  .filter(Boolean)
                  .join(' · ')}
                left={<CategoryIcon category={category} size={36} />}
                right={category.builtIn ? <Pill label="Built-in" color={colors.textMuted} /> : undefined}
                chevron
                onPress={() => setEditor({ original: category, draft: { ...category } })}
              />
            </React.Fragment>
          ))}
        </Card>
      )}

      <Sheet
        visible={editor !== null}
        onClose={() => setEditor(null)}
        title={editor?.original ? 'Edit category' : `New ${flow} category`}
      >
        {draft ? (
          <View style={styles.form}>
            <TextField
              label="Name"
              value={draft.name}
              onChangeText={(name) => update({ name })}
              placeholder={draft.flow === 'income' ? 'e.g. Freelance' : 'e.g. Coffee'}
              autoFocus={!editor?.original}
            />
            <ToggleRow
              title={draft.flow === 'income' ? 'Main income' : 'Essential'}
              subtitle={draft.flow === 'income' ? 'A primary, dependable source of income' : 'A need rather than a want'}
              value={draft.essential}
              disabled={draft.uncategorized}
              onValueChange={(essential) => update({ essential })}
            />
            <ToggleRow
              title="Recurring"
              subtitle="Expected regularly, like rent or salary"
              value={draft.recurring}
              onValueChange={(recurring) => update({ recurring })}
            />
            <Text style={[styles.label, { color: colors.textSecondary }]}>Icon</Text>
            <View style={ui.rowWrap}>
              {CATEGORY_ICON_KEYS.map((key) => {
                const selected = draft.iconKey === key;
                return (
                  <Pressable
                    key={key}
                    accessibilityLabel={key.replace(/_/g, ' ')}
                    onPress={() => update({ iconKey: key })}
                    style={[
                      styles.iconChoice,
                      { borderColor: selected ? accent : colors.border, backgroundColor: selected ? `${accent}22` : colors.surface },
                    ]}
                  >
                    <Icon name={categoryIconName(key)} size={22} color={selected ? accent : colors.textSecondary} />
                  </Pressable>
                );
              })}
            </View>
            <Text style={[styles.label, { color: colors.textSecondary }]}>Colour</Text>
            <View style={ui.rowWrap}>
              {Object.entries(categoryColors).map(([key, hex]) => {
                const selected = draft.colorKey === key;
                return (
                  <Pressable
                    key={key}
                    accessibilityLabel={key}
                    onPress={() => update({ colorKey: key })}
                    style={[styles.swatch, { backgroundColor: hex, borderColor: selected ? colors.text : 'transparent' }]}
                  >
                    {selected ? <Icon name="check" size={18} color="#FFFFFF" /> : null}
                  </Pressable>
                );
              })}
            </View>
            <TextField
              label="Description"
              value={draft.description ?? ''}
              onChangeText={(description) => update({ description })}
              placeholder="Optional"
              multiline
            />
            <Button title="Save" icon="check" loading={saving} onPress={() => void save()} />
            {editor?.original && !editor.original.builtIn ? (
              <Button title="Delete category" icon="delete-outline" variant="danger" onPress={() => void remove()} />
            ) : null}
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}

// ------------------------------------------------------------------ auto-categorization

interface RuleGroup {
  key: string;
  counterparty: string;
  flow: CategoryFlow;
  rules: AutoCategoryRule[];
}

interface RuleEditorState {
  group: RuleGroup;
  ids: number[];
  primary: number | null;
}

export function AutoCategorizationScreen() {
  const colors = useTheme();
  const { categories, version } = useData();
  const [enabled, setEnabled] = useState(true);
  const [promptEnabled, setPromptEnabled] = useState(true);
  const [rules, setRules] = useState<AutoCategoryRule[] | null>(null);
  const [dismissals, setDismissals] = useState<AutoCategoryPromptDismissal[]>([]);
  const [editing, setEditing] = useState<RuleEditorState | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      autoCategorization.isEnabled(),
      autoCategorization.isPromptEnabled(),
      autoCategorization.getRules(),
      autoCategorization.getDismissals(),
    ])
      .then(([isEnabled, isPromptEnabled, loadedRules, loadedDismissals]) => {
        if (cancelled) return;
        setEnabled(isEnabled);
        setPromptEnabled(isPromptEnabled);
        setRules(loadedRules);
        setDismissals(loadedDismissals);
      })
      .catch((error) => {
        if (__DEV__) console.warn('debug: Failed to load auto-categorization rules', error);
        if (!cancelled) setRules([]);
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  const categoryById = useMemo(() => {
    const map = new Map<number, Category>();
    for (const c of categories) if (c.id != null) map.set(c.id, c);
    return map;
  }, [categories]);

  const groups = useMemo(() => {
    const byKey = new Map<string, RuleGroup>();
    for (const rule of rules ?? []) {
      const key = `${rule.flow}|${rule.normalizedCounterparty}`;
      let group = byKey.get(key);
      if (!group) {
        group = { key, counterparty: rule.counterparty, flow: rule.flow, rules: [] };
        byKey.set(key, group);
      }
      group.rules.push(rule);
    }
    return [...byKey.values()];
  }, [rules]);

  const toggleEnabled = (value: boolean) => {
    setEnabled(value);
    void autoCategorization.setEnabled(value).catch((error) => showError('Could not save setting', error));
  };

  const togglePrompt = (value: boolean) => {
    setPromptEnabled(value);
    void autoCategorization.setPromptEnabled(value).catch((error) => showError('Could not save setting', error));
  };

  const openGroup = (group: RuleGroup) => {
    const ids = group.rules.map((r) => r.categoryId);
    setEditing({ group, ids, primary: group.rules.find((r) => r.isPrimary)?.categoryId ?? ids[0] ?? null });
  };

  const toggleCategory = (id: number) =>
    setEditing((e) => {
      if (!e) return e;
      if (e.ids.includes(id)) {
        const ids = e.ids.filter((v) => v !== id);
        return { ...e, ids, primary: e.primary === id ? (ids[0] ?? null) : e.primary };
      }
      return { ...e, ids: [...e.ids, id], primary: e.primary ?? id };
    });

  const makePrimary = (id: number) =>
    setEditing((e) => (e ? { ...e, ids: e.ids.includes(id) ? e.ids : [...e.ids, id], primary: id } : e));

  const deleteGroup = async (group: RuleGroup) => {
    const ok = await confirm(
      'Delete rule',
      `Stop auto-categorizing ${group.flow} transactions with "${group.counterparty}"?`,
      'Delete',
      true,
    );
    if (!ok) return;
    try {
      await autoCategorization.deleteRulesForCounterparty(group.counterparty, group.flow);
      setEditing(null);
      notifyDataChanged();
    } catch (error) {
      showError('Could not delete rule', error);
    }
  };

  const saveRules = async () => {
    if (!editing) return;
    if (editing.ids.length === 0) {
      await deleteGroup(editing.group);
      return;
    }
    setSaving(true);
    try {
      await autoCategorization.replaceRules({
        counterparty: editing.group.counterparty,
        flow: editing.group.flow,
        categoryIds: editing.ids,
        primaryCategoryId: editing.primary,
      });
      setEditing(null);
      notifyDataChanged();
    } catch (error) {
      showError('Could not save rule', error);
    } finally {
      setSaving(false);
    }
  };

  const clearDismissal = async (dismissal: AutoCategoryPromptDismissal) => {
    if (dismissal.id == null) return;
    try {
      await autoCategorization.clearPromptDismissalById(dismissal.id);
      notifyDataChanged();
    } catch (error) {
      showError('Could not update', error);
    }
  };

  const clearAll = async () => {
    const ok = await confirm(
      'Reset auto-categorization',
      'Delete every learned rule and turned-off prompt? Already categorized transactions are not changed.',
      'Reset',
      true,
    );
    if (!ok) return;
    try {
      await autoCategorization.clearAll();
      notifyDataChanged();
    } catch (error) {
      showError('Could not reset', error);
    }
  };

  if (rules === null) return <Loading />;

  const editorCategories = editing
    ? categories.filter(hasId).filter((c) => c.flow === editing.group.flow && !isManagedCategory(c))
    : [];

  const groupSubtitle = (group: RuleGroup) =>
    group.rules
      .map((rule) => {
        const name = categoryById.get(rule.categoryId)?.name ?? 'Deleted category';
        return rule.isPrimary && group.rules.length > 1 ? `${name} (primary)` : name;
      })
      .join(', ');

  return (
    <Screen edges={['left', 'right', 'bottom']}>
      <Card>
        <ToggleRow
          title="Auto-categorize"
          subtitle="Apply learned categories to new transactions"
          icon="auto-awesome"
          value={enabled}
          onValueChange={toggleEnabled}
        />
        <Divider />
        <ToggleRow
          title="Offer to create rules"
          subtitle="Ask after you categorize a transaction from someone new"
          icon="lightbulb-outline"
          value={promptEnabled}
          onValueChange={togglePrompt}
        />
      </Card>

      {groups.length === 0 ? (
        <EmptyState
          icon="rule"
          title="No rules yet"
          message="When you categorize a transaction, Totals can remember the category for that person or merchant."
        />
      ) : (
        (['expense', 'income'] as const).map((flow) => {
          const flowGroups = groups.filter((g) => g.flow === flow);
          if (flowGroups.length === 0) return null;
          return (
            <React.Fragment key={flow}>
              <SectionTitle title={flow === 'expense' ? 'Expense rules' : 'Income rules'} />
              <Card style={styles.listCard}>
                {flowGroups.map((group, index) => (
                  <React.Fragment key={group.key}>
                    {index > 0 ? <Divider /> : null}
                    <ListRow
                      title={group.counterparty}
                      subtitle={groupSubtitle(group)}
                      left={<CategoryIcon category={categoryById.get(group.rules[0].categoryId)} size={36} />}
                      onPress={() => openGroup(group)}
                      right={
                        <IconButton
                          name="delete-outline"
                          color={colors.textMuted}
                          accessibilityLabel={`Delete rule for ${group.counterparty}`}
                          onPress={() => void deleteGroup(group)}
                        />
                      }
                    />
                  </React.Fragment>
                ))}
              </Card>
            </React.Fragment>
          );
        })
      )}

      {dismissals.length > 0 ? (
        <>
          <SectionTitle title="Prompts turned off" />
          <Card style={styles.listCard}>
            {dismissals.map((dismissal, index) => (
              <React.Fragment key={dismissal.id ?? `${dismissal.flow}|${dismissal.normalizedCounterparty}`}>
                {index > 0 ? <Divider /> : null}
                <ListRow
                  title={dismissal.counterparty}
                  subtitle={dismissal.flow === 'income' ? 'Income' : 'Expense'}
                  icon="notifications-off"
                  right={
                    <Button
                      title="Ask again"
                      variant="ghost"
                      compact
                      onPress={() => void clearDismissal(dismissal)}
                    />
                  }
                />
              </React.Fragment>
            ))}
          </Card>
        </>
      ) : null}

      {groups.length > 0 || dismissals.length > 0 ? (
        <Button title="Reset auto-categorization" icon="restart-alt" variant="danger" onPress={() => void clearAll()} />
      ) : null}

      <Sheet visible={editing !== null} onClose={() => setEditing(null)} title={editing?.group.counterparty}>
        {editing ? (
          <View style={styles.form}>
            <Text style={{ color: colors.textSecondary }}>
              {editing.group.flow === 'income' ? 'Income from' : 'Payments to'} this counterparty get these categories. Tap
              to select, long-press to make a category primary.
            </Text>
            <View style={ui.rowWrap}>
              {editorCategories.map((category) => {
                const isPrimary = editing.primary === category.id;
                return (
                  <Chip
                    key={category.id}
                    label={category.name}
                    icon={isPrimary ? 'star' : categoryIconName(category.iconKey)}
                    color={categoryColor(category.colorKey, category.id)}
                    selected={editing.ids.includes(category.id)}
                    onPress={() => toggleCategory(category.id)}
                    onLongPress={() => makePrimary(category.id)}
                  />
                );
              })}
            </View>
            <Button
              title={editing.ids.length === 0 ? 'Delete rule' : 'Save'}
              icon={editing.ids.length === 0 ? 'delete-outline' : 'check'}
              variant={editing.ids.length === 0 ? 'danger' : 'primary'}
              loading={saving}
              onPress={() => void saveRules()}
            />
            {editing.ids.length > 0 ? (
              <Button
                title="Delete rule"
                icon="delete-outline"
                variant="ghost"
                onPress={() => void deleteGroup(editing.group)}
              />
            ) : null}
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}

// ------------------------------------------------------------------ profiles

export function ProfilesScreen({ navigation }: StackScreenProps<'Profiles'>) {
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const { profiles, activeProfileId, switchProfile } = useData();
  const [editor, setEditor] = useState<{ id: number | null; name: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: 'Profiles',
      headerRight: () => (
        <IconButton name="add" accessibilityLabel="Add profile" onPress={() => setEditor({ id: null, name: '' })} />
      ),
    });
  }, [navigation]);

  const activate = async (id: number) => {
    if (id === activeProfileId) return;
    try {
      await switchProfile(id);
    } catch (error) {
      showError('Could not switch profile', error);
    }
  };

  const save = async () => {
    if (!editor) return;
    const name = editor.name.trim();
    if (!name) {
      Alert.alert('Profile', 'Enter a name.');
      return;
    }
    setSaving(true);
    try {
      if (editor.id == null) await profileRepository.createProfile(name);
      else await profileRepository.renameProfile(editor.id, name);
      setEditor(null);
      notifyDataChanged();
    } catch (error) {
      showError('Could not save profile', error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (editor?.id == null) return;
    const id = editor.id;
    const name = profiles.find((p) => p.id === id)?.name ?? 'this profile';
    const ok = await confirm(
      'Delete profile',
      `Delete "${name}" with all of its accounts and transactions? This cannot be undone.`,
      'Delete',
      true,
    );
    if (!ok) return;
    try {
      if (!(await profileRepository.deleteProfile(id))) {
        Alert.alert('Delete profile', 'You need at least one profile.');
        return;
      }
      setEditor(null);
      notifyDataChanged();
    } catch (error) {
      showError('Could not delete profile', error);
    }
  };

  return (
    <Screen edges={['left', 'right', 'bottom']}>
      <Text style={{ color: colors.textSecondary }}>
        Each profile keeps its own accounts and transactions. Tap a profile to switch to it.
      </Text>
      <Card style={styles.listCard}>
        {profiles.map((profile, index) => {
          const active = profile.id === activeProfileId;
          return (
            <React.Fragment key={profile.id ?? profile.name}>
              {index > 0 ? <Divider /> : null}
              <ListRow
                title={profile.name}
                subtitle={active ? 'Active profile' : `Created ${formatDate(new Date(profile.createdAt), calendar)}`}
                icon={active ? 'check-circle' : 'person-outline'}
                iconColor={active ? colors.income : undefined}
                onPress={profile.id != null ? () => void activate(profile.id!) : undefined}
                right={
                  <IconButton
                    name="edit"
                    color={colors.textMuted}
                    accessibilityLabel={`Edit ${profile.name}`}
                    onPress={() => setEditor({ id: profile.id ?? null, name: profile.name })}
                  />
                }
              />
            </React.Fragment>
          );
        })}
      </Card>

      <Sheet
        visible={editor !== null}
        onClose={() => setEditor(null)}
        title={editor?.id == null ? 'New profile' : 'Edit profile'}
      >
        {editor ? (
          <View style={styles.form}>
            <TextField
              label="Name"
              value={editor.name}
              onChangeText={(name) => setEditor((e) => (e ? { ...e, name } : e))}
              placeholder="e.g. Business"
              autoFocus
            />
            <Button title="Save" icon="check" loading={saving} onPress={() => void save()} />
            {editor.id != null && profiles.length > 1 ? (
              <Button title="Delete profile" icon="delete-outline" variant="danger" onPress={() => void remove()} />
            ) : null}
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}

// ------------------------------------------------------------------ failed parses

function retryFailureMessage(status: ParseStatus): string {
  switch (status) {
    case 'noBank':
      return 'The sender is not a supported bank.';
    case 'unregisteredBank':
      return 'Register an account for this bank first.';
    case 'noPattern':
      return 'No SMS pattern matches this message yet. Try refreshing SMS patterns in Settings.';
    default:
      return 'The message could not be parsed.';
  }
}

export function FailedParsesScreen({ navigation }: StackScreenProps<'FailedParses'>) {
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const { version } = useData();
  const [items, setItems] = useState<FailedParse[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [retrying, setRetrying] = useState<number | 'all' | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  useLayoutEffect(() => {
    const clearAll = async () => {
      if (!(await confirm('Clear failed parses', 'Remove every message from this list?', 'Clear', true))) return;
      try {
        await failedParseRepository.clear();
        setReloadKey((k) => k + 1);
      } catch (error) {
        showError('Could not clear', error);
      }
    };
    navigation.setOptions({
      headerRight: () => (
        <IconButton name="delete-sweep" accessibilityLabel="Clear failed parses" onPress={() => void clearAll()} />
      ),
    });
  }, [navigation]);

  useEffect(() => {
    let cancelled = false;
    failedParseRepository
      .getAll()
      .then((loaded) => {
        if (!cancelled) setItems(loaded);
      })
      .catch((error) => {
        if (__DEV__) console.warn('debug: Failed to load failed parses', error);
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [version, reloadKey]);

  const retryOne = async (item: FailedParse) => {
    const date = new Date(item.timestamp);
    const result = await smsService.retryFailedParse(item.body, item.address, {
      messageDate: Number.isNaN(date.getTime()) ? null : date,
    });
    if ((result.status === 'success' || result.status === 'duplicate') && item.id != null) {
      await failedParseRepository.deleteById(item.id);
    }
    return result;
  };

  const retry = async (item: FailedParse) => {
    if (item.id == null || retrying !== null) return;
    setRetrying(item.id);
    try {
      const result = await retryOne(item);
      if (result.status === 'success') {
        Alert.alert('Retry', 'Transaction added.');
      } else if (result.status === 'duplicate') {
        Alert.alert('Retry', 'This transaction is already recorded, so it was removed from the list.');
      } else {
        Alert.alert('Still could not parse', result.reason || retryFailureMessage(result.status));
      }
    } catch (error) {
      showError('Retry failed', error);
    } finally {
      setRetrying(null);
      setReloadKey((k) => k + 1);
    }
  };

  const retryAll = async () => {
    if (!items || items.length === 0 || retrying !== null) return;
    setRetrying('all');
    let added = 0;
    let duplicates = 0;
    let failed = 0;
    try {
      for (const item of items) {
        try {
          const result = await retryOne(item);
          if (result.status === 'success') added++;
          else if (result.status === 'duplicate') duplicates++;
          else failed++;
        } catch (error) {
          failed++;
          if (__DEV__) console.warn('debug: Retry failed', error);
        }
      }
      Alert.alert('Retry all', `Added: ${added}\nAlready recorded: ${duplicates}\nStill failing: ${failed}`);
    } finally {
      setRetrying(null);
      setReloadKey((k) => k + 1);
    }
  };

  const remove = async (item: FailedParse) => {
    if (item.id == null) return;
    try {
      await failedParseRepository.deleteById(item.id);
      setReloadKey((k) => k + 1);
    } catch (error) {
      showError('Could not delete', error);
    }
  };

  const copy = async (item: FailedParse) => {
    await Clipboard.setStringAsync(item.body);
    Alert.alert('Copied', 'Message copied to the clipboard.');
  };

  if (items === null) return <Loading />;

  return (
    <Screen edges={['left', 'right', 'bottom']}>
      {items.length === 0 ? (
        <EmptyState icon="check-circle" title="Nothing to review" message="Bank messages that Totals cannot read show up here." />
      ) : (
        <>
          <View style={ui.rowCenter}>
            <Text style={[styles.flexText, { color: colors.textSecondary }]}>
              {items.length} message{items.length === 1 ? '' : 's'} could not be read
            </Text>
            <Button
              title="Retry all"
              icon="refresh"
              compact
              loading={retrying === 'all'}
              disabled={retrying !== null}
              onPress={() => void retryAll()}
            />
          </View>
          {items.map((item) => {
            const date = new Date(item.timestamp);
            const isExpanded = expanded === item.id;
            return (
              <Card key={item.id ?? `${item.timestamp}|${item.address}`} style={styles.cardGap}>
                <View style={ui.rowCenter}>
                  <Text style={[styles.itemTitle, { color: colors.text }]} numberOfLines={1}>
                    {item.address}
                  </Text>
                  {Number.isNaN(date.getTime()) ? null : (
                    <Text style={[styles.small, { color: colors.textMuted }]}>{formatDateTime(date, calendar)}</Text>
                  )}
                </View>
                <Text style={[styles.small, { color: colors.warning }]}>{item.reason}</Text>
                <Text
                  style={{ color: colors.textSecondary }}
                  numberOfLines={isExpanded ? undefined : 4}
                  onPress={() => setExpanded(isExpanded ? null : (item.id ?? null))}
                >
                  {item.body}
                </Text>
                <View style={ui.rowWrap}>
                  <Button
                    title="Retry"
                    icon="refresh"
                    compact
                    loading={retrying === item.id}
                    disabled={retrying !== null}
                    onPress={() => void retry(item)}
                  />
                  <Button title="Copy" icon="content-copy" variant="secondary" compact onPress={() => void copy(item)} />
                  <Button title="Delete" icon="delete-outline" variant="ghost" compact onPress={() => void remove(item)} />
                </View>
              </Card>
            );
          })}
        </>
      )}
    </Screen>
  );
}

// ------------------------------------------------------------------ notification settings

type ToggleGroup = 'alerts' | 'summaries';

interface NotificationToggle {
  key: string;
  group: ToggleGroup;
  title: string;
  subtitle: string;
  icon: string;
  get: () => Promise<boolean>;
  set: (value: boolean) => Promise<unknown>;
}

const NOTIFICATION_TOGGLES: NotificationToggle[] = [
  {
    key: 'transactions',
    group: 'alerts',
    title: 'Transactions',
    subtitle: 'When a new bank transaction is detected',
    icon: 'receipt-long',
    get: notificationSettings.isTransactionNotificationsEnabled,
    set: notificationSettings.setTransactionNotificationsEnabled,
  },
  {
    key: 'failedParseReview',
    group: 'alerts',
    title: 'Unread bank messages',
    subtitle: 'Ask whether an unrecognized bank SMS was a transaction',
    icon: 'sms-failed',
    get: notificationSettings.isFailedParseReviewNotificationsEnabled,
    set: notificationSettings.setFailedParseReviewNotificationsEnabled,
  },
  {
    key: 'budgets',
    group: 'alerts',
    title: 'Budget alerts',
    subtitle: 'When a budget is close to or over its limit',
    icon: 'pie-chart',
    get: notificationSettings.isBudgetAlertsEnabled,
    set: notificationSettings.setBudgetAlertsEnabled,
  },
  {
    key: 'sharedExpenses',
    group: 'alerts',
    title: 'Shared expenses',
    subtitle: 'Settle-up reminders for shared groups',
    icon: 'groups',
    get: notificationSettings.isSharedExpenseNotificationsEnabled,
    set: notificationSettings.setSharedExpenseNotificationsEnabled,
  },
  {
    key: 'loanDebt',
    group: 'alerts',
    title: 'Loan & debt reminders',
    subtitle: 'On the day money is due back',
    icon: 'request-quote',
    get: notificationSettings.isLoanDebtReturnRemindersEnabled,
    set: notificationSettings.setLoanDebtReturnRemindersEnabled,
  },
  {
    key: 'daily',
    group: 'summaries',
    title: 'Daily summary',
    subtitle: "Today's spending, at the time below",
    icon: 'today',
    get: notificationSettings.isDailySummaryEnabled,
    set: notificationSettings.setDailySummaryEnabled,
  },
  {
    key: 'weekly',
    group: 'summaries',
    title: 'Weekly summary',
    subtitle: "This week's spending",
    icon: 'date-range',
    get: notificationSettings.isWeeklySummaryEnabled,
    set: notificationSettings.setWeeklySummaryEnabled,
  },
  {
    key: 'monthly',
    group: 'summaries',
    title: 'Monthly summary',
    subtitle: "This month's spending",
    icon: 'calendar-month',
    get: notificationSettings.isMonthlySummaryEnabled,
    set: notificationSettings.setMonthlySummaryEnabled,
  },
];

type TestKind = 'transaction' | 'daily' | 'weekly' | 'monthly';

export function NotificationSettingsScreen() {
  const colors = useTheme();
  const { categories } = useData();
  const [values, setValues] = useState<Record<string, boolean> | null>(null);
  const [permission, setPermission] = useState(false);
  const [hour, setHour] = useState('20');
  const [minute, setMinute] = useState('00');
  const [quickIncome, setQuickIncome] = useState<number[]>([]);
  const [quickExpense, setQuickExpense] = useState<number[]>([]);
  const [testing, setTesting] = useState<TestKind | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(NOTIFICATION_TOGGLES.map(async (t) => [t.key, await t.get()] as const));
      const [time, income, expense, granted] = await Promise.all([
        notificationSettings.getDailySummaryTime(),
        notificationSettings.getQuickCategorizeIncomeIds(),
        notificationSettings.getQuickCategorizeExpenseIds(),
        notificationService.hasPermission(),
      ]);
      if (cancelled) return;
      setValues(Object.fromEntries(entries));
      setHour(pad2(time.hour));
      setMinute(pad2(time.minute));
      setQuickIncome(income);
      setQuickExpense(expense);
      setPermission(granted);
    })().catch((error) => {
      if (__DEV__) console.warn('debug: Failed to load notification settings', error);
      if (!cancelled) setValues({});
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setToggle = (toggle: NotificationToggle, value: boolean) => {
    setValues((v) => ({ ...v, [toggle.key]: value }));
    void toggle.set(value).catch((error) => showError('Could not save setting', error));
  };

  const requestPermission = async () => {
    const granted = await notificationService.requestPermissions();
    setPermission(granted);
    if (granted) return;
    if (await confirm('Notifications are off', 'Allow notifications for Totals in system settings?', 'Open settings')) {
      void Linking.openSettings();
    }
  };

  const saveTime = async () => {
    const h = Number(hour);
    const m = Number(minute);
    if (!Number.isInteger(h) || h < 0 || h > 23 || !Number.isInteger(m) || m < 0 || m > 59) {
      Alert.alert('Daily summary', 'Enter a time between 00:00 and 23:59.');
      return;
    }
    try {
      await notificationSettings.setDailySummaryTime({ hour: h, minute: m });
      setHour(pad2(h));
      setMinute(pad2(m));
      Alert.alert('Daily summary', `The daily summary will arrive around ${pad2(h)}:${pad2(m)}.`);
    } catch (error) {
      showError('Could not save time', error);
    }
  };

  const toggleQuick = (flow: CategoryFlow, id: number) => {
    const current = flow === 'income' ? quickIncome : quickExpense;
    let next: number[];
    if (current.includes(id)) {
      next = current.filter((v) => v !== id);
    } else if (current.length >= 3) {
      Alert.alert('Quick categorize', 'Pick up to 3 categories. Deselect one first.');
      return;
    } else {
      next = [...current, id];
    }
    const persist =
      flow === 'income' ? notificationSettings.setQuickCategorizeIncomeIds : notificationSettings.setQuickCategorizeExpenseIds;
    if (flow === 'income') setQuickIncome(next);
    else setQuickExpense(next);
    void persist(next).catch((error) => showError('Could not save setting', error));
  };

  const runTest = async (kind: TestKind) => {
    setTesting(kind);
    try {
      let shown: boolean;
      switch (kind) {
        case 'transaction':
          shown = await notificationService.showTestTransactionNotification();
          if (shown) notifyDataChanged();
          break;
        case 'daily':
          shown = await notificationService.showDailySpendingSummary({
            amount: await spendingSummary.getTodaySpending(),
            ignoreEnabledCheck: true,
            test: true,
          });
          break;
        case 'weekly':
          shown = await notificationService.showWeeklySpendingSummary({
            amount: await spendingSummary.getCurrentWeekSpending(),
            ignoreEnabledCheck: true,
            test: true,
          });
          break;
        case 'monthly':
          shown = await notificationService.showMonthlySpendingSummary({
            amount: await spendingSummary.getCurrentMonthSpending(),
            ignoreEnabledCheck: true,
            test: true,
          });
          break;
      }
      if (!shown) Alert.alert('Test notification', 'Notifications are not allowed. Allow them first.');
    } catch (error) {
      showError('Test notification failed', error);
    } finally {
      setTesting(null);
    }
  };

  if (values === null) return <Loading />;

  const quickCandidates = (flow: CategoryFlow) =>
    categories.filter(hasId).filter((c) => c.flow === flow && !c.uncategorized && !isReimbursementCategory(c));

  const renderToggles = (group: ToggleGroup) =>
    NOTIFICATION_TOGGLES.filter((t) => t.group === group).map((toggle, index) => (
      <React.Fragment key={toggle.key}>
        {index > 0 ? <Divider /> : null}
        <ToggleRow
          title={toggle.title}
          subtitle={toggle.subtitle}
          icon={toggle.icon}
          value={values[toggle.key] ?? false}
          onValueChange={(value) => setToggle(toggle, value)}
        />
      </React.Fragment>
    ));

  return (
    <Screen edges={['left', 'right', 'bottom']}>
      <Card style={styles.cardGap}>
        <ListRow
          title="Notification permission"
          subtitle={permission ? 'Totals can show notifications' : 'Notifications are blocked'}
          icon={permission ? 'notifications-active' : 'notifications-off'}
          right={<Pill label={permission ? 'Allowed' : 'Off'} color={permission ? colors.income : colors.warning} />}
        />
        {permission ? null : <Button title="Allow notifications" icon="notifications" onPress={() => void requestPermission()} />}
      </Card>

      <SectionTitle title="Alerts" />
      <Card style={styles.listCard}>{renderToggles('alerts')}</Card>

      <SectionTitle title="Spending summaries" />
      <Card style={styles.listCard}>
        {renderToggles('summaries')}
        <Divider />
        <View style={[ui.rowCenter, styles.timeRow]}>
          <Text style={[styles.flexText, { color: colors.text }]}>Daily summary time</Text>
          <TextField
            value={hour}
            onChangeText={setHour}
            keyboardType="number-pad"
            maxLength={2}
            accessibilityLabel="Hour"
            style={styles.timeInput}
          />
          <Text style={{ color: colors.text, fontWeight: '700' }}>:</Text>
          <TextField
            value={minute}
            onChangeText={setMinute}
            keyboardType="number-pad"
            maxLength={2}
            accessibilityLabel="Minute"
            style={styles.timeInput}
          />
          <Button title="Save" compact variant="secondary" onPress={() => void saveTime()} />
        </View>
      </Card>

      <SectionTitle title="Quick categorize" />
      <Card style={styles.cardGap}>
        <Text style={{ color: colors.textSecondary }}>
          Up to 3 categories shown as buttons on transaction notifications.
        </Text>
        {(['expense', 'income'] as const).map((flow) => {
          const selected = flow === 'income' ? quickIncome : quickExpense;
          return (
            <View key={flow} style={styles.cardGap}>
              <Text style={[styles.label, { color: colors.textSecondary }]}>
                {flow === 'income' ? 'Money in' : 'Money out'} ({selected.length}/3)
              </Text>
              <View style={ui.rowWrap}>
                {quickCandidates(flow).map((category) => (
                  <Chip
                    key={category.id}
                    label={category.name}
                    icon={categoryIconName(category.iconKey)}
                    color={categoryColor(category.colorKey, category.id)}
                    selected={selected.includes(category.id)}
                    onPress={() => toggleQuick(flow, category.id)}
                  />
                ))}
              </View>
            </View>
          );
        })}
      </Card>

      <SectionTitle title="Test" />
      <Card style={styles.cardGap}>
        <Text style={{ color: colors.textSecondary }}>
          The test transaction is saved as a small cash expense so you can try the notification actions.
        </Text>
        <View style={ui.rowWrap}>
          <Button
            title="Transaction"
            icon="receipt-long"
            compact
            variant="secondary"
            loading={testing === 'transaction'}
            disabled={testing !== null}
            onPress={() => void runTest('transaction')}
          />
          <Button
            title="Daily"
            compact
            variant="secondary"
            loading={testing === 'daily'}
            disabled={testing !== null}
            onPress={() => void runTest('daily')}
          />
          <Button
            title="Weekly"
            compact
            variant="secondary"
            loading={testing === 'weekly'}
            disabled={testing !== null}
            onPress={() => void runTest('weekly')}
          />
          <Button
            title="Monthly"
            compact
            variant="secondary"
            loading={testing === 'monthly'}
            disabled={testing !== null}
            onPress={() => void runTest('monthly')}
          />
        </View>
      </Card>
    </Screen>
  );
}

// ------------------------------------------------------------------ notification history

const CHANNEL_ICONS: Record<string, string> = {
  transactions: 'receipt-long',
  failed_parse_review: 'sms-failed',
  spending_summaries: 'insights',
  budgets: 'pie-chart',
  shared_expenses: 'groups',
  loan_debt_reminders: 'request-quote',
  account_sync_complete: 'sync',
  data_sync: 'cloud-done',
};

export function NotificationHistoryScreen({ navigation }: StackScreenProps<'NotificationHistory'>) {
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const { version } = useData();
  const [entries, setEntries] = useState<NotificationHistoryEntry[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useLayoutEffect(() => {
    const clear = async () => {
      if (!(await confirm('Clear history', 'Remove every entry from the notification history?', 'Clear', true))) return;
      try {
        await notificationService.clearNotificationHistory();
        setReloadKey((k) => k + 1);
      } catch (error) {
        showError('Could not clear history', error);
      }
    };
    navigation.setOptions({
      headerRight: () => (
        <IconButton name="delete-sweep" accessibilityLabel="Clear notification history" onPress={() => void clear()} />
      ),
    });
  }, [navigation]);

  useEffect(() => {
    let cancelled = false;
    notificationService
      .getNotificationHistory()
      .then((loaded) => {
        if (!cancelled) setEntries(loaded);
      })
      .catch((error) => {
        if (__DEV__) console.warn('debug: Failed to load notification history', error);
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [version, reloadKey]);

  const open = (entry: NotificationHistoryEntry) => {
    const reference = entry.transactionReference?.trim();
    if (!reference) return;
    if (entry.channel === 'loan_debt_reminders') navigation.navigate('Loans', { reference });
    else navigation.navigate('TransactionDetail', { reference });
  };

  if (entries === null) return <Loading />;

  return (
    <Screen edges={['left', 'right', 'bottom']}>
      {entries.length === 0 ? (
        <EmptyState icon="notifications-none" title="No notifications yet" message="Notifications Totals sends show up here." />
      ) : (
        entries.map((entry, index) => {
          const sentAt = new Date(entry.sentAt);
          return (
            <Card
              key={`${entry.sentAt}|${index}`}
              style={styles.cardGap}
              onPress={entry.transactionReference ? () => open(entry) : undefined}
            >
              <View style={ui.rowCenter}>
                <Icon name={CHANNEL_ICONS[entry.channel] ?? 'notifications'} size={20} color={colors.primary} />
                <Text style={[styles.itemTitle, { color: colors.text }]} numberOfLines={1}>
                  {entry.title}
                </Text>
                {entry.transactionReference ? <Icon name="chevron-right" color={colors.textMuted} /> : null}
              </View>
              <Text style={{ color: colors.textSecondary }}>{entry.body}</Text>
              {Number.isNaN(sentAt.getTime()) ? null : (
                <Text style={[styles.small, { color: colors.textMuted }]}>{formatDateTime(sentAt, calendar)}</Text>
              )}
            </Card>
          );
        })
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  cardGap: { gap: spacing.sm },
  listCard: { paddingVertical: spacing.xs },
  label: { fontSize: 13, fontWeight: '600' },
  form: { gap: spacing.md },
  iconChoice: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  swatch: { width: 36, height: 36, borderRadius: 18, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  itemTitle: { flex: 1, fontSize: 15, fontWeight: '600' },
  flexText: { flex: 1 },
  small: { fontSize: 12 },
  timeRow: { paddingVertical: spacing.sm, paddingHorizontal: spacing.xs },
  timeInput: { width: 52, textAlign: 'center' },
  about: { alignItems: 'center', gap: spacing.xs, marginTop: spacing.lg },
  brand: { fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
});
