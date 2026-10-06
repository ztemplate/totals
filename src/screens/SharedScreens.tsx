import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Alert, RefreshControl, Text, View } from 'react-native';
import { DateField } from '../components/dateRange';
import { confirm, showError } from '../components/dialogs';
import { AmountText, counterpartyOf, sortByTimeDesc } from '../components/finance';
import {
  Button,
  Card,
  Chip,
  Divider,
  EmptyState,
  Icon,
  IconButton,
  ListRow,
  Pill,
  Screen,
  SectionTitle,
  SegmentedControl,
  Sheet,
  TextField,
  styles as ui,
} from '../components/ui';
import type { SharedExpense, SharedGroup, SharedSettlement } from '../models/misc';
import { isDebit, txDate, type Transaction } from '../models/transaction';
import { useAppNavigation, type StackScreenProps } from '../navigation/types';
import {
  computeBalances,
  equalSplits,
  SELF_MEMBER,
  sharedExpenseRepository,
  simplifyDebts,
  type MemberBalance,
  type SuggestedTransfer,
} from '../repositories/sharedExpenseRepository';
import { notifyDataChanged, useData } from '../store/dataStore';
import { useSettings, useTheme } from '../store/settingsStore';
import { spacing } from '../theme/colors';
import { parseDateInput, toDateInput } from '../utils/dates';
import { formatDate, formatMoney, initials, parseAmountInput } from '../utils/format';
import { transactionDebitOutflow } from '../utils/transactionAmounts';

const EPSILON = 0.005;

interface GroupOverview {
  group: SharedGroup;
  expenseCount: number;
  total: number;
  /** Positive: you are owed. Negative: you owe. */
  yourNet: number;
}

function parseMembers(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((m) => m.trim())
    .filter(Boolean);
}

function MemberAvatar(props: { name: string; size?: number }) {
  const colors = useTheme();
  const size = props.size ?? 32;
  const self = props.name === SELF_MEMBER;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: self ? colors.primary : colors.primarySoft,
      }}
    >
      <Text style={{ color: self ? colors.onPrimary : colors.primary, fontWeight: '700', fontSize: size * 0.38 }}>
        {initials(props.name)}
      </Text>
    </View>
  );
}

function GroupFormSheet(props: {
  visible: boolean;
  group: SharedGroup | null;
  onClose: () => void;
  onSaved: (groupId: number) => void;
}) {
  const colors = useTheme();
  const [name, setName] = useState('');
  const [members, setMembers] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!props.visible) return;
    setName(props.group?.name ?? '');
    setMembers((props.group?.members ?? []).filter((m) => m !== SELF_MEMBER).join(', '));
  }, [props.visible, props.group]);

  const save = async () => {
    if (!name.trim()) {
      Alert.alert('Name required', 'Give the group a name, like "Roommates" or "Trip to Bahir Dar".');
      return;
    }
    const list = parseMembers(members);
    if (list.length === 0) {
      Alert.alert('Add members', 'Add at least one other person to split expenses with.');
      return;
    }
    setSaving(true);
    try {
      if (props.group?.id != null) {
        // Members who already have expenses cannot disappear silently; keep them.
        const existing = await sharedExpenseRepository.getExpenses(props.group.id);
        const settlements = await sharedExpenseRepository.getSettlements(props.group.id);
        const used = new Set<string>();
        for (const e of existing) {
          used.add(e.paidBy);
          Object.keys(e.splits).forEach((m) => used.add(m));
        }
        for (const s of settlements) {
          used.add(s.from);
          used.add(s.to);
        }
        const lower = new Set(list.map((m) => m.toLowerCase()));
        const kept = [...used].filter((m) => m !== SELF_MEMBER && !lower.has(m.toLowerCase()));
        if (kept.length > 0) {
          Alert.alert('Some members kept', `${kept.join(', ')} still appear in expenses, so they stay in the group.`);
        }
        await sharedExpenseRepository.updateGroup({ ...props.group, name: name.trim(), members: [...list, ...kept] });
        props.onSaved(props.group.id);
      } else {
        const created = await sharedExpenseRepository.createGroup(name, list);
        props.onSaved(created.id!);
      }
      notifyDataChanged();
      props.onClose();
    } catch (error) {
      showError('Could not save group', error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet visible={props.visible} onClose={props.onClose} title={props.group ? 'Edit group' : 'New group'}>
      <View style={{ gap: spacing.md }}>
        <TextField label="Group name" value={name} onChangeText={setName} placeholder="Roommates" autoFocus />
        <TextField
          label="Members"
          value={members}
          onChangeText={setMembers}
          placeholder="Abebe, Sara, Dawit"
          multiline
          autoCapitalize="words"
        />
        <Text style={{ color: colors.textMuted, fontSize: 12 }}>
          Separate names with commas or new lines. You are added automatically as "{SELF_MEMBER}".
        </Text>
        <Button title={props.group ? 'Save' : 'Create group'} icon="check" onPress={() => void save()} loading={saving} />
      </View>
    </Sheet>
  );
}

export function SharedScreen() {
  const colors = useTheme();
  const navigation = useAppNavigation();
  const version = useData((s) => s.version);
  const [overviews, setOverviews] = useState<GroupOverview[] | null>(null);
  const [formVisible, setFormVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    const groups = await sharedExpenseRepository.getGroups();
    const result: GroupOverview[] = [];
    for (const group of groups) {
      if (group.id == null) continue;
      const [expenses, settlements] = await Promise.all([
        sharedExpenseRepository.getExpenses(group.id),
        sharedExpenseRepository.getSettlements(group.id),
      ]);
      const balances = computeBalances(group, expenses, settlements);
      result.push({
        group,
        expenseCount: expenses.length,
        total: expenses.reduce((s, e) => s + e.amount, 0),
        yourNet: balances.find((b) => b.member === SELF_MEMBER)?.net ?? 0,
      });
    }
    return result;
  }, []);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((loaded) => {
        if (!cancelled) setOverviews(loaded);
      })
      .catch((error) => {
        if (__DEV__) console.warn('debug: Failed to load shared groups', error);
        if (!cancelled) setOverviews([]);
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load, version, reloadKey]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => <IconButton name="group-add" accessibilityLabel="New group" onPress={() => setFormVisible(true)} />,
    });
  }, [navigation]);

  const totals = useMemo(() => {
    let owed = 0;
    let owe = 0;
    for (const o of overviews ?? []) {
      if (o.yourNet > EPSILON) owed += o.yourNet;
      else if (o.yourNet < -EPSILON) owe += -o.yourNet;
    }
    return { owed, owe };
  }, [overviews]);

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
      <View style={[ui.rowCenter, { gap: spacing.md }]}>
        <Card style={{ flex: 1, gap: 4 }}>
          <Text style={{ color: colors.textSecondary, fontSize: 12 }}>You are owed</Text>
          <AmountText value={totals.owed} color={colors.income} style={{ fontSize: 18, fontWeight: '700' }} compact />
        </Card>
        <Card style={{ flex: 1, gap: 4 }}>
          <Text style={{ color: colors.textSecondary, fontSize: 12 }}>You owe</Text>
          <AmountText value={totals.owe} color={colors.expense} style={{ fontSize: 18, fontWeight: '700' }} compact />
        </Card>
      </View>

      {overviews === null ? (
        <Text style={{ color: colors.textSecondary }}>Loading…</Text>
      ) : overviews.length === 0 ? (
        <EmptyState
          icon="groups"
          title="No shared groups yet"
          message="Create a group for roommates, trips or events to split expenses and see who owes whom."
          action={{ label: 'Create group', onPress: () => setFormVisible(true) }}
        />
      ) : (
        <>
          <SectionTitle title="Groups" action={{ label: 'New', onPress: () => setFormVisible(true) }} />
          {overviews.map((o) => (
            <Card key={o.group.id!} onPress={() => navigation.navigate('SharedGroup', { groupId: o.group.id! })}>
              <View style={ui.rowCenter}>
                <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="groups" color={colors.primary} />
                </View>
                <View style={{ flex: 1, marginLeft: spacing.sm }}>
                  <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }} numberOfLines={1}>
                    {o.group.name}
                  </Text>
                  <Text style={{ color: colors.textSecondary, fontSize: 12 }} numberOfLines={1}>
                    {o.group.members.length} members · {o.expenseCount} expense{o.expenseCount === 1 ? '' : 's'} ·{' '}
                    {formatMoney(o.total, { compact: true })}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  {Math.abs(o.yourNet) <= EPSILON ? (
                    <Pill label="Settled up" color={colors.textMuted} />
                  ) : (
                    <>
                      <Text style={{ color: colors.textMuted, fontSize: 11 }}>{o.yourNet > 0 ? 'you are owed' : 'you owe'}</Text>
                      <AmountText
                        value={Math.abs(o.yourNet)}
                        color={o.yourNet > 0 ? colors.income : colors.expense}
                        style={{ fontWeight: '700' }}
                      />
                    </>
                  )}
                </View>
              </View>
            </Card>
          ))}
        </>
      )}

      <GroupFormSheet
        visible={formVisible}
        group={null}
        onClose={() => setFormVisible(false)}
        onSaved={(groupId) => navigation.navigate('SharedGroup', { groupId })}
      />
    </Screen>
  );
}

type SplitMode = 'equal' | 'exact';

interface ExpenseDraft {
  existing: SharedExpense | null;
  transaction: Transaction | null;
}

function ExpenseFormSheet(props: {
  visible: boolean;
  group: SharedGroup;
  draft: ExpenseDraft;
  onClose: () => void;
  onPickTransaction: () => void;
}) {
  const colors = useTheme();
  const { group, draft } = props;
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(toDateInput(new Date()));
  const [paidBy, setPaidBy] = useState(SELF_MEMBER);
  const [participants, setParticipants] = useState<string[]>(group.members);
  const [mode, setMode] = useState<SplitMode>('equal');
  const [exact, setExact] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!props.visible) return;
    const e = draft.existing;
    const tx = draft.transaction;
    if (e) {
      setDescription(e.description);
      setAmount(String(e.amount));
      setDate(toDateInput(new Date(e.date)));
      setPaidBy(e.paidBy);
      const members = Object.keys(e.splits);
      setParticipants(members.length > 0 ? members : group.members);
      const equal = equalSplits(e.amount, members);
      const isEqual = members.every((m) => Math.abs((equal[m] ?? 0) - e.splits[m]) < 0.011);
      setMode(isEqual ? 'equal' : 'exact');
      setExact(Object.fromEntries(Object.entries(e.splits).map(([m, v]) => [m, String(v)])));
    } else {
      setDescription(tx ? counterpartyOf(tx) : '');
      setAmount(tx ? String(Math.round(transactionDebitOutflow(tx) * 100) / 100) : '');
      setDate(toDateInput(tx ? txDate(tx) ?? new Date() : new Date()));
      setPaidBy(SELF_MEMBER);
      setParticipants(group.members);
      setMode('equal');
      setExact({});
    }
  }, [props.visible, draft, group.members]);

  const parsedAmount = parseAmountInput(amount);
  const splits = useMemo<Record<string, number> | null>(() => {
    if (parsedAmount === null || parsedAmount <= 0 || participants.length === 0) return null;
    if (mode === 'equal') return equalSplits(parsedAmount, participants);
    const out: Record<string, number> = {};
    for (const m of participants) {
      const v = parseAmountInput(exact[m] ?? '');
      if (v === null || v < 0) return null;
      if (v > 0) out[m] = v;
    }
    return out;
  }, [parsedAmount, participants, mode, exact]);
  const splitTotal = splits ? Object.values(splits).reduce((s, v) => s + v, 0) : 0;
  const splitDiff = parsedAmount != null ? Math.round((parsedAmount - splitTotal) * 100) / 100 : 0;

  const toggleParticipant = (member: string) =>
    setParticipants((prev) => (prev.includes(member) ? prev.filter((m) => m !== member) : [...prev, member]));

  const save = async () => {
    if (!description.trim()) {
      Alert.alert('Description required', 'What was this expense for?');
      return;
    }
    if (parsedAmount === null || parsedAmount <= 0) {
      Alert.alert('Amount required', 'Enter a positive amount.');
      return;
    }
    const parsedDate = parseDateInput(date);
    if (!parsedDate) {
      Alert.alert('Date required', 'Pick the day of the expense.');
      return;
    }
    if (!splits || Object.keys(splits).length === 0) {
      Alert.alert('Check the split', 'Pick who shares this expense and enter valid amounts.');
      return;
    }
    if (Math.abs(splitDiff) > 0.01) {
      Alert.alert('Split does not add up', `The shares are ${formatMoney(Math.abs(splitDiff))} ${splitDiff > 0 ? 'short of' : 'over'} the total.`);
      return;
    }
    setSaving(true);
    try {
      const now = new Date();
      const isToday = toDateInput(parsedDate) === toDateInput(now);
      const when = isToday ? now : new Date(parsedDate.getFullYear(), parsedDate.getMonth(), parsedDate.getDate(), 12);
      await sharedExpenseRepository.saveExpense({
        id: draft.existing?.id ?? null,
        groupId: group.id!,
        description: description.trim(),
        amount: parsedAmount,
        paidBy,
        splits,
        transactionReference: draft.existing?.transactionReference ?? draft.transaction?.reference ?? null,
        date: draft.existing && toDateInput(new Date(draft.existing.date)) === toDateInput(parsedDate) ? draft.existing.date : when.toISOString(),
        createdAt: draft.existing?.createdAt ?? now.toISOString(),
        settled: draft.existing?.settled ?? false,
      });
      notifyDataChanged();
      props.onClose();
    } catch (error) {
      showError('Could not save expense', error);
    } finally {
      setSaving(false);
    }
  };

  const linkedReference = draft.existing?.transactionReference ?? draft.transaction?.reference ?? null;

  return (
    <Sheet visible={props.visible} onClose={props.onClose} title={draft.existing ? 'Edit expense' : 'Add expense'}>
      <View style={{ gap: spacing.md }}>
        {!draft.existing ? (
          <ListRow
            icon="link"
            title={draft.transaction ? `From ${counterpartyOf(draft.transaction)}` : 'Link a transaction'}
            subtitle={
              draft.transaction
                ? `${formatMoney(transactionDebitOutflow(draft.transaction))} · tap to change`
                : 'Prefill from a bank or cash expense'
            }
            onPress={props.onPickTransaction}
            chevron
          />
        ) : linkedReference ? (
          <Pill label="Linked to a transaction" color={colors.info} />
        ) : null}
        <TextField label="Description" value={description} onChangeText={setDescription} placeholder="Dinner, rent, taxi…" />
        <TextField
          label="Amount (ETB)"
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder="0.00"
          style={{ fontSize: 20, fontWeight: '700' }}
        />
        <DateField label="Date" value={parseDateInput(date)} onChange={(d) => setDate(d ? toDateInput(d) : '')} placeholder="Pick a date" />

        <Text style={{ color: colors.textSecondary, fontWeight: '600', fontSize: 13 }}>Paid by</Text>
        <View style={ui.rowWrap}>
          {group.members.map((m) => (
            <Chip key={m} label={m} selected={paidBy === m} onPress={() => setPaidBy(m)} />
          ))}
        </View>

        <Text style={{ color: colors.textSecondary, fontWeight: '600', fontSize: 13 }}>Split between</Text>
        <View style={ui.rowWrap}>
          {group.members.map((m) => (
            <Chip key={m} label={m} selected={participants.includes(m)} onPress={() => toggleParticipant(m)} />
          ))}
        </View>
        <SegmentedControl<SplitMode>
          options={[
            { value: 'equal', label: 'Equally' },
            { value: 'exact', label: 'Exact amounts' },
          ]}
          value={mode}
          onChange={setMode}
        />
        {mode === 'equal' ? (
          splits ? (
            <Text style={{ color: colors.textMuted, fontSize: 12 }}>
              {participants.length} {participants.length === 1 ? 'person' : 'people'} ·{' '}
              {formatMoney((parsedAmount ?? 0) / Math.max(1, participants.length))} each
            </Text>
          ) : null
        ) : (
          <View style={{ gap: spacing.sm }}>
            {participants.map((m) => (
              <View key={m} style={ui.rowCenter}>
                <MemberAvatar name={m} size={28} />
                <Text style={{ color: colors.text, flex: 1 }}>{m}</Text>
                <TextField
                  value={exact[m] ?? ''}
                  onChangeText={(v) => setExact((prev) => ({ ...prev, [m]: v }))}
                  keyboardType="decimal-pad"
                  placeholder="0.00"
                  containerStyle={{ width: 120 }}
                />
              </View>
            ))}
            <Text style={{ color: Math.abs(splitDiff) > 0.01 ? colors.expense : colors.textMuted, fontSize: 12 }}>
              {Math.abs(splitDiff) <= 0.01
                ? 'Shares add up to the total.'
                : `${formatMoney(Math.abs(splitDiff))} ${splitDiff > 0 ? 'left to assign' : 'over the total'}`}
            </Text>
          </View>
        )}
        <Button title={draft.existing ? 'Save changes' : 'Add expense'} icon="check" onPress={() => void save()} loading={saving} />
      </View>
    </Sheet>
  );
}

function TransactionPickerSheet(props: { visible: boolean; onClose: () => void; onPick: (tx: Transaction) => void }) {
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const transactions = useData((s) => s.transactions);
  const [query, setQuery] = useState('');
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sortByTimeDesc(transactions.filter(isDebit))
      .filter((tx) => !q || counterpartyOf(tx).toLowerCase().includes(q) || (tx.note ?? '').toLowerCase().includes(q))
      .slice(0, 60);
  }, [transactions, query]);
  return (
    <Sheet visible={props.visible} onClose={props.onClose} title="Pick an expense">
      <TextField value={query} onChangeText={setQuery} placeholder="Search" containerStyle={{ marginBottom: spacing.sm }} />
      {candidates.length === 0 ? (
        <Text style={{ color: colors.textMuted }}>No matching expenses.</Text>
      ) : (
        candidates.map((tx) => {
          const d = txDate(tx);
          return (
            <ListRow
              key={tx.reference}
              icon="receipt-long"
              title={counterpartyOf(tx)}
              subtitle={d ? formatDate(d, calendar) : null}
              value={formatMoney(transactionDebitOutflow(tx))}
              onPress={() => props.onPick(tx)}
            />
          );
        })
      )}
    </Sheet>
  );
}

function SettleSheet(props: {
  visible: boolean;
  group: SharedGroup;
  suggestion: SuggestedTransfer | null;
  onClose: () => void;
}) {
  const colors = useTheme();
  const [from, setFrom] = useState(SELF_MEMBER);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!props.visible) return;
    const s = props.suggestion;
    setFrom(s?.from ?? SELF_MEMBER);
    setTo(s?.to ?? props.group.members.find((m) => m !== SELF_MEMBER) ?? '');
    setAmount(s ? String(s.amount) : '');
  }, [props.visible, props.suggestion, props.group.members]);

  const save = async () => {
    const value = parseAmountInput(amount);
    if (value === null || value <= 0) {
      Alert.alert('Amount required', 'Enter how much was paid back.');
      return;
    }
    if (!to || from === to) {
      Alert.alert('Pick two people', 'Choose who paid and who received the money.');
      return;
    }
    setSaving(true);
    try {
      await sharedExpenseRepository.addSettlement({
        groupId: props.group.id!,
        from,
        to,
        amount: value,
        date: new Date().toISOString(),
      });
      notifyDataChanged();
      props.onClose();
    } catch (error) {
      showError('Could not record payment', error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet visible={props.visible} onClose={props.onClose} title="Record a payment">
      <View style={{ gap: spacing.md }}>
        <Text style={{ color: colors.textSecondary, fontWeight: '600', fontSize: 13 }}>Who paid</Text>
        <View style={ui.rowWrap}>
          {props.group.members.map((m) => (
            <Chip key={m} label={m} selected={from === m} onPress={() => setFrom(m)} />
          ))}
        </View>
        <Text style={{ color: colors.textSecondary, fontWeight: '600', fontSize: 13 }}>Paid to</Text>
        <View style={ui.rowWrap}>
          {props.group.members
            .filter((m) => m !== from)
            .map((m) => (
              <Chip key={m} label={m} selected={to === m} onPress={() => setTo(m)} />
            ))}
        </View>
        <TextField
          label="Amount (ETB)"
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder="0.00"
          style={{ fontSize: 20, fontWeight: '700' }}
        />
        <Button title="Record payment" icon="check" onPress={() => void save()} loading={saving} />
      </View>
    </Sheet>
  );
}

type GroupTab = 'expenses' | 'balances' | 'payments';

export function SharedGroupScreen({ route, navigation }: StackScreenProps<'SharedGroup'>) {
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const version = useData((s) => s.version);
  const groupId = route.params.groupId;

  const [group, setGroup] = useState<SharedGroup | null | undefined>(undefined);
  const [expenses, setExpenses] = useState<SharedExpense[]>([]);
  const [settlements, setSettlements] = useState<SharedSettlement[]>([]);
  const [tab, setTab] = useState<GroupTab>('expenses');
  const [expenseVisible, setExpenseVisible] = useState(false);
  const [draft, setDraft] = useState<ExpenseDraft>({ existing: null, transaction: null });
  const [pickerVisible, setPickerVisible] = useState(false);
  const [settleVisible, setSettleVisible] = useState(false);
  const [suggestion, setSuggestion] = useState<SuggestedTransfer | null>(null);
  const [editVisible, setEditVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    sharedExpenseRepository
      .getGroupSummary(groupId)
      .then((summary) => {
        if (cancelled) return;
        if (!summary) {
          setGroup(null);
          return;
        }
        setGroup(summary.group);
        setExpenses(summary.expenses);
        setSettlements(summary.settlements);
      })
      .catch((error) => {
        if (__DEV__) console.warn('debug: Failed to load shared group', error);
        if (!cancelled) setGroup(null);
      });
    return () => {
      cancelled = true;
    };
  }, [groupId, version]);

  const balances = useMemo<MemberBalance[]>(
    () => (group ? computeBalances(group, expenses, settlements) : []),
    [group, expenses, settlements],
  );
  const transfers = useMemo(() => simplifyDebts(balances), [balances]);
  const yourNet = balances.find((b) => b.member === SELF_MEMBER)?.net ?? 0;
  const total = expenses.reduce((s, e) => s + e.amount, 0);

  const deleteGroup = useCallback(async () => {
    if (!group?.id) return;
    const ok = await confirm('Delete group', `Delete "${group.name}" with all its expenses and payments?`, 'Delete', true);
    if (!ok) return;
    try {
      await sharedExpenseRepository.deleteGroup(group.id);
      notifyDataChanged();
      navigation.goBack();
    } catch (error) {
      showError('Could not delete group', error);
    }
  }, [group, navigation]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: group?.name ?? 'Group',
      headerRight: group
        ? () => (
            <View style={{ flexDirection: 'row' }}>
              <IconButton name="edit" accessibilityLabel="Edit group" onPress={() => setEditVisible(true)} />
              <IconButton name="delete-outline" accessibilityLabel="Delete group" onPress={() => void deleteGroup()} />
            </View>
          )
        : undefined,
    });
  }, [navigation, group, deleteGroup]);

  const openNewExpense = () => {
    setDraft({ existing: null, transaction: null });
    setExpenseVisible(true);
  };

  const expenseActions = (expense: SharedExpense) => {
    Alert.alert(expense.description, formatMoney(expense.amount), [
      {
        text: 'Edit',
        onPress: () => {
          setDraft({ existing: expense, transaction: null });
          setExpenseVisible(true);
        },
      },
      {
        text: expense.settled ? 'Mark unsettled' : 'Mark settled',
        onPress: () =>
          void sharedExpenseRepository
            .saveExpense({ ...expense, settled: !expense.settled })
            .then(notifyDataChanged)
            .catch((e) => showError('Could not update', e)),
      },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          void confirm('Delete expense', `Delete "${expense.description}"?`, 'Delete', true).then(async (ok) => {
            if (!ok || expense.id == null) return;
            await sharedExpenseRepository.deleteExpense(expense.id);
            notifyDataChanged();
          }),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  if (group === undefined) {
    return (
      <Screen edges={['left', 'right', 'bottom']}>
        <Text style={{ color: colors.textSecondary }}>Loading…</Text>
      </Screen>
    );
  }
  if (group === null) {
    return (
      <Screen edges={['left', 'right', 'bottom']}>
        <EmptyState icon="groups" title="Group not found" message="It may have been deleted." />
      </Screen>
    );
  }

  return (
    <Screen edges={['left', 'right', 'bottom']}>
      <Card style={{ gap: spacing.sm }}>
        <View style={[ui.rowCenter, { justifyContent: 'space-between' }]}>
          <View>
            <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
              {Math.abs(yourNet) <= EPSILON ? 'You are settled up' : yourNet > 0 ? 'You are owed' : 'You owe'}
            </Text>
            <AmountText
              value={Math.abs(yourNet)}
              color={Math.abs(yourNet) <= EPSILON ? colors.text : yourNet > 0 ? colors.income : colors.expense}
              style={{ fontSize: 22, fontWeight: '800' }}
            />
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Group spending</Text>
            <AmountText value={total} style={{ fontWeight: '700' }} />
          </View>
        </View>
        <View style={[ui.rowCenter, { marginTop: spacing.xs }]}>
          {group.members.slice(0, 6).map((m) => (
            <MemberAvatar key={m} name={m} size={28} />
          ))}
          {group.members.length > 6 ? (
            <Text style={{ color: colors.textMuted }}>+{group.members.length - 6}</Text>
          ) : null}
        </View>
        <View style={[ui.rowCenter, { marginTop: spacing.sm }]}>
          <Button title="Add expense" icon="add" onPress={openNewExpense} style={{ flex: 1 }} />
          <Button
            title="Settle up"
            icon="handshake"
            variant="secondary"
            onPress={() => {
              setSuggestion(transfers.find((t) => t.from === SELF_MEMBER || t.to === SELF_MEMBER) ?? transfers[0] ?? null);
              setSettleVisible(true);
            }}
            style={{ flex: 1 }}
          />
        </View>
      </Card>

      <SegmentedControl<GroupTab>
        options={[
          { value: 'expenses', label: 'Expenses' },
          { value: 'balances', label: 'Balances' },
          { value: 'payments', label: 'Payments' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'expenses' ? (
        expenses.length === 0 ? (
          <EmptyState
            icon="receipt-long"
            title="No expenses yet"
            message="Add what someone paid for the group and Totals works out who owes whom."
            action={{ label: 'Add expense', onPress: openNewExpense }}
          />
        ) : (
          <Card>
            {expenses.map((e, i) => {
              const yourShare = e.splits[SELF_MEMBER] ?? 0;
              const youPaid = e.paidBy === SELF_MEMBER;
              const lent = youPaid ? e.amount - yourShare : 0;
              return (
                <View key={e.id ?? i}>
                  {i > 0 ? <Divider /> : null}
                  <ListRow
                    left={<MemberAvatar name={e.paidBy} />}
                    title={e.description}
                    subtitle={[
                      `${e.paidBy} paid ${formatMoney(e.amount)}`,
                      formatDate(new Date(e.date), calendar),
                      e.transactionReference ? 'linked' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    onPress={() => expenseActions(e)}
                    onLongPress={
                      e.transactionReference
                        ? () => navigation.push('TransactionDetail', { reference: e.transactionReference! })
                        : undefined
                    }
                    right={
                      e.settled ? (
                        <Pill label="Settled" color={colors.textMuted} />
                      ) : youPaid && lent > EPSILON ? (
                        <View style={{ alignItems: 'flex-end' }}>
                          <Text style={{ color: colors.textMuted, fontSize: 11 }}>you lent</Text>
                          <AmountText value={lent} color={colors.income} style={{ fontWeight: '600' }} />
                        </View>
                      ) : !youPaid && yourShare > EPSILON ? (
                        <View style={{ alignItems: 'flex-end' }}>
                          <Text style={{ color: colors.textMuted, fontSize: 11 }}>you borrowed</Text>
                          <AmountText value={yourShare} color={colors.expense} style={{ fontWeight: '600' }} />
                        </View>
                      ) : (
                        <Text style={{ color: colors.textMuted, fontSize: 11 }}>not involved</Text>
                      )
                    }
                  />
                </View>
              );
            })}
          </Card>
        )
      ) : null}

      {tab === 'balances' ? (
        <>
          <Card>
            {balances.map((b, i) => (
              <View key={b.member}>
                {i > 0 ? <Divider /> : null}
                <ListRow
                  left={<MemberAvatar name={b.member} />}
                  title={b.member}
                  subtitle={Math.abs(b.net) <= EPSILON ? 'Settled up' : b.net > 0 ? 'gets back' : 'owes'}
                  right={
                    Math.abs(b.net) <= EPSILON ? null : (
                      <AmountText
                        value={Math.abs(b.net)}
                        color={b.net > 0 ? colors.income : colors.expense}
                        style={{ fontWeight: '700' }}
                      />
                    )
                  }
                />
              </View>
            ))}
          </Card>
          <SectionTitle title="Suggested payments" />
          {transfers.length === 0 ? (
            <Card>
              <Text style={{ color: colors.textMuted }}>Everyone is settled up.</Text>
            </Card>
          ) : (
            <Card>
              {transfers.map((t, i) => (
                <View key={`${t.from}-${t.to}`}>
                  {i > 0 ? <Divider /> : null}
                  <ListRow
                    icon="arrow-forward"
                    title={`${t.from} → ${t.to}`}
                    value={formatMoney(t.amount)}
                    right={
                      <Button
                        title="Settle"
                        compact
                        variant="secondary"
                        onPress={() => {
                          setSuggestion(t);
                          setSettleVisible(true);
                        }}
                      />
                    }
                  />
                </View>
              ))}
            </Card>
          )}
        </>
      ) : null}

      {tab === 'payments' ? (
        settlements.length === 0 ? (
          <EmptyState icon="payments" title="No payments yet" message="Recorded settle-up payments appear here." />
        ) : (
          <Card>
            {settlements.map((s, i) => (
              <View key={s.id ?? i}>
                {i > 0 ? <Divider /> : null}
                <ListRow
                  icon="payments"
                  title={`${s.from} paid ${s.to}`}
                  subtitle={formatDate(new Date(s.date), calendar)}
                  value={formatMoney(s.amount)}
                  onLongPress={() =>
                    void confirm('Delete payment', `Remove the ${formatMoney(s.amount)} payment from ${s.from} to ${s.to}?`, 'Delete', true).then(
                      async (ok) => {
                        if (!ok || s.id == null) return;
                        await sharedExpenseRepository.deleteSettlement(s.id);
                        notifyDataChanged();
                      },
                    )
                  }
                />
              </View>
            ))}
            <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: spacing.sm }}>Long-press a payment to delete it.</Text>
          </Card>
        )
      ) : null}

      <ExpenseFormSheet
        visible={expenseVisible}
        group={group}
        draft={draft}
        onClose={() => setExpenseVisible(false)}
        onPickTransaction={() => {
          setExpenseVisible(false);
          setPickerVisible(true);
        }}
      />
      <TransactionPickerSheet
        visible={pickerVisible}
        onClose={() => {
          setPickerVisible(false);
          setExpenseVisible(true);
        }}
        onPick={(tx) => {
          setDraft({ existing: null, transaction: tx });
          setPickerVisible(false);
          setExpenseVisible(true);
        }}
      />
      <SettleSheet visible={settleVisible} group={group} suggestion={suggestion} onClose={() => setSettleVisible(false)} />
      <GroupFormSheet visible={editVisible} group={group} onClose={() => setEditVisible(false)} onSaved={() => undefined} />
    </Screen>
  );
}
