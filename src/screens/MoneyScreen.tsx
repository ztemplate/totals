import { useRoute, type RouteProp } from '@react-navigation/native';
import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AmountText, CategoryIcon, counterpartyOf, groupByDay, TransactionRow } from '../components/finance';
import { Card, Chip, EmptyState, IconButton, Icon, ListRow, SegmentedControl, Sheet, TextField } from '../components/ui';
import { isReimbursementCategory, type Category } from '../models/category';
import { selectedCategoryIds, txDate, txIncludesCategory, type Transaction } from '../models/transaction';
import { useAppNavigation, type TabParamList } from '../navigation/types';
import { smsService } from '../services/smsService';
import { isSelfTransfer } from '../services/spendingSummary';
import { useData } from '../store/dataStore';
import { useSettings, useTheme } from '../store/settingsStore';
import { spacing } from '../theme/colors';
import { CASH_BANK_ID } from '../utils/cashConstants';
import { formatMonth, relativeDayLabel } from '../utils/format';
import { transactionIncomeAmount, transactionNetExpenseAmount } from '../utils/transactionAmounts';

type Flow = 'all' | 'income' | 'expense';

/** Sentinel for the "Uncategorized" filter. */
const UNCATEGORIZED = -1;

export function MoneyScreen() {
  const colors = useTheme();
  const navigation = useAppNavigation();
  const route = useRoute<RouteProp<TabParamList, 'Money'>>();
  const calendar = useSettings((s) => s.calendar);
  const { transactions, banksWithCash, categories, selfTransferReferences, selfCategoryIds, reimbursedByExpense } = useData();

  const [flow, setFlow] = useState<Flow>(route.params?.flow ?? 'all');
  const [bankId, setBankId] = useState<number | null>(route.params?.bankId ?? null);
  const [categoryFilter, setCategoryFilter] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [categorySheet, setCategorySheet] = useState(false);
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  // Deep links from Home (e.g. "Details" on spending) override the current filters.
  useEffect(() => {
    if (route.params?.flow) setFlow(route.params.flow);
    if (route.params?.bankId !== undefined) setBankId(route.params.bankId);
  }, [route.params]);

  useEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={{ flexDirection: 'row', marginRight: spacing.sm }}>
          <IconButton name="search" onPress={() => setSearchOpen((v) => !v)} accessibilityLabel="Search" />
          <IconButton name="filter-list" onPress={() => setCategorySheet(true)} accessibilityLabel="Filter by category" />
        </View>
      ),
    });
  }, [navigation]);

  const banksInUse = useMemo(() => {
    const ids = new Set(transactions.map((t) => t.bankId).filter((id): id is number => id != null));
    return banksWithCash.filter((b) => ids.has(b.id));
  }, [transactions, banksWithCash]);

  const isSelf = (tx: Transaction) =>
    isSelfTransfer(tx, selfTransferReferences, selfCategoryIds) && !(tx.bankId === CASH_BANK_ID && tx.type === 'DEBIT');

  const categoriesById = useMemo(() => new Map(categories.map((c) => [c.id ?? -1, c])), [categories]);

  const excludedFromIncome = (tx: Transaction) =>
    selectedCategoryIds(tx).some((id) => isReimbursementCategory(categoriesById.get(id)));

  const monthTransactions = useMemo(
    () =>
      transactions.filter((tx) => {
        const d = txDate(tx);
        return !!d && d.getFullYear() === month.getFullYear() && d.getMonth() === month.getMonth();
      }),
    [transactions, month],
  );

  const scoped = useMemo(
    () => monthTransactions.filter((tx) => bankId === null || tx.bankId === bankId),
    [monthTransactions, bankId],
  );

  const totals = useMemo(() => {
    let income = 0;
    let expense = 0;
    for (const tx of scoped) {
      const self = isSelf(tx);
      income += transactionIncomeAmount(tx, { isSelfTransfer: self, excludeFromIncome: excludedFromIncome(tx) });
      expense += transactionNetExpenseAmount(tx, {
        isSelfTransfer: self,
        reimbursedAmount: reimbursedByExpense.get(tx.reference.trim()) ?? 0,
      });
    }
    return { income, expense, net: income - expense };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, selfTransferReferences, selfCategoryIds, reimbursedByExpense, categoriesById]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return scoped.filter((tx) => {
      if (flow === 'income' && tx.type !== 'CREDIT') return false;
      if (flow === 'expense' && tx.type !== 'DEBIT') return false;
      if (categoryFilter === UNCATEGORIZED && selectedCategoryIds(tx).length > 0) return false;
      if (categoryFilter !== null && categoryFilter !== UNCATEGORIZED && !txIncludesCategory(tx, categoryFilter)) return false;
      if (!q) return true;
      const haystack = [counterpartyOf(tx), tx.reference, tx.note, tx.creditor, tx.receiver, String(tx.amount)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [scoped, flow, categoryFilter, query]);

  const sections = useMemo(() => groupByDay(visible), [visible]);
  const selectedCategory = categoryFilter !== null && categoryFilter !== UNCATEGORIZED ? categoriesById.get(categoryFilter) : null;

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await smsService.syncTodayBankSms();
    } catch (error) {
      if (__DEV__) console.warn('debug: Pull-to-refresh SMS sync failed', error);
    }
    await useData.getState().refresh();
    setRefreshing(false);
  };

  const shiftMonth = (delta: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1));
  const now = new Date();
  const isCurrentMonth = month.getFullYear() === now.getFullYear() && month.getMonth() === now.getMonth();

  const header = (
    <View style={{ gap: spacing.md, paddingBottom: spacing.sm }}>
      <View style={styles.monthRow}>
        <IconButton name="chevron-left" onPress={() => shiftMonth(-1)} accessibilityLabel="Previous month" />
        <Text style={[styles.monthLabel, { color: colors.text }]}>{formatMonth(month)}</Text>
        <IconButton
          name="chevron-right"
          onPress={() => !isCurrentMonth && shiftMonth(1)}
          color={isCurrentMonth ? colors.textMuted : colors.text}
          accessibilityLabel="Next month"
        />
      </View>

      <Card style={styles.totals}>
        <Total label="Income" value={totals.income} color={colors.income} />
        <View style={[styles.totalDivider, { backgroundColor: colors.border }]} />
        <Total label="Expense" value={totals.expense} color={colors.expense} />
        <View style={[styles.totalDivider, { backgroundColor: colors.border }]} />
        <Total label="Net" value={totals.net} color={totals.net >= 0 ? colors.income : colors.expense} />
      </Card>

      <SegmentedControl<Flow>
        options={[
          { value: 'all', label: 'All' },
          { value: 'income', label: 'Income' },
          { value: 'expense', label: 'Expense' },
        ]}
        value={flow}
        onChange={setFlow}
      />

      {searchOpen ? (
        <TextField
          placeholder="Search name, reference, note or amount"
          value={query}
          onChangeText={setQuery}
          autoFocus
          returnKeyType="search"
        />
      ) : null}

      {banksInUse.length > 1 || categoryFilter !== null ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
          {categoryFilter !== null ? (
            <Chip
              label={selectedCategory?.name ?? 'Uncategorized'}
              icon="close"
              selected
              color={colors.info}
              onPress={() => setCategoryFilter(null)}
            />
          ) : null}
          {banksInUse.length > 1 ? (
            <>
              <Chip label="All banks" selected={bankId === null} onPress={() => setBankId(null)} />
              {banksInUse.map((bank) => (
                <Chip
                  key={bank.id}
                  label={bank.shortName || bank.name}
                  selected={bankId === bank.id}
                  onPress={() => setBankId(bankId === bank.id ? null : bank.id)}
                />
              ))}
            </>
          ) : null}
        </ScrollView>
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <FlatList
        data={sections}
        keyExtractor={(item) => item.key}
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl * 2, gap: spacing.md }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={header}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.primary} />}
        ListEmptyComponent={
          <EmptyState
            icon="receipt-long"
            title="No transactions"
            message={query || categoryFilter !== null || bankId !== null ? 'Try clearing the filters.' : `Nothing recorded in ${formatMonth(month)}.`}
          />
        }
        renderItem={({ item }) => {
          const dayNet = item.items.reduce((sum, tx) => {
            const self = isSelf(tx);
            return (
              sum +
              transactionIncomeAmount(tx, { isSelfTransfer: self, excludeFromIncome: excludedFromIncome(tx) }) -
              transactionNetExpenseAmount(tx, {
                isSelfTransfer: self,
                reimbursedAmount: reimbursedByExpense.get(tx.reference.trim()) ?? 0,
              })
            );
          }, 0);
          return (
            <View style={{ gap: spacing.xs }}>
              <View style={styles.dayHeader}>
                <Text style={[styles.dayLabel, { color: colors.textSecondary }]}>
                  {item.date ? relativeDayLabel(item.date, calendar) : 'Unknown date'}
                </Text>
                <AmountText
                  value={Math.abs(dayNet)}
                  sign={dayNet >= 0 ? '+' : '-'}
                  compact
                  color={colors.textSecondary}
                  style={{ fontSize: 12 }}
                />
              </View>
              <Card style={{ paddingVertical: spacing.xs, paddingHorizontal: spacing.md }}>
                {item.items.map((tx) => (
                  <TransactionRow
                    key={tx.reference}
                    tx={tx}
                    onPress={() => navigation.navigate('TransactionDetail', { reference: tx.reference })}
                  />
                ))}
              </Card>
            </View>
          );
        }}
      />

      <Sheet visible={categorySheet} onClose={() => setCategorySheet(false)} title="Filter by category">
        <ListRow
          title="All categories"
          icon="select-all"
          right={categoryFilter === null ? <Icon name="check" color={colors.primary} /> : null}
          onPress={() => {
            setCategoryFilter(null);
            setCategorySheet(false);
          }}
        />
        <ListRow
          title="Uncategorized"
          icon="help-outline"
          right={categoryFilter === UNCATEGORIZED ? <Icon name="check" color={colors.primary} /> : null}
          onPress={() => {
            setCategoryFilter(UNCATEGORIZED);
            setCategorySheet(false);
          }}
        />
        {(['expense', 'income'] as const).map((f) => (
          <View key={f}>
            <Text style={[styles.sheetGroup, { color: colors.textSecondary }]}>{f === 'expense' ? 'EXPENSE' : 'INCOME'}</Text>
            {categories
              .filter((c: Category) => c.flow === f && c.id != null)
              .map((c) => (
                <ListRow
                  key={c.id!}
                  title={c.name}
                  left={<CategoryIcon category={c} size={32} />}
                  right={categoryFilter === c.id ? <Icon name="check" color={colors.primary} /> : null}
                  onPress={() => {
                    setCategoryFilter(c.id!);
                    setCategorySheet(false);
                  }}
                />
              ))}
          </View>
        ))}
      </Sheet>
    </View>
  );
}

function Total(props: { label: string; value: number; color: string }) {
  const colors = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', gap: 2 }}>
      <Text style={{ color: colors.textSecondary, fontSize: 12 }}>{props.label}</Text>
      <AmountText value={props.value} compact color={props.color} style={{ fontWeight: '700', fontSize: 15 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  monthRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  monthLabel: { fontSize: 17, fontWeight: '700' },
  totals: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.md, paddingHorizontal: spacing.sm },
  totalDivider: { width: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
  dayHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.xs },
  dayLabel: { fontSize: 13, fontWeight: '600' },
  sheetGroup: { fontSize: 12, fontWeight: '700', marginTop: spacing.md, letterSpacing: 0.8 },
});
