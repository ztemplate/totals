import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Alert, RefreshControl, Text, View } from 'react-native';
import { confirm, showError } from '../components/dialogs';
import { AmountText, CategoryIcon } from '../components/finance';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  Icon,
  IconButton,
  ListRow,
  Pill,
  ProgressBar,
  Screen,
  SectionTitle,
  SegmentedControl,
  TextField,
  ToggleRow,
  styles as ui,
} from '../components/ui';
import {
  budgetFrame,
  budgetFrameLabel,
  budgetSelectedCategoryIds,
  type Budget,
  type BudgetStatus,
  type BudgetTimeFrame,
  type BudgetType,
} from '../models/budget';
import type { Category } from '../models/category';
import { useAppNavigation, type StackScreenProps } from '../navigation/types';
import { budgetRepository } from '../repositories/budgetRepository';
import { budgetService } from '../services/budgetService';
import { notifyDataChanged, useData } from '../store/dataStore';
import { useSettings, useTheme } from '../store/settingsStore';
import { spacing } from '../theme/colors';
import { formatDate, formatMoney, parseAmountInput } from '../utils/format';
import { periodStart } from '../utils/periodUtils';
import { IncomeView, PlannedSpendingView } from './PlanningScreens';

type BudgetView = 'main' | 'categories' | 'planned' | 'income';
type MainPeriod = 'daily' | 'monthly' | 'yearly';

const PERIOD_OPTIONS: { value: MainPeriod; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
];

function statusColor(status: BudgetStatus, colors: ReturnType<typeof useTheme>): string {
  if (status.isExceeded) return colors.expense;
  if (status.isApproachingLimit) return colors.warning;
  return colors.income;
}

export function BudgetScreen() {
  const colors = useTheme();
  const navigation = useAppNavigation();
  const calendar = useSettings((s) => s.calendar);
  const { categories, version } = useData();
  const [view, setView] = useState<BudgetView>('main');
  const [period, setPeriod] = useState<MainPeriod>('monthly');
  const [statuses, setStatuses] = useState<BudgetStatus[] | null>(null);
  const [inactive, setInactive] = useState<Budget[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Bumped by the header + button on the Planned and Income tabs, which open their own add sheets.
  const [addRequest, setAddRequest] = useState(0);
  const planning = view === 'planned' || view === 'income';

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <IconButton
          name="add"
          accessibilityLabel={view === 'planned' ? 'Add planned item' : view === 'income' ? 'Add' : 'Add budget'}
          onPress={() => (planning ? setAddRequest((n) => n + 1) : navigation.navigate('BudgetEdit', undefined))}
        />
      ),
    });
  }, [navigation, view, planning]);

  useEffect(() => {
    if (planning) {
      setRefreshing(false);
      return;
    }
    let cancelled = false;
    const load = async () => {
      const [loaded, all] = await Promise.all([
        view === 'main'
          ? budgetService.getBudgetStatusesByType(period, calendar)
          : budgetService.getCategoryBudgetStatuses(calendar),
        budgetRepository.getAllBudgets(calendar),
      ]);
      if (cancelled) return;
      setStatuses(loaded);
      setInactive(
        all.filter((b) => !b.isActive && (view === 'main' ? b.type === period : b.type === 'category')),
      );
    };
    load()
      .catch((error) => {
        if (__DEV__) console.warn('debug: Failed to load budgets', error);
        if (!cancelled) setStatuses([]);
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, planning, period, calendar, version, reloadKey]);

  const summary = useMemo(() => {
    let budgeted = 0;
    let spent = 0;
    for (const s of statuses ?? []) {
      budgeted += s.budget.amount;
      spent += s.spent;
    }
    return { budgeted, spent, remaining: budgeted - spent };
  }, [statuses]);

  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  const openNew = () => navigation.navigate('BudgetEdit', undefined);
  const openBudget = (budget: Budget) =>
    budget.id != null ? navigation.navigate('BudgetEdit', { budgetId: budget.id }) : undefined;

  const reactivate = async (budget: Budget) => {
    if (budget.id == null) return;
    try {
      await budgetRepository.activateBudget(budget.id);
      notifyDataChanged();
    } catch (error) {
      showError('Could not activate', error);
    }
  };

  const overallProgress = summary.budgeted > 0 ? summary.spent / summary.budgeted : 0;
  const overallColor =
    summary.spent > summary.budgeted ? colors.expense : overallProgress >= 0.8 ? colors.warning : colors.income;

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            setReloadKey((k) => k + 1);
          }}
          tintColor={colors.primary}
        />
      }
    >
      <SegmentedControl<BudgetView>
        options={[
          { value: 'main', label: 'Budgets' },
          { value: 'categories', label: 'Categories' },
          { value: 'planned', label: 'Planned' },
          { value: 'income', label: 'Income' },
        ]}
        value={view}
        onChange={setView}
      />
      {view === 'planned' ? <PlannedSpendingView addRequest={addRequest} /> : null}
      {view === 'income' ? <IncomeView addRequest={addRequest} /> : null}
      {planning ? null : (
        <>
          {view === 'main' ? (
            <View style={ui.rowWrap}>
              {PERIOD_OPTIONS.map((p) => (
                <Chip key={p.value} label={p.label} selected={period === p.value} onPress={() => setPeriod(p.value)} />
              ))}
            </View>
          ) : null}

          {statuses && statuses.length > 0 ? (
            <Card style={{ gap: spacing.sm }}>
              <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                {view === 'main' ? `${PERIOD_OPTIONS.find((p) => p.value === period)!.label} overview` : 'Category budgets'}
              </Text>
              <View style={[ui.rowCenter, { justifyContent: 'space-between' }]}>
                <View style={{ gap: 2 }}>
                  <Text style={{ color: colors.textMuted, fontSize: 12 }}>Spent</Text>
                  <AmountText value={summary.spent} style={{ fontSize: 20, fontWeight: '700' }} />
                </View>
                <View style={{ gap: 2, alignItems: 'flex-end' }}>
                  <Text style={{ color: colors.textMuted, fontSize: 12 }}>of budget</Text>
                  <AmountText value={summary.budgeted} color={colors.textSecondary} style={{ fontSize: 16, fontWeight: '600' }} />
                </View>
              </View>
              <ProgressBar progress={Math.min(1, overallProgress)} color={overallColor} />
              <Text style={{ color: summary.remaining < 0 ? colors.expense : colors.textSecondary, fontSize: 12 }}>
                {summary.remaining < 0
                  ? `Over budget by ${formatMoney(-summary.remaining)}`
                  : `${formatMoney(summary.remaining)} left`}
              </Text>
            </Card>
          ) : null}

          {statuses === null ? (
            <Text style={{ color: colors.textSecondary }}>Loading…</Text>
          ) : statuses.length === 0 ? (
            <EmptyState
              icon="savings"
              title={view === 'main' ? `No ${period} budget` : 'No category budgets'}
              message={
                view === 'main'
                  ? 'Set a spending limit for this period and Totals will track your expenses against it.'
                  : 'Limit spending on specific categories like food or transport.'
              }
              action={{ label: 'Create budget', onPress: openNew }}
            />
          ) : (
            <>
              <SectionTitle title="Active" />
              {statuses.map((status) => (
                <BudgetCard
                  key={status.budget.id ?? status.budget.name}
                  status={status}
                  calendar={calendar}
                  categories={budgetSelectedCategoryIds(status.budget)
                    .map((id) => categoryById.get(id))
                    .filter((c): c is Category => !!c)}
                  onPress={() => openBudget(status.budget)}
                />
              ))}
            </>
          )}

          {inactive.length > 0 ? (
            <>
              <SectionTitle title="Paused" />
              <Card>
                {inactive.map((budget) => (
                  <ListRow
                    key={budget.id ?? budget.name}
                    icon="pause-circle-outline"
                    title={budget.name}
                    subtitle={`${budgetFrameLabel(budget)} · ${formatMoney(budget.amount)}`}
                    onPress={() => openBudget(budget)}
                    right={<Button title="Resume" compact variant="secondary" onPress={() => void reactivate(budget)} />}
                  />
                ))}
              </Card>
            </>
          ) : null}

          {statuses && statuses.length > 0 ? (
            <Button title="Add budget" variant="secondary" icon="add" onPress={openNew} />
          ) : null}
        </>
      )}
    </Screen>
  );
}

function BudgetCard(props: {
  status: BudgetStatus;
  calendar: 'gregorian' | 'ethiopian';
  categories: Category[];
  onPress: () => void;
}) {
  const colors = useTheme();
  const { status } = props;
  const color = statusColor(status, colors);
  const frame = budgetFrame(status.budget);
  const daysLeft = Math.max(0, Math.ceil((status.periodEnd.getTime() - Date.now()) / 86_400_000));
  return (
    <Card onPress={props.onPress} style={{ gap: spacing.sm }}>
      <View style={ui.rowCenter}>
        {props.categories.length === 1 ? (
          <CategoryIcon category={props.categories[0]} size={36} />
        ) : (
          <Icon name={status.budget.type === 'category' ? 'category' : 'account-balance-wallet'} color={colors.primary} />
        )}
        <View style={{ flex: 1, marginLeft: spacing.sm }}>
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }} numberOfLines={1}>
            {status.budget.name}
          </Text>
          <Text style={{ color: colors.textSecondary, fontSize: 12 }} numberOfLines={1}>
            {[
              budgetFrameLabel(status.budget),
              props.categories.length > 1 ? props.categories.map((c) => c.name).join(', ') : null,
              status.budget.rollover ? 'Rollover' : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>
        {status.isExceeded ? (
          <Pill label="Exceeded" color={colors.expense} />
        ) : status.isApproachingLimit ? (
          <Pill label={`${Math.round(status.percentageUsed)}%`} color={colors.warning} />
        ) : null}
      </View>
      <ProgressBar progress={Math.min(1, status.percentageUsed / 100)} color={color} />
      <View style={[ui.rowCenter, { justifyContent: 'space-between' }]}>
        <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
          {formatMoney(status.spent)} of {formatMoney(status.budget.amount)}
        </Text>
        <Text style={{ color: status.remaining < 0 ? colors.expense : colors.text, fontSize: 12, fontWeight: '600' }}>
          {status.remaining < 0 ? `${formatMoney(-status.remaining)} over` : `${formatMoney(status.remaining)} left`}
        </Text>
      </View>
      <Text style={{ color: colors.textMuted, fontSize: 11 }}>
        {frame === 'never'
          ? `Since ${formatDate(status.periodStart, props.calendar)}`
          : `${formatDate(status.periodStart, props.calendar)} – ${formatDate(status.periodEnd, props.calendar)}${
              frame === 'daily' ? '' : ` · ${daysLeft} day${daysLeft === 1 ? '' : 's'} left`
            }`}
      </Text>
    </Card>
  );
}

const TYPE_OPTIONS: { value: BudgetType; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
  { value: 'category', label: 'Category' },
];

const TIME_FRAME_OPTIONS: { value: BudgetTimeFrame; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
  { value: 'never', label: 'No reset' },
];

const DEFAULT_NAMES: Record<Exclude<BudgetType, 'category'>, string> = {
  daily: 'Daily Budget',
  monthly: 'Monthly Budget',
  yearly: 'Yearly Budget',
};

function categoryBudgetName(selected: Category[]): string {
  if (selected.length === 0) return 'Category Budget';
  if (selected.length === 1) return `${selected[0].name} Budget`;
  return `${selected.map((c) => c.name).join(', ')} Budget`;
}

export function BudgetEditScreen({ route, navigation }: StackScreenProps<'BudgetEdit'>) {
  const colors = useTheme();
  const settingsCalendar = useSettings((s) => s.calendar);
  const categories = useData((s) => s.categories);
  const budgetId = route.params?.budgetId ?? null;

  const [original, setOriginal] = useState<Budget | null>(null);
  const [loading, setLoading] = useState(budgetId != null);
  const [type, setType] = useState<BudgetType>('monthly');
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [amount, setAmount] = useState('');
  const [threshold, setThreshold] = useState('80');
  const [rollover, setRollover] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [categoryIds, setCategoryIds] = useState<number[]>([]);
  const [timeFrame, setTimeFrame] = useState<BudgetTimeFrame>('monthly');
  const [saving, setSaving] = useState(false);

  const expenseCategories = useMemo(
    () => categories.filter((c) => c.flow === 'expense' && c.id != null),
    [categories],
  );
  const selectedCategories = useMemo(
    () => categoryIds.map((id) => categories.find((c) => c.id === id)).filter((c): c is Category => !!c),
    [categoryIds, categories],
  );

  useLayoutEffect(() => {
    navigation.setOptions({ title: budgetId != null ? 'Edit budget' : 'New budget' });
  }, [navigation, budgetId]);

  useEffect(() => {
    if (budgetId == null) return;
    let cancelled = false;
    budgetRepository
      .getBudgetById(budgetId)
      .then((budget) => {
        if (cancelled) return;
        if (!budget) {
          Alert.alert('Budget not found', 'It may have been deleted.');
          navigation.goBack();
          return;
        }
        setOriginal(budget);
        setType(budget.type);
        setName(budget.name);
        setNameEdited(true);
        setAmount(String(budget.amount));
        setThreshold(String(budget.alertThreshold));
        setRollover(budget.rollover);
        setIsActive(budget.isActive);
        setCategoryIds(budgetSelectedCategoryIds(budget));
        setTimeFrame(budget.timeFrame ?? 'monthly');
      })
      .catch((error) => showError('Could not load budget', error))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [budgetId, navigation]);

  // Keep the suggested name in sync until the user types their own.
  useEffect(() => {
    if (nameEdited) return;
    setName(type === 'category' ? categoryBudgetName(selectedCategories) : DEFAULT_NAMES[type]);
  }, [type, selectedCategories, nameEdited]);

  const parsedAmount = parseAmountInput(amount);
  const amountError = amount.trim() && (parsedAmount === null || parsedAmount <= 0) ? 'Enter a positive amount' : null;
  const parsedThreshold = parseAmountInput(threshold);
  const thresholdError =
    threshold.trim() && (parsedThreshold === null || parsedThreshold < 1 || parsedThreshold > 100)
      ? 'Between 1 and 100'
      : null;

  const toggleCategory = (id: number) =>
    setCategoryIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const buildBudget = (): Budget | null => {
    if (parsedAmount === null || parsedAmount <= 0) {
      Alert.alert('Amount required', 'Enter the spending limit for this budget.');
      return null;
    }
    if (parsedThreshold === null || parsedThreshold < 1 || parsedThreshold > 100) {
      Alert.alert('Invalid alert threshold', 'Use a percentage between 1 and 100.');
      return null;
    }
    if (type === 'category' && categoryIds.length === 0) {
      Alert.alert('Pick a category', 'Category budgets need at least one expense category.');
      return null;
    }
    const calendar = original?.calendar ?? settingsCalendar;
    const frame = type === 'category' ? timeFrame : type;
    const now = new Date();
    const sameShape =
      original != null &&
      original.type === type &&
      (type !== 'category' || (original.timeFrame ?? 'monthly') === timeFrame);
    const startDate = sameShape ? original!.startDate : periodStart(now, frame, calendar).toISOString();
    return {
      id: original?.id ?? null,
      name: name.trim() || (type === 'category' ? categoryBudgetName(selectedCategories) : DEFAULT_NAMES[type]),
      type,
      amount: parsedAmount,
      categoryId: type === 'category' ? categoryIds[0] ?? null : null,
      categoryIds: type === 'category' ? categoryIds : null,
      startDate,
      endDate: sameShape ? original!.endDate ?? null : null,
      rollover: type === 'category' ? false : rollover,
      alertThreshold: parsedThreshold,
      isActive,
      createdAt: original?.createdAt ?? now.toISOString(),
      updatedAt: original?.updatedAt ?? null,
      timeFrame: type === 'category' ? timeFrame : null,
      calendar,
    };
  };

  /** Monthly budgets that already covered earlier months can be changed for this month alone. */
  const spansPastMonths = (budget: Budget): boolean =>
    budgetFrame(budget) === 'monthly' &&
    new Date(budget.startDate).getTime() < periodStart(new Date(), 'monthly', budget.calendar).getTime();

  const askScope = (title: string, message: string, allLabel: string): Promise<'month' | 'all' | null> =>
    new Promise((resolve) => {
      Alert.alert(
        title,
        message,
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
          { text: 'This month only', onPress: () => resolve('month') },
          { text: allLabel, onPress: () => resolve('all') },
        ],
        { cancelable: true, onDismiss: () => resolve(null) },
      );
    });

  const save = async () => {
    const budget = buildBudget();
    if (!budget) return;
    setSaving(true);
    try {
      if (original?.id != null) {
        const keepsShape = original.type === budget.type && original.timeFrame === budget.timeFrame;
        const scope =
          keepsShape && spansPastMonths(original)
            ? await askScope(
                'Apply changes to',
                'This budget also covers earlier months. Keep past months as they were?',
                'All months',
              )
            : 'all';
        if (scope === null) return;
        if (scope === 'month') {
          await budgetRepository.updateBudgetForMonthOnly({
            originalBudget: original,
            editedBudget: budget,
            month: new Date(),
          });
        } else {
          await budgetRepository.updateBudget(budget);
        }
      } else {
        await budgetRepository.insertBudget(budget);
      }
      notifyDataChanged();
      navigation.goBack();
    } catch (error) {
      showError('Could not save budget', error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (original?.id == null) return;
    try {
      if (spansPastMonths(original)) {
        const scope = await askScope(
          'Delete budget',
          'Remove this budget for the current month only, or from this month onwards? Past months keep their history.',
          'This and future months',
        );
        if (scope === null) return;
        await budgetRepository.deleteBudgetForMonth({
          originalBudget: original,
          month: new Date(),
          deleteFutureBudgets: scope === 'all',
        });
      } else {
        const ok = await confirm('Delete budget', `Delete "${original.name}"? This cannot be undone.`, 'Delete', true);
        if (!ok) return;
        await budgetRepository.deleteBudget(original.id);
      }
      notifyDataChanged();
      navigation.goBack();
    } catch (error) {
      showError('Could not delete budget', error);
    }
  };

  if (loading) {
    return (
      <Screen edges={['left', 'right', 'bottom']}>
        <Text style={{ color: colors.textSecondary }}>Loading…</Text>
      </Screen>
    );
  }

  return (
    <Screen edges={['left', 'right', 'bottom']}>
      <SectionTitle title="Budget type" />
      <SegmentedControl<BudgetType> options={TYPE_OPTIONS} value={type} onChange={setType} />
      <Text style={{ color: colors.textMuted, fontSize: 12 }}>
        {type === 'category'
          ? 'Tracks spending in the selected categories only.'
          : `Tracks all expenses and resets every ${type === 'daily' ? 'day' : type === 'monthly' ? 'month' : 'year'}.`}
      </Text>

      {type === 'category' ? (
        <>
          <SectionTitle title="Categories" />
          <Card>
            {expenseCategories.length === 0 ? (
              <Text style={{ color: colors.textMuted }}>No expense categories yet. Add some in Settings → Categories.</Text>
            ) : (
              <View style={ui.rowWrap}>
                {expenseCategories.map((c) => (
                  <Chip
                    key={c.id!}
                    label={c.name}
                    selected={categoryIds.includes(c.id!)}
                    onPress={() => toggleCategory(c.id!)}
                  />
                ))}
              </View>
            )}
          </Card>
          <SectionTitle title="Resets" />
          <SegmentedControl<BudgetTimeFrame> options={TIME_FRAME_OPTIONS} value={timeFrame} onChange={setTimeFrame} />
        </>
      ) : null}

      <Card style={{ gap: spacing.md }}>
        <TextField
          label="Name"
          value={name}
          onChangeText={(text) => {
            setName(text);
            setNameEdited(text.trim().length > 0);
          }}
          placeholder="Budget name"
        />
        <TextField
          label="Amount (ETB)"
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder="0.00"
          error={amountError}
          style={{ fontSize: 20, fontWeight: '700' }}
        />
        <TextField
          label="Alert at (% used)"
          value={threshold}
          onChangeText={setThreshold}
          keyboardType="number-pad"
          placeholder="80"
          error={thresholdError}
        />
      </Card>

      {type !== 'category' || original ? (
      <Card>
        {type !== 'category' ? (
          <ToggleRow
            title="Roll over unused amount"
            subtitle="Carry what you did not spend into the next period"
            icon="redo"
            value={rollover}
            onValueChange={setRollover}
          />
        ) : null}
        {original ? (
          <ToggleRow
            title="Active"
            subtitle="Paused budgets are not tracked or alerted on"
            icon="toggle-on"
            value={isActive}
            onValueChange={setIsActive}
          />
        ) : null}
      </Card>
      ) : null}

      <Button
        title={original ? 'Save changes' : 'Create budget'}
        icon="check"
        onPress={() => void save()}
        loading={saving}
      />
      {original ? <Button title="Delete budget" variant="danger" icon="delete" onPress={() => void remove()} /> : null}
    </Screen>
  );
}
