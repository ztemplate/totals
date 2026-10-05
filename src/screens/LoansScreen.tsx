import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { showError } from '../components/dialogs';
import { AmountText, counterpartyOf } from '../components/finance';
import { Button, Card, Chip, EmptyState, Icon, ListRow, Pill, ProgressBar, Screen, SegmentedControl, styles as ui } from '../components/ui';
import type { LoanDebtDirection, LoanDebtStatus } from '../models/loanDebt';
import { txDate } from '../models/transaction';
import type { StackScreenProps } from '../navigation/types';
import { loanDebtRepository } from '../repositories/loanDebtRepository';
import { peopleRepository } from '../repositories/peopleRepository';
import { loadLoanDebtItems, type LoanDebtItem } from '../services/loanDebtSummary';
import { notifyDataChanged, useData } from '../store/dataStore';
import { useSettings, useTheme } from '../store/settingsStore';
import { spacing } from '../theme/colors';
import { startOfDay } from '../utils/dates';
import { formatDate, formatMoney } from '../utils/format';
import { personIdForLoanItem, type PeopleIndex } from '../utils/personMatching';

type StatusFilter = 'active' | 'resolved' | 'all';

interface PersonGroup {
  key: string;
  name: string;
  items: LoanDebtItem[];
  outstanding: number;
}

const STATUS_LABEL: Record<LoanDebtStatus, string> = {
  active: 'Active',
  settled: 'Settled',
  forgiven: 'Forgiven',
};

export function LoansScreen({ route, navigation }: StackScreenProps<'Loans'>) {
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const { transactions, version } = useData();
  const highlight = route.params?.reference?.trim() ?? null;

  const [items, setItems] = useState<LoanDebtItem[] | null>(null);
  const [direction, setDirection] = useState<LoanDebtDirection>('lent');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [expanded, setExpanded] = useState<string | null>(highlight);
  const [peopleIndex, setPeopleIndex] = useState<PeopleIndex | null>(null);

  useEffect(() => {
    let cancelled = false;
    peopleRepository
      .loadIndex()
      .then((index) => {
        if (!cancelled) setPeopleIndex(index);
      })
      .catch((error) => {
        if (__DEV__) console.warn('debug: Failed to load people', error);
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  useEffect(() => {
    let cancelled = false;
    loadLoanDebtItems(transactions)
      .then((loaded) => {
        if (cancelled) return;
        setItems(loaded);
        // Opening from a reminder: show the entry in its own tab, even if it is no longer active.
        const target = highlight ? loaded.find((i) => i.entry.transactionReference.trim() === highlight) : null;
        if (target) {
          setDirection(target.entry.direction);
          if (target.effectiveStatus !== 'active') setStatusFilter('all');
        }
      })
      .catch((error) => {
        if (__DEV__) console.warn('debug: Failed to load loans and debts', error);
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
    // Highlight only matters for the first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, version]);

  const totals = useMemo(() => {
    let lent = 0;
    let borrowed = 0;
    for (const item of items ?? []) {
      if (item.effectiveStatus !== 'active') continue;
      const open = item.remaining ?? 0;
      if (item.entry.direction === 'lent') lent += open;
      else borrowed += open;
    }
    return { lent, borrowed };
  }, [items]);

  const groups = useMemo<PersonGroup[]>(() => {
    const byPerson = new Map<string, PersonGroup>();
    for (const item of items ?? []) {
      if (item.entry.direction !== direction) continue;
      if (statusFilter === 'active' && item.effectiveStatus !== 'active') continue;
      if (statusFilter === 'resolved' && item.effectiveStatus === 'active') continue;
      const key = item.entry.personName.trim().toLowerCase();
      let group = byPerson.get(key);
      if (!group) {
        group = { key, name: item.entry.personName.trim() || 'Unknown', items: [], outstanding: 0 };
        byPerson.set(key, group);
      }
      group.items.push(item);
      if (item.effectiveStatus === 'active') group.outstanding += item.remaining ?? 0;
    }
    for (const group of byPerson.values()) {
      group.items.sort((a, b) => (itemDate(b)?.getTime() ?? 0) - (itemDate(a)?.getTime() ?? 0));
    }
    return [...byPerson.values()].sort((a, b) => b.outstanding - a.outstanding || a.name.localeCompare(b.name));
  }, [items, direction, statusFilter]);

  const setStatus = async (item: LoanDebtItem, status: LoanDebtStatus) => {
    try {
      await loanDebtRepository.updateEntryStatus({ transactionReference: item.entry.transactionReference, status });
      notifyDataChanged();
    } catch (error) {
      showError('Could not update', error);
    }
  };

  const showActions = (item: LoanDebtItem) => {
    const options: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = [];
    if (item.entry.status === 'active') {
      options.push({ text: 'Mark settled', onPress: () => void setStatus(item, 'settled') });
      options.push({
        text: item.entry.direction === 'lent' ? 'Forgive' : 'Mark forgiven',
        onPress: () => void setStatus(item, 'forgiven'),
      });
    } else {
      options.push({ text: 'Reopen', onPress: () => void setStatus(item, 'active') });
    }
    options.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert(item.entry.personName, 'Update this entry', options);
  };

  if (items === null) {
    return (
      <Screen edges={['left', 'right', 'bottom']}>
        <Text style={{ color: colors.textSecondary }}>Loading…</Text>
      </Screen>
    );
  }

  return (
    <Screen edges={['left', 'right', 'bottom']}>
      <View style={[ui.rowCenter, { gap: spacing.md }]}>
        <Card style={{ flex: 1, gap: 4 }}>
          <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Owed to you</Text>
          <AmountText value={totals.lent} color={colors.income} style={{ fontSize: 18, fontWeight: '700' }} compact />
        </Card>
        <Card style={{ flex: 1, gap: 4 }}>
          <Text style={{ color: colors.textSecondary, fontSize: 12 }}>You owe</Text>
          <AmountText value={totals.borrowed} color={colors.expense} style={{ fontSize: 18, fontWeight: '700' }} compact />
        </Card>
      </View>

      <SegmentedControl<LoanDebtDirection>
        options={[
          { value: 'lent', label: 'Lent' },
          { value: 'borrowed', label: 'Borrowed' },
        ]}
        value={direction}
        onChange={setDirection}
      />
      <View style={ui.rowWrap}>
        <Chip label="Active" selected={statusFilter === 'active'} onPress={() => setStatusFilter('active')} />
        <Chip label="Settled & forgiven" selected={statusFilter === 'resolved'} onPress={() => setStatusFilter('resolved')} />
        <Chip label="All" selected={statusFilter === 'all'} onPress={() => setStatusFilter('all')} />
      </View>

      {groups.length === 0 ? (
        <EmptyState
          icon="handshake"
          title={direction === 'lent' ? 'No loans here' : 'No debts here'}
          message={
            direction === 'lent'
              ? 'Mark a sent transaction with the "Loan" category to track who owes you.'
              : 'Mark a received transaction with the "Debt" category to track what you owe.'
          }
          action={{ label: 'Open transactions', onPress: () => navigation.navigate('Tabs', { screen: 'Money' }) }}
        />
      ) : null}

      {groups.map((group) => {
        const personId = peopleIndex && group.items[0] ? personIdForLoanItem(group.items[0], peopleIndex) : null;
        return (
          <Card key={group.key} style={{ gap: spacing.sm }}>
            <Pressable
              style={ui.rowCenter}
              disabled={personId === null}
              onPress={() => {
                if (personId !== null) navigation.navigate('PersonDetail', { personId });
              }}
            >
              <Icon name="person" color={colors.primary} />
              <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', flex: 1 }} numberOfLines={1}>
                {group.name}
              </Text>
              {group.outstanding > 0 ? (
                <AmountText
                  value={group.outstanding}
                  color={direction === 'lent' ? colors.income : colors.expense}
                  style={{ fontWeight: '700' }}
                />
              ) : null}
              {personId !== null ? <Icon name="chevron-right" color={colors.textMuted} /> : null}
            </Pressable>
            {group.items.map((item) => (
              <LoanItemRow
                key={item.entry.transactionReference}
                item={item}
                calendar={calendar}
                highlighted={item.entry.transactionReference.trim() === highlight}
                expanded={expanded === item.entry.transactionReference}
                onToggle={() =>
                  setExpanded((cur) => (cur === item.entry.transactionReference ? null : item.entry.transactionReference))
                }
                onActions={() => showActions(item)}
                onOpen={(reference) => navigation.push('TransactionDetail', { reference })}
              />
            ))}
          </Card>
        );
      })}
    </Screen>
  );
}

function itemDate(item: LoanDebtItem): Date | null {
  if (item.sourceTransaction) return txDate(item.sourceTransaction);
  const d = new Date(item.entry.createdAt);
  return Number.isNaN(d.getTime()) ? null : d;
}

function LoanItemRow(props: {
  item: LoanDebtItem;
  calendar: 'gregorian' | 'ethiopian';
  highlighted: boolean;
  expanded: boolean;
  onToggle: () => void;
  onActions: () => void;
  onOpen: (reference: string) => void;
}) {
  const colors = useTheme();
  const transactions = useData((s) => s.transactions);
  const { item } = props;
  const date = itemDate(item);
  const returnDate = item.entry.returnDate ? new Date(item.entry.returnDate) : null;
  const overdue =
    item.effectiveStatus === 'active' && returnDate !== null && returnDate.getTime() < startOfDay(new Date()).getTime();
  const progress = item.original ? item.repaid / item.original : 0;
  const statusColor =
    item.effectiveStatus === 'active' ? (overdue ? colors.expense : colors.info) : item.effectiveStatus === 'settled' ? colors.income : colors.textMuted;

  return (
    <View
      style={[
        {
          borderRadius: 12,
          padding: spacing.md,
          gap: spacing.sm,
          backgroundColor: props.highlighted ? colors.primarySoft : colors.surfaceMuted,
        },
      ]}
    >
      <ListRow
        title={item.original != null ? formatMoney(item.original) : 'Unknown amount'}
        subtitle={[
          date ? formatDate(date, props.calendar) : null,
          item.entry.source === 'repayment_surplus' ? 'From repayment surplus' : null,
          !item.transaction && item.sourceTransaction ? `Part of ${counterpartyOf(item.sourceTransaction)}` : null,
          returnDate ? `${overdue ? 'Overdue since' : 'Due'} ${formatDate(returnDate, props.calendar)}` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        right={<Pill label={overdue ? 'Overdue' : STATUS_LABEL[item.effectiveStatus]} color={statusColor} />}
        onPress={props.onToggle}
        onLongPress={props.onActions}
      />
      {item.original ? <ProgressBar progress={progress} color={colors.income} height={6} /> : null}
      <View style={[ui.rowCenter, { justifyContent: 'space-between' }]}>
        <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Repaid {formatMoney(item.repaid)}</Text>
        {item.remaining != null ? (
          <Text style={{ color: colors.text, fontSize: 12, fontWeight: '600' }}>Remaining {formatMoney(item.remaining)}</Text>
        ) : null}
      </View>

      {props.expanded ? (
        <View style={{ gap: spacing.xs }}>
          {item.repayments.length > 0 ? (
            item.repayments.map((r) => {
              const repayment = transactions.find((t) => t.reference === r.repaymentTransactionReference);
              const d = repayment ? txDate(repayment) : null;
              return (
                <ListRow
                  key={r.id ?? r.repaymentTransactionReference}
                  icon="replay"
                  title={repayment ? counterpartyOf(repayment) : 'Repayment'}
                  subtitle={d ? formatDate(d, props.calendar) : null}
                  value={formatMoney(r.appliedAmount)}
                  onPress={() => props.onOpen(r.repaymentTransactionReference)}
                />
              );
            })
          ) : (
            <Text style={{ color: colors.textMuted, fontSize: 12 }}>
              No repayments yet. Mark incoming or outgoing money with the "Repayment" category to apply it here.
            </Text>
          )}
          <View style={[ui.rowCenter, { justifyContent: 'flex-end' }]}>
            {item.sourceTransaction ? (
              <Button
                title={item.transaction ? 'Transaction' : 'Split payment'}
                variant="ghost"
                compact
                icon="receipt-long"
                onPress={() => props.onOpen(item.sourceTransaction!.reference)}
              />
            ) : null}
            {item.entry.status === 'active' ? (
              <Button title="Mark settled" variant="secondary" compact icon="check" onPress={props.onActions} />
            ) : (
              <Button title="Reopen" variant="secondary" compact icon="undo" onPress={props.onActions} />
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}
