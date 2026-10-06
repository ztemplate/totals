import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { confirm, showError } from '../components/dialogs';
import { AmountText, BankAvatar, groupByDay, sortByTimeDesc } from '../components/finance';
import { ExpandableTransactionRow } from '../components/transactionActions';
import { GroupFormSheet, PersonAvatar, PersonFormSheet } from '../components/people';
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
  ProgressBar,
  Screen,
  SectionTitle,
  SegmentedControl,
  TextField,
  styles as ui,
} from '../components/ui';
import type { PeopleGroup } from '../models/peopleGroup';
import { PERSON_TYPES, personTypeMeta, type Person, type PersonAccount, type PersonAccountKind, type PersonType } from '../models/person';
import { isCredit, isDebit, txDate, type Transaction } from '../models/transaction';
import type { AppNavigation, StackScreenProps } from '../navigation/types';
import { bankById } from '../repositories/bankRepository';
import { peopleGroupRepository } from '../repositories/peopleGroupRepository';
import { peopleRepository } from '../repositories/peopleRepository';
import { loadLoanDebtItems, type LoanDebtItem } from '../services/loanDebtSummary';
import { notifyDataChanged, useData } from '../store/dataStore';
import { useSettings, useTheme } from '../store/settingsStore';
import { spacing } from '../theme/colors';
import { CASH_BANK_ID } from '../utils/cashConstants';
import { formatDate, formatMoney, relativeDayLabel, titleCase } from '../utils/format';
import { analyzePeople } from '../utils/peopleAnalytics';
import { periodStart, previousPeriodStart, type CalendarKind } from '../utils/periodUtils';
import {
  groupLoanItemsByPerson,
  groupTransactionsByPerson,
  guessIdentifierKind,
  normalizePersonName,
  suggestCounterparties,
  summarizePersonActivity,
  type PeopleIndex,
  type PersonActivitySummary,
} from '../utils/personMatching';

/** Loads the people index and loan items, refreshing whenever data changes. */
function usePeopleData() {
  const { transactions, version } = useData();
  const [index, setIndex] = useState<PeopleIndex | null>(null);
  const [loans, setLoans] = useState<LoanDebtItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([peopleRepository.loadIndex(), loadLoanDebtItems(transactions)])
      .then(([loadedIndex, loadedLoans]) => {
        if (cancelled) return;
        setIndex(loadedIndex);
        setLoans(loadedLoans);
      })
      .catch((error) => {
        if (__DEV__) console.warn('debug: Failed to load people', error);
      });
    return () => {
      cancelled = true;
    };
  }, [transactions, version]);

  const byPerson = useMemo<Map<number, Transaction[]>>(
    () => (index ? groupTransactionsByPerson(transactions, index) : new Map()),
    [transactions, index],
  );
  const loansByPerson = useMemo<Map<number, LoanDebtItem[]>>(
    () => (index ? groupLoanItemsByPerson(loans, index) : new Map()),
    [loans, index],
  );
  return { index, transactions, byPerson, loansByPerson };
}

type PeopleSort = 'recent' | 'owed' | 'name';
type PeopleView = 'list' | 'groups' | 'insights';

export function PeopleScreen({ navigation }: StackScreenProps<'People'>) {
  const [adding, setAdding] = useState(false);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => <IconButton name="person-add" accessibilityLabel="Add person" onPress={() => setAdding(true)} />,
    });
  }, [navigation]);

  return (
    <Screen edges={['left', 'right', 'bottom']}>
      <PeopleList navigation={navigation as unknown as AppNavigation} adding={adding} onAddingChange={setAdding} />
    </Screen>
  );
}

/**
 * People with their balances, plus insights on where the money goes. Rendered inside a scroll view by the
 * People screen and by the People tab of Money.
 */
export function PeopleList(props: { navigation: AppNavigation; adding?: boolean; onAddingChange?: (adding: boolean) => void }) {
  const { navigation } = props;
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const { index, byPerson, loansByPerson } = usePeopleData();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<PeopleSort>('recent');
  const [typeFilter, setTypeFilter] = useState<PersonType | null>(null);
  const [view, setView] = useState<PeopleView>('list');
  const [localAdding, setLocalAdding] = useState(false);
  const adding = props.adding ?? localAdding;
  const setAdding = props.onAddingChange ?? setLocalAdding;

  const typesInUse = useMemo(() => {
    const used = new Set((index?.people ?? []).map((p) => p.type ?? 'friend'));
    return PERSON_TYPES.filter((t) => used.has(t.value));
  }, [index]);

  const rows = useMemo(() => {
    const key = normalizePersonName(query);
    const list = (index?.people ?? [])
      .filter((p) => typeFilter === null || (p.type ?? 'friend') === typeFilter)
      .filter((p) => !key || normalizePersonName(p.name).includes(key) || (p.phone ?? '').includes(query.trim()))
      .map((person) => ({
        person,
        summary: summarizePersonActivity(byPerson.get(person.id) ?? [], loansByPerson.get(person.id) ?? []),
      }));
    list.sort((a, b) => {
      if (sort === 'name') return a.person.name.localeCompare(b.person.name);
      if (sort === 'owed') {
        const diff = b.summary.owesMe + b.summary.iOwe - (a.summary.owesMe + a.summary.iOwe);
        if (diff !== 0) return diff;
      }
      return (b.summary.lastDate?.getTime() ?? 0) - (a.summary.lastDate?.getTime() ?? 0) || a.person.name.localeCompare(b.person.name);
    });
    return list;
  }, [index, byPerson, loansByPerson, query, sort, typeFilter]);

  const totals = useMemo(() => {
    let owesMe = 0;
    let iOwe = 0;
    for (const items of loansByPerson.values()) {
      const s = summarizePersonActivity([], items);
      owesMe += s.owesMe;
      iOwe += s.iOwe;
    }
    return { owesMe, iOwe };
  }, [loansByPerson]);

  const form = (
    <PersonFormSheet
      visible={adding}
      onClose={() => setAdding(false)}
      onSaved={(personId) => {
        setAdding(false);
        navigation.navigate('PersonDetail', { personId });
      }}
    />
  );

  if (!index) return <Text style={{ color: colors.textSecondary }}>Loading…</Text>;

  if (index.people.length === 0) {
    return (
      <>
        <EmptyState
          icon="people"
          title="No people yet"
          message="Add friends, shops, restaurants and anyone you send money to or receive from. Link their CBE, telebirr and other accounts by the name each bank prints, or by their phone or account number, and every matching message is grouped under them."
          action={{ label: 'Add person', onPress: () => setAdding(true) }}
        />
        {form}
      </>
    );
  }

  return (
    <>
      <View style={[ui.rowCenter, { gap: spacing.md }]}>
        <Card style={{ flex: 1, gap: 4 }} onPress={() => navigation.navigate('Loans')}>
          <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Owed to you</Text>
          <AmountText value={totals.owesMe} color={colors.income} style={{ fontSize: 18, fontWeight: '700' }} compact />
        </Card>
        <Card style={{ flex: 1, gap: 4 }} onPress={() => navigation.navigate('Loans')}>
          <Text style={{ color: colors.textSecondary, fontSize: 12 }}>You owe</Text>
          <AmountText value={totals.iOwe} color={colors.expense} style={{ fontSize: 18, fontWeight: '700' }} compact />
        </Card>
      </View>
      <SegmentedControl<PeopleView>
        options={[
          { value: 'list', label: 'People' },
          { value: 'groups', label: 'Groups' },
          { value: 'insights', label: 'Insights' },
        ]}
        value={view}
        onChange={setView}
      />
      {view === 'insights' ? (
        <PeopleInsights people={index.people} byPerson={byPerson} loansByPerson={loansByPerson} navigation={navigation} />
      ) : view === 'groups' ? (
        <PeopleGroups people={index.people} navigation={navigation} />
      ) : (
        <>
          <View style={[ui.rowCenter, { gap: spacing.sm }]}>
            <TextField value={query} onChangeText={setQuery} placeholder="Search people" containerStyle={{ flex: 1 }} />
            <IconButton name="person-add" accessibilityLabel="Add person" onPress={() => setAdding(true)} />
          </View>
          {typesInUse.length > 1 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
              <Chip label="All" selected={typeFilter === null} onPress={() => setTypeFilter(null)} />
              {typesInUse.map((t) => (
                <Chip
                  key={t.value}
                  label={t.label}
                  icon={t.icon}
                  selected={typeFilter === t.value}
                  onPress={() => setTypeFilter(typeFilter === t.value ? null : t.value)}
                />
              ))}
            </ScrollView>
          ) : null}
          <SegmentedControl<PeopleSort>
            options={[
              { value: 'recent', label: 'Recent' },
              { value: 'owed', label: 'Balance' },
              { value: 'name', label: 'Name' },
            ]}
            value={sort}
            onChange={setSort}
          />
          {rows.length === 0 ? <Text style={{ color: colors.textMuted }}>No one matches.</Text> : null}
          {rows.map(({ person, summary }) => (
            <Card key={person.id} onPress={() => navigation.navigate('PersonDetail', { personId: person.id })} style={{ gap: spacing.sm }}>
              <View style={ui.rowCenter}>
                <PersonAvatar name={person.name} type={person.type} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }} numberOfLines={1}>
                    {person.name}
                  </Text>
                  <Text style={{ color: colors.textSecondary, fontSize: 12 }} numberOfLines={1}>
                    {personTypeMeta(person.type).label} ·{' '}
                    {summary.count === 0
                      ? 'no transactions matched yet'
                      : `${summary.count} transaction${summary.count === 1 ? '' : 's'}${
                          summary.lastDate ? ` · last ${relativeDayLabel(summary.lastDate, calendar)}` : ''
                        }`}
                  </Text>
                </View>
                <BalanceBadge summary={summary} />
              </View>
              {summary.count > 0 ? (
                <View style={[ui.rowCenter, { justifyContent: 'space-between' }]}>
                  <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                    Sent <AmountText value={summary.sent} compact style={{ fontSize: 12, fontWeight: '600' }} />
                  </Text>
                  <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                    Received <AmountText value={summary.received} compact color={colors.income} style={{ fontSize: 12, fontWeight: '600' }} />
                  </Text>
                </View>
              ) : null}
            </Card>
          ))}
        </>
      )}
      {form}
    </>
  );
}

/** Saved groups of people (flatmates, a team…) for splitting a bill in one tap. */
function PeopleGroups(props: { people: Person[]; navigation: AppNavigation }) {
  const colors = useTheme();
  const version = useData((s) => s.version);
  const [groups, setGroups] = useState<PeopleGroup[] | null>(null);
  const [editing, setEditing] = useState<PeopleGroup | 'new' | null>(null);
  const peopleById = useMemo(() => new Map(props.people.map((p) => [p.id, p])), [props.people]);

  useEffect(() => {
    let cancelled = false;
    peopleGroupRepository
      .getGroups()
      .then((loaded) => {
        if (!cancelled) setGroups(loaded);
      })
      .catch((error) => {
        if (__DEV__) console.warn('debug: Failed to load groups', error);
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  const sheet = (
    <GroupFormSheet
      visible={editing !== null}
      onClose={() => setEditing(null)}
      people={props.people}
      group={editing === 'new' ? null : editing}
    />
  );

  if (!groups) return <Text style={{ color: colors.textSecondary }}>Loading…</Text>;
  return (
    <>
      <Text style={{ color: colors.textSecondary }}>
        Group the people you often share bills with. When splitting a transaction, tap Split with group to give everyone an equal part.
      </Text>
      {groups.length === 0 ? (
        <EmptyState icon="groups" title="No groups yet" action={{ label: 'New group', onPress: () => setEditing('new') }} />
      ) : (
        <>
          {groups.map((group) => {
            const members = group.memberIds.map((id) => peopleById.get(id)).filter((p): p is Person => !!p);
            return (
              <Card key={group.id} onPress={() => setEditing(group)} style={{ gap: spacing.sm }}>
                <View style={ui.rowCenter}>
                  <Icon name="groups" color={colors.primary} />
                  <Text style={{ flex: 1, color: colors.text, fontSize: 16, fontWeight: '700' }} numberOfLines={1}>
                    {group.name}
                  </Text>
                  <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                    {members.length} {members.length === 1 ? 'person' : 'people'}
                  </Text>
                </View>
                {members.length > 0 ? (
                  <View style={ui.rowWrap}>
                    {members.map((p) => (
                      <View key={p.id} style={[ui.rowCenter, { gap: 6 }]}>
                        <PersonAvatar name={p.name} type={p.type} size={22} />
                        <Text style={{ color: colors.text, fontSize: 13 }}>{p.name}</Text>
                      </View>
                    ))}
                  </View>
                ) : (
                  <Text style={{ color: colors.textMuted, fontSize: 12 }}>No members yet. Tap to add people.</Text>
                )}
              </Card>
            );
          })}
          <Button title="New group" icon="group-add" variant="secondary" onPress={() => setEditing('new')} />
        </>
      )}
      {sheet}
    </>
  );
}

type InsightPeriod = 'month' | 'quarter' | 'year' | 'all';

/** Start of the insight period in the chosen calendar; "3 months" is this month and the two before. */
function insightPeriodStart(period: InsightPeriod, calendar: CalendarKind): Date | null {
  const now = new Date();
  if (period === 'month') return periodStart(now, 'monthly', calendar);
  if (period === 'quarter') {
    return previousPeriodStart(previousPeriodStart(now, 'monthly', calendar), 'monthly', calendar);
  }
  if (period === 'year') return periodStart(now, 'yearly', calendar);
  return null;
}

/** Where the money goes: by kind of person, top payees, top borrowers and most frequent contacts. */
function PeopleInsights(props: {
  people: Person[];
  byPerson: Map<number, Transaction[]>;
  loansByPerson: Map<number, LoanDebtItem[]>;
  navigation: AppNavigation;
}) {
  const colors = useTheme();
  const { selfTransferReferences } = useData();
  const calendar = useSettings((s) => s.calendar);
  const [period, setPeriod] = useState<InsightPeriod>('quarter');
  const analytics = useMemo(
    () =>
      analyzePeople({
        people: props.people,
        byPerson: props.byPerson,
        loansByPerson: props.loansByPerson,
        since: insightPeriodStart(period, calendar),
        exclude: selfTransferReferences,
      }),
    [props.people, props.byPerson, props.loansByPerson, period, selfTransferReferences, calendar],
  );
  const open = (personId: number) => props.navigation.navigate('PersonDetail', { personId });
  const maxType = Math.max(1, ...analytics.byType.map((t) => t.amount));

  return (
    <>
      <View style={ui.rowWrap}>
        {(
          [
            ['month', 'This month'],
            ['quarter', '3 months'],
            ['year', 'This year'],
            ['all', 'All time'],
          ] as const
        ).map(([value, label]) => (
          <Chip key={value} label={label} selected={period === value} onPress={() => setPeriod(value)} />
        ))}
      </View>

      <SectionTitle title="Where your money goes" />
      <Card style={{ gap: spacing.md }}>
        {analytics.byType.length === 0 ? (
          <Text style={{ color: colors.textSecondary }}>No payments to people in this period.</Text>
        ) : (
          analytics.byType.map((t) => (
            <View key={t.type} style={{ gap: 4 }}>
              <View style={[ui.rowCenter, { justifyContent: 'space-between' }]}>
                <View style={[ui.rowCenter, { gap: spacing.sm }]}>
                  <Icon name={t.icon} size={18} color={colors.textSecondary} />
                  <Text style={{ color: colors.text, fontWeight: '600' }}>{t.label}</Text>
                  <Text style={{ color: colors.textMuted, fontSize: 12 }}>
                    {t.people} {t.people === 1 ? 'place/person' : 'places/people'} · {t.count}×
                  </Text>
                </View>
                <AmountText value={t.amount} compact style={{ fontWeight: '700' }} />
              </View>
              <ProgressBar progress={t.amount / maxType} color={colors.expense} />
            </View>
          ))
        )}
      </Card>

      <RankCard
        title="You spend most at"
        empty="Nothing sent in this period."
        rows={analytics.topSpending.map((r) => ({ person: r.person, value: r.amount, detail: `${r.count} payment${r.count === 1 ? '' : 's'}` }))}
        color={colors.expense}
        onOpen={open}
      />
      <RankCard
        title="Who borrows the most"
        empty="No loans in this period."
        rows={analytics.topBorrowers.map((r) => ({
          person: r.person,
          value: r.lent,
          detail: `${r.loans} loan${r.loans === 1 ? '' : 's'}${r.outstanding > 0.005 ? ` · ${formatMoney(r.outstanding, { compact: true })} still owed` : ''}`,
        }))}
        color={colors.warning}
        onOpen={open}
      />
      <RankCard
        title="Most transactions with"
        empty="No transactions in this period."
        rows={analytics.mostTransactions.map((r) => ({
          person: r.person,
          value: r.amount,
          detail: `${r.count} transaction${r.count === 1 ? '' : 's'}`,
        }))}
        color={colors.text}
        onOpen={open}
      />
      <RankCard
        title="You receive most from"
        empty="Nothing received in this period."
        rows={analytics.topReceiving.map((r) => ({ person: r.person, value: r.amount, detail: `${r.count} payment${r.count === 1 ? '' : 's'}` }))}
        color={colors.income}
        onOpen={open}
      />
    </>
  );
}

function RankCard(props: {
  title: string;
  empty: string;
  rows: { person: Person; value: number; detail: string }[];
  color: string;
  onOpen: (personId: number) => void;
}) {
  const colors = useTheme();
  return (
    <>
      <SectionTitle title={props.title} />
      <Card style={{ paddingVertical: spacing.xs }}>
        {props.rows.length === 0 ? (
          <Text style={{ color: colors.textSecondary, paddingVertical: spacing.sm }}>{props.empty}</Text>
        ) : (
          props.rows.map((row, i) => (
            <ListRow
              key={row.person.id}
              left={<PersonAvatar name={row.person.name} type={row.person.type} size={36} />}
              title={`${i + 1}. ${row.person.name}`}
              subtitle={`${personTypeMeta(row.person.type).label} · ${row.detail}`}
              right={<AmountText value={row.value} compact color={props.color} style={{ fontWeight: '700' }} />}
              onPress={() => props.onOpen(row.person.id)}
            />
          ))
        )}
      </Card>
    </>
  );
}

/** "Owes you" / "You owe" from active loans; nothing when they are square. */
function BalanceBadge(props: { summary: PersonActivitySummary }) {
  const colors = useTheme();
  const net = props.summary.owesMe - props.summary.iOwe;
  if (props.summary.activeLoans === 0 || Math.abs(net) < 0.005) return null;
  return (
    <View style={{ alignItems: 'flex-end' }}>
      <Text style={{ color: colors.textSecondary, fontSize: 11 }}>{net > 0 ? 'Owes you' : 'You owe'}</Text>
      <AmountText value={Math.abs(net)} compact color={net > 0 ? colors.income : colors.expense} style={{ fontWeight: '700' }} />
    </View>
  );
}

const KIND_LABEL: Record<PersonAccountKind, string> = {
  name: 'Name',
  account: 'Account no.',
  phone: 'Phone',
};

const KIND_ICON: Record<PersonAccountKind, string> = {
  name: 'badge',
  account: 'account-balance',
  phone: 'phone',
};

const TX_PAGE = 30;

function copyValue(label: string, value: string) {
  void Clipboard.setStringAsync(value).then(() => Alert.alert('Copied', `${label} copied to clipboard.`));
}

/**
 * Contact details for a person: phone and bank account numbers (which also match their messages), email,
 * address and Telegram. Tap a value to copy it.
 */
function PersonDetailsSection(props: {
  person: Person;
  aliases: PersonAccount[];
  onEdit: () => void;
  onRemoveAlias: (alias: PersonAccount) => void;
}) {
  const colors = useTheme();
  const banksWithCash = useData((s) => s.banksWithCash);
  const { person } = props;
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<'phone' | 'account'>('phone');
  const [bankId, setBankId] = useState<number | null>(null);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const phones = props.aliases.filter((a) => a.kind === 'phone');
  const accounts = props.aliases.filter((a) => a.kind === 'account');
  const banks = banksWithCash.filter((b) => b.id !== CASH_BANK_ID);

  const add = async () => {
    setSaving(true);
    try {
      await peopleRepository.addAccount({ personId: person.id, bankId: kind === 'account' ? bankId : null, identifier: value, kind });
      notifyDataChanged();
      setValue('');
      setAdding(false);
    } catch (error) {
      showError('Could not add', error);
    } finally {
      setSaving(false);
    }
  };

  const removeIcon = (alias: PersonAccount) => (
    <IconButton name="close" size={18} color={colors.textMuted} accessibilityLabel="Remove" onPress={() => props.onRemoveAlias(alias)} />
  );
  const extras: { icon: string; label: string; value: string | null | undefined }[] = [
    { icon: 'email', label: 'Email', value: person.email },
    { icon: 'place', label: 'Address', value: person.address },
    { icon: 'send', label: 'Telegram', value: person.telegram ? `@${person.telegram.replace(/^@/, '')}` : null },
  ];
  const empty = !person.phone && phones.length === 0 && accounts.length === 0 && extras.every((e) => !e.value);

  return (
    <>
      <SectionTitle title="Details" action={{ label: 'Edit', onPress: props.onEdit }} />
      <Card style={{ gap: spacing.xs, paddingVertical: spacing.sm }}>
        {empty && !adding ? (
          <Text style={{ color: colors.textSecondary, paddingVertical: spacing.sm }}>
            No details yet. Add their phone numbers and bank accounts so you have them when paying or asking to be paid back.
          </Text>
        ) : null}
        {person.phone ? (
          <ListRow icon="phone" title={person.phone} subtitle="Phone · tap to copy" onPress={() => copyValue('Phone number', person.phone!)} />
        ) : null}
        {phones.map((alias) => (
          <ListRow
            key={alias.id}
            icon="phone"
            title={alias.identifier}
            subtitle="Phone · tap to copy"
            onPress={() => copyValue('Phone number', alias.identifier)}
            onLongPress={() => props.onRemoveAlias(alias)}
            right={removeIcon(alias)}
          />
        ))}
        {accounts.map((alias) => {
          const bank = bankById(banksWithCash, alias.bankId);
          return (
            <ListRow
              key={alias.id}
              left={bank ? <BankAvatar bank={bank} size={36} /> : undefined}
              icon={bank ? undefined : 'account-balance'}
              title={alias.identifier}
              subtitle={`${bank?.shortName ?? 'Bank account'} · tap to copy`}
              onPress={() => copyValue('Account number', alias.identifier)}
              onLongPress={() => props.onRemoveAlias(alias)}
              right={removeIcon(alias)}
            />
          );
        })}
        {extras
          .filter((e) => !!e.value)
          .map((e) => (
            <ListRow key={e.label} icon={e.icon} title={e.value!} subtitle={`${e.label} · tap to copy`} onPress={() => copyValue(e.label, e.value!)} />
          ))}
        {adding ? (
          <View style={{ gap: spacing.sm, paddingTop: spacing.sm }}>
            <Divider />
            <SegmentedControl<'phone' | 'account'>
              options={[
                { value: 'phone', label: 'Phone number' },
                { value: 'account', label: 'Bank account' },
              ]}
              value={kind}
              onChange={setKind}
            />
            {kind === 'account' ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
                <Chip label="Any bank" selected={bankId === null} onPress={() => setBankId(null)} />
                {banks.map((b) => (
                  <Chip key={b.id} label={b.shortName} selected={bankId === b.id} onPress={() => setBankId(b.id)} />
                ))}
              </ScrollView>
            ) : null}
            <TextField
              value={value}
              onChangeText={setValue}
              placeholder={kind === 'phone' ? '09… or +2519…' : 'Account number'}
              keyboardType="phone-pad"
              autoFocus
            />
            <Text style={{ color: colors.textMuted, fontSize: 12 }}>
              Messages that mention this number are also grouped under {person.name}.
            </Text>
            <View style={[ui.rowCenter, { justifyContent: 'flex-end' }]}>
              <Button title="Cancel" variant="ghost" compact onPress={() => setAdding(false)} />
              <Button title="Add" icon="add" compact loading={saving} disabled={!value.trim()} onPress={() => void add()} />
            </View>
          </View>
        ) : (
          <Button title="Add phone or account number" icon="add" variant="ghost" compact onPress={() => setAdding(true)} />
        )}
      </Card>
    </>
  );
}

export function PersonDetailScreen({ route, navigation }: StackScreenProps<'PersonDetail'>) {
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const banksWithCash = useData((s) => s.banksWithCash);
  const { index, transactions, byPerson, loansByPerson } = usePeopleData();
  const personId = route.params.personId;
  const person = index?.byId.get(personId) ?? null;

  const [editing, setEditing] = useState(false);
  const [aliasBank, setAliasBank] = useState<number | null>(null);
  const [aliasText, setAliasText] = useState('');
  const [suggestQuery, setSuggestQuery] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [txLimit, setTxLimit] = useState(TX_PAGE);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: person?.name ?? 'Person',
      headerRight: person
        ? () => <IconButton name="edit" accessibilityLabel="Edit person" onPress={() => setEditing(true)} />
        : undefined,
    });
  }, [navigation, person]);

  const txs = useMemo(() => sortByTimeDesc(byPerson.get(personId) ?? []), [byPerson, personId]);
  const txDays = useMemo(() => groupByDay(txs.slice(0, txLimit)), [txs, txLimit]);
  const loans = useMemo<LoanDebtItem[]>(() => {
    const items: LoanDebtItem[] = loansByPerson.get(personId) ?? [];
    return [...items].sort(
      (a, b) =>
        Number(b.effectiveStatus === 'active') - Number(a.effectiveStatus === 'active') ||
        (loanDate(b)?.getTime() ?? 0) - (loanDate(a)?.getTime() ?? 0),
    );
  }, [loansByPerson, personId]);
  const summary = useMemo(() => summarizePersonActivity(txs, loans), [txs, loans]);
  const aliases = index?.accountsByPerson.get(personId) ?? [];
  const nameAliases = aliases.filter((a) => a.kind === 'name');
  const suggestions = useMemo(
    () => (index && person ? suggestCounterparties(transactions, index, person.name, suggestQuery).slice(0, 8) : []),
    [transactions, index, person, suggestQuery],
  );
  const aliasKind = guessIdentifierKind(aliasText);

  // Banks the user actually has transactions with come first; the rest only matter for typed aliases.
  const bankOptions = useMemo(() => {
    const used = new Set(transactions.map((t) => t.bankId).filter((id): id is number => id != null));
    return banksWithCash.filter((b) => used.has(b.id));
  }, [transactions, banksWithCash]);

  if (!index) {
    return (
      <Screen edges={['left', 'right', 'bottom']}>
        <Text style={{ color: colors.textSecondary }}>Loading…</Text>
      </Screen>
    );
  }
  if (!person) {
    return (
      <Screen edges={['left', 'right', 'bottom']}>
        <EmptyState icon="person-off" title="Person not found" message="They may have been deleted." />
      </Screen>
    );
  }

  const run = async (label: string, work: () => Promise<void>) => {
    try {
      await work();
      notifyDataChanged();
    } catch (error) {
      showError(label, error);
    }
  };

  const addAlias = () =>
    run('Could not add', async () => {
      await peopleRepository.addAccount({ personId, bankId: aliasBank, identifier: aliasText, kind: aliasKind });
      setAliasText('');
    });

  const removeAlias = async (alias: PersonAccount) => {
    const ok = await confirm(
      'Remove link?',
      `Transactions matching "${alias.identifier}" will no longer be grouped under ${person.name}.`,
      'Remove',
      true,
    );
    if (ok) await run('Could not remove', () => peopleRepository.removeAccount(alias.id));
  };

  const deletePerson = async () => {
    const ok = await confirm(
      `Delete ${person.name}?`,
      'Their linked names and numbers are removed. Transactions and loans stay as they are.',
      'Delete',
      true,
    );
    if (!ok) return;
    try {
      await peopleRepository.deletePerson(personId);
      notifyDataChanged();
      navigation.goBack();
    } catch (error) {
      showError('Could not delete', error);
    }
  };

  const net = summary.owesMe - summary.iOwe;

  return (
    <Screen edges={['left', 'right', 'bottom']}>
      <Card style={{ gap: spacing.md }}>
        <View style={ui.rowCenter}>
          <PersonAvatar name={person.name} type={person.type} size={52} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.text, fontSize: 20, fontWeight: '700' }} numberOfLines={1}>
              {person.name}
            </Text>
            <Text style={{ color: colors.textSecondary }}>
              {[personTypeMeta(person.type).label, person.phone].filter(Boolean).join(' · ')}
            </Text>
            {summary.firstDate && summary.lastDate ? (
              <Text style={{ color: colors.textMuted, fontSize: 12 }}>
                {formatDate(summary.firstDate, calendar)} – {formatDate(summary.lastDate, calendar)}
              </Text>
            ) : null}
          </View>
        </View>
        {person.note ? <Text style={{ color: colors.textSecondary }}>{person.note}</Text> : null}
        <View style={[ui.rowCenter, { gap: spacing.md }]}>
          <Stat label="You sent" value={summary.sent} color={colors.expense} />
          <Stat label="You received" value={summary.received} color={colors.income} />
        </View>
        <View style={[ui.rowCenter, { gap: spacing.md }]}>
          <Stat label="Owes you" value={summary.owesMe} color={colors.income} />
          <Stat label="You owe" value={summary.iOwe} color={colors.expense} />
        </View>
        <Divider />
        <View style={[ui.rowCenter, { justifyContent: 'space-between' }]}>
          <Text style={{ color: colors.textSecondary }}>
            {summary.activeLoans > 0 ? (net >= 0 ? 'Net, they owe you' : 'Net, you owe them') : 'Net flow (received − sent)'}
          </Text>
          <AmountText
            value={summary.activeLoans > 0 ? Math.abs(net) : summary.net}
            color={(summary.activeLoans > 0 ? net : summary.net) >= 0 ? colors.income : colors.expense}
            style={{ fontWeight: '700', fontSize: 16 }}
          />
        </View>
      </Card>

      <PersonDetailsSection person={person} aliases={aliases} onEdit={() => setEditing(true)} onRemoveAlias={(a) => void removeAlias(a)} />

      <SectionTitle title="Names in messages" />
      <Card style={{ gap: spacing.xs }}>
        <Text style={{ color: colors.textMuted, fontSize: 12 }}>
          Messages are matched to {person.name} by the name each bank prints, or by a phone or account number from Details.
          Their own name always counts at every bank.
        </Text>
        {nameAliases.length === 0 ? (
          <Text style={{ color: colors.textSecondary, paddingVertical: spacing.sm }}>Only their name is used so far.</Text>
        ) : (
          nameAliases.map((alias) => {
            const bank = bankById(banksWithCash, alias.bankId);
            return (
              <ListRow
                key={alias.id}
                left={bank ? <BankAvatar bank={bank} size={36} /> : undefined}
                icon={bank ? undefined : KIND_ICON[alias.kind]}
                title={titleCase(alias.identifier)}
                subtitle={`${KIND_LABEL[alias.kind]} · ${bank?.shortName ?? 'Any bank'}`}
                onLongPress={() => void removeAlias(alias)}
                right={<IconButton name="close" size={18} color={colors.textMuted} onPress={() => void removeAlias(alias)} />}
              />
            );
          })
        )}
        <Divider />
        <Text style={{ color: colors.text, fontWeight: '600', marginTop: spacing.xs }}>Add a name or number</Text>
        <View style={ui.rowWrap}>
          <Chip label="Any bank" selected={aliasBank === null} onPress={() => setAliasBank(null)} />
          {bankOptions.map((b) => (
            <Chip key={b.id} label={b.shortName} selected={aliasBank === b.id} onPress={() => setAliasBank(b.id)} />
          ))}
        </View>
        <TextField
          value={aliasText}
          onChangeText={setAliasText}
          placeholder="e.g. ABEBE KEBEDE, 0911…, 1000…"
          autoCapitalize="characters"
        />
        <View style={[ui.rowCenter, { justifyContent: 'space-between' }]}>
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>
            {aliasText.trim() ? `Saved as: ${KIND_LABEL[aliasKind]}${aliasKind === 'name' ? '' : ' (shown in Details)'}` : ''}
          </Text>
          <Button title="Add" compact icon="add" disabled={!aliasText.trim()} onPress={() => void addAlias()} />
        </View>
      </Card>

      <SectionTitle
        title="Suggested from your messages"
        action={{
          label: showSuggestions ? 'Hide' : suggestions.length > 0 && !suggestQuery ? `Show (${suggestions.length})` : 'Show',
          onPress: () => setShowSuggestions((v) => !v),
        }}
      />
      {showSuggestions ? (
        <Card style={{ gap: spacing.xs }}>
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>
            Counterparties not linked to anyone yet. Tap one to add it to {person.name}.
          </Text>
          <TextField value={suggestQuery} onChangeText={setSuggestQuery} placeholder="Search names in messages" />
          {suggestions.length === 0 ? (
            <Text style={{ color: colors.textSecondary, paddingVertical: spacing.sm }}>No unlinked names found.</Text>
          ) : (
            suggestions.map((s) => {
              const bank = bankById(banksWithCash, s.bankId);
              return (
                <ListRow
                  key={`${s.bankId ?? ''}|${s.normalized}`}
                  left={<BankAvatar bank={bank} size={36} />}
                  title={titleCase(s.name)}
                  subtitle={`${bank?.shortName ?? 'Unknown bank'} · ${s.count} transaction${s.count === 1 ? '' : 's'} · ${formatMoney(s.total, { compact: true })}`}
                  right={s.score > 0 ? <Pill label="Similar" /> : undefined}
                  onPress={() =>
                    void run('Could not add', () =>
                      peopleRepository.addAccount({ personId, bankId: s.bankId, identifier: s.name, kind: 'name' }),
                    )
                  }
                />
              );
            })
          )}
        </Card>
      ) : null}

      <SectionTitle title="Loans & debts" action={{ label: 'All loans', onPress: () => navigation.navigate('Loans') }} />
      <Card style={{ gap: spacing.xs }}>
        {loans.length === 0 ? (
          <Text style={{ color: colors.textSecondary }}>
            None yet. Mark a transaction with {person.name} as "Loan" or "Debt" and use their name as the person.
          </Text>
        ) : (
          loans.map((item) => {
            const date = loanDate(item);
            const lent = item.entry.direction === 'lent';
            const active = item.effectiveStatus === 'active';
            return (
              <ListRow
                key={item.entry.transactionReference}
                icon={lent ? 'call-made' : 'call-received'}
                iconColor={lent ? colors.income : colors.expense}
                title={`${lent ? 'Lent' : 'Borrowed'} ${item.original != null ? formatMoney(item.original) : ''}`.trim()}
                subtitle={[
                  date ? formatDate(date, calendar) : null,
                  active && item.remaining != null ? `${formatMoney(item.remaining)} left` : null,
                  item.repaid > 0 ? `${formatMoney(item.repaid)} repaid` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                right={
                  <Pill
                    label={active ? 'Active' : item.effectiveStatus === 'settled' ? 'Settled' : 'Forgiven'}
                    color={active ? colors.info : item.effectiveStatus === 'settled' ? colors.income : colors.textMuted}
                  />
                }
                onPress={() => navigation.navigate('Loans', { reference: item.entry.transactionReference })}
              />
            );
          })
        )}
      </Card>

      <SectionTitle title={`Transactions${txs.length ? ` (${txs.length})` : ''}`} />
      {txs.length === 0 ? (
        <Card>
          <Text style={{ color: colors.textSecondary }}>
            No transactions matched yet. Add the name their bank shows above, or open a transaction and choose "Person".
          </Text>
        </Card>
      ) : (
        txDays.map((day) => {
          // Net with this person that day: what they sent you minus what you sent them.
          const dayNet = day.items.reduce((sum, tx) => sum + (isCredit(tx) ? 1 : isDebit(tx) ? -1 : 0) * Math.abs(tx.amount), 0);
          return (
            <View key={day.key} style={{ gap: spacing.xs }}>
              <View style={styles.dayHeader}>
                <Text style={[styles.dayLabel, { color: colors.textSecondary }]}>
                  {day.date ? relativeDayLabel(day.date, calendar) : 'Unknown date'}
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
                {day.items.map((tx) => (
                  <ExpandableTransactionRow
                    key={tx.reference}
                    tx={tx}
                    onOpen={() => navigation.push('TransactionDetail', { reference: tx.reference })}
                  />
                ))}
              </Card>
            </View>
          );
        })
      )}
      {txs.length > txLimit ? (
        <Button title={`Show more (${txs.length - txLimit})`} variant="ghost" onPress={() => setTxLimit((n) => n + TX_PAGE)} />
      ) : null}

      <Button title="Delete person" variant="danger" icon="delete" onPress={() => void deletePerson()} />

      <PersonFormSheet visible={editing} onClose={() => setEditing(false)} person={person} onSaved={() => setEditing(false)} />
    </Screen>
  );
}

function Stat(props: { label: string; value: number; color: string }) {
  const colors = useTheme();
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Text style={{ color: colors.textSecondary, fontSize: 12 }}>{props.label}</Text>
      <AmountText value={props.value} color={props.color} style={{ fontSize: 17, fontWeight: '700' }} />
    </View>
  );
}

function loanDate(item: LoanDebtItem): Date | null {
  if (item.sourceTransaction) return txDate(item.sourceTransaction);
  const d = new Date(item.entry.createdAt);
  return Number.isNaN(d.getTime()) ? null : d;
}

const styles = StyleSheet.create({
  dayHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.xs },
  dayLabel: { fontSize: 13, fontWeight: '600' },
});
