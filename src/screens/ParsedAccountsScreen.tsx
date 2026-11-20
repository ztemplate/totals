import * as Clipboard from 'expo-clipboard';
import React, { memo, useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, SectionList, StyleSheet, Text, View } from 'react-native';
import { showError } from '../components/dialogs';
import { AmountText, BankAvatar, TransactionRow } from '../components/finance';
import { PersonAvatar, PersonChooser } from '../components/people';
import { Button, Card, Chip, Divider, EmptyState, Icon, ListRow, Loading, Pill, SegmentedControl, Sheet, TextField, styles as ui } from '../components/ui';
import type { Bank } from '../models/bank';
import type { Person } from '../models/person';
import { txDate, type Transaction } from '../models/transaction';
import type { AppNavigation, StackScreenProps } from '../navigation/types';
import { bankById } from '../repositories/bankRepository';
import { peopleRepository } from '../repositories/peopleRepository';
import { sourceSmsRepository } from '../repositories/sourceSmsRepository';
import { notifyDataChanged, useData } from '../store/dataStore';
import { useSettings, useTheme } from '../store/settingsStore';
import { spacing } from '../theme/colors';
import { suggestedAccountHolderNameFromSms } from '../utils/accountIdentity';
import { formatDate, formatNumber, titleCase } from '../utils/format';
import {
  buildParsedAccounts,
  filterParsedAccounts,
  groupParsedAccountsByPerson,
  parsedAccountNumberLabel,
  type ParsedAccount,
  type ParsedAccountKind,
  type ParsedAccountScope,
} from '../utils/parsedAccounts';
import type { PeopleIndex } from '../utils/personMatching';
import type { UnlabeledAccount } from '../utils/unlabeledAccounts';
import { LabelAccountSheet } from './AccountsScreens';

type Show = 'accounts' | 'counterparties' | 'all';
type PersonFilter = number | 'unassigned' | null;

const KINDS: Record<Show, ParsedAccountKind[]> = {
  accounts: ['mine', 'unlabeled'],
  counterparties: ['counterparty'],
  all: ['mine', 'unlabeled', 'counterparty'],
};

const KIND_LABEL: Record<ParsedAccountKind, string> = {
  mine: 'My accounts',
  unlabeled: 'Unlabeled accounts',
  counterparty: 'Counterparties',
};

const SHEET_TITLE: Record<ParsedAccountKind, string> = {
  mine: 'My account',
  unlabeled: 'Unlabeled account',
  counterparty: 'Counterparty',
};

const MESSAGE_PAGE = 20;

function plural(n: number, word: string): string {
  return `${formatNumber(n, 0)} ${word}${n === 1 ? '' : 's'}`;
}

function dateSpan(item: ParsedAccount, calendar: 'gregorian' | 'ethiopian'): string | null {
  if (!item.firstDate || !item.lastDate) return null;
  const first = formatDate(item.firstDate, calendar);
  const last = formatDate(item.lastDate, calendar);
  return first === last ? first : `${first} – ${last}`;
}

/** Greeting names ("Dear Abebe") from the newest messages of unlabeled accounts, read in one query. */
function useGreetingNames(items: readonly ParsedAccount[]): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    const wanted = items.filter((i) => i.kind === 'unlabeled' && !i.holderName);
    if (wanted.length === 0) return;
    let cancelled = false;
    const refsByKey = new Map(wanted.map((i) => [i.key, i.references.slice(-10)]));
    sourceSmsRepository
      .getForTransactionReferences([...refsByKey.values()].flat())
      .then((messages) => {
        if (cancelled) return;
        const bodies = new Map(messages.map((m) => [m.transactionReference, m.body]));
        const next = new Map<string, string>();
        for (const [key, refs] of refsByKey) {
          const name = refs
            .map((r) => bodies.get(r))
            .reverse()
            .map((b) => (b ? suggestedAccountHolderNameFromSms(b) : null))
            .find(Boolean);
          if (name) next.set(key, titleCase(name));
        }
        setNames(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [items]);
  return names;
}

const ParsedAccountRow = memo(function ParsedAccountRow(props: {
  item: ParsedAccount;
  bank: Bank | null;
  person: Person | null;
  holderName: string | null;
  calendar: 'gregorian' | 'ethiopian';
  onPress: (key: string) => void;
}) {
  const colors = useTheme();
  const { item, bank, person } = props;
  const span = dateSpan(item, props.calendar);
  const details = [plural(item.count, 'message'), span].filter(Boolean).join(' · ');
  return (
    <Pressable
      onPress={() => props.onPress(item.key)}
      style={({ pressed }) => [rowStyles.row, { borderColor: colors.border }, pressed && { backgroundColor: colors.surfaceMuted }]}
    >
      <BankAvatar bank={bank} size={40} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[rowStyles.title, { color: colors.text }]} numberOfLines={1}>
          {bank?.shortName || bank?.name || 'Bank'} · {parsedAccountNumberLabel(item)}
        </Text>
        {props.holderName ? (
          <Text style={{ color: colors.textSecondary, fontSize: 13 }} numberOfLines={1}>
            {props.holderName}
          </Text>
        ) : null}
        <Text style={{ color: colors.textMuted, fontSize: 12 }} numberOfLines={1}>
          {details}
        </Text>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 4, maxWidth: '40%' }}>
        {item.kind !== 'counterparty' && item.lastBalance !== null ? (
          <AmountText value={item.lastBalance} style={{ fontWeight: '700' }} />
        ) : item.kind === 'counterparty' ? (
          <AmountText value={item.debit + item.credit} compact style={{ color: colors.textSecondary, fontSize: 13 }} />
        ) : null}
        {person ? (
          <Pill label={person.name} color={item.personSource === 'transactions' ? colors.info : colors.primary} />
        ) : (
          <Pill label="Unassigned" color={colors.textMuted} />
        )}
      </View>
    </Pressable>
  );
});

export function ParsedAccountsScreen({ route, navigation }: StackScreenProps<'ParsedAccounts'>) {
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const { transactions, accounts, banks, version } = useData();
  const [index, setIndex] = useState<PeopleIndex | null>(null);
  const [scope, setScope] = useState<ParsedAccountScope>('all');
  const [bankId, setBankId] = useState<number | null>(route.params?.bankId ?? null);
  const [person, setPerson] = useState<PersonFilter>(route.params?.personId ?? null);
  const [show, setShow] = useState<Show>(route.params?.personId != null ? 'all' : 'accounts');
  const [byPerson, setByPerson] = useState(false);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [labeling, setLabeling] = useState<UnlabeledAccount | null>(null);

  useEffect(() => {
    if (route.params?.bankId !== undefined) setBankId(route.params.bankId ?? null);
    if (route.params?.personId !== undefined) {
      setPerson(route.params.personId ?? null);
      if (route.params.personId != null) setShow('all');
    }
  }, [route.params?.bankId, route.params?.personId]);

  useEffect(() => {
    let cancelled = false;
    peopleRepository
      .loadIndex()
      .then((loaded) => {
        if (!cancelled) setIndex(loaded);
      })
      .catch((error) => showError('Could not load people', error));
    return () => {
      cancelled = true;
    };
  }, [version]);

  const items = useMemo(
    () => (index ? buildParsedAccounts({ transactions, accounts, banks, peopleIndex: index }) : []),
    [transactions, accounts, banks, index],
  );
  const greetingNames = useGreetingNames(items);
  const people = index?.people ?? [];
  const peopleById = index?.byId ?? new Map<number, Person>();
  const banksById = useMemo(() => new Map(banks.map((b) => [b.id, b])), [banks]);
  const holderOf = useCallback((item: ParsedAccount) => item.holderName ?? greetingNames.get(item.key) ?? null, [greetingNames]);

  const filtered = useMemo(
    () =>
      filterParsedAccounts(
        items.map((i) => (i.holderName || !greetingNames.has(i.key) ? i : { ...i, holderName: greetingNames.get(i.key)! })),
        { scope, bankId, person, kinds: KINDS[show], query: deferredQuery },
        { banks, people },
      ),
    [items, greetingNames, scope, bankId, person, show, deferredQuery, banks, people],
  );

  // Banks and people that actually have accounts in the current scope, for the filter chips.
  const bankChips = useMemo(() => {
    const counts = new Map<number, number>();
    for (const item of items) {
      if (!KINDS[show].includes(item.kind)) continue;
      if ((scope === 'banks' && item.provider) || (scope === 'providers' && !item.provider)) continue;
      counts.set(item.bankId, (counts.get(item.bankId) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([id, count]) => ({ bank: banksById.get(id) ?? null, id, count }))
      .sort((a, b) => b.count - a.count || a.id - b.id);
  }, [items, show, scope, banksById]);
  const personChips = useMemo(() => {
    const ids = new Set(items.map((i) => i.personId).filter((id): id is number => id !== null));
    if (typeof person === 'number') ids.add(person);
    return people.filter((p) => ids.has(p.id));
  }, [items, people, person]);

  const sections = useMemo(() => {
    if (byPerson) {
      return groupParsedAccountsByPerson(filtered, people).map((group) => ({
        key: group.person ? `p${group.person.id}` : 'unassigned',
        title: group.person?.name ?? 'Unassigned',
        person: group.person,
        data: group.accounts,
      }));
    }
    const out: { key: string; title: string; person: Person | null; data: ParsedAccount[] }[] = [];
    for (const kind of KINDS[show]) {
      const data = filtered.filter((i) => i.kind === kind);
      if (data.length > 0) out.push({ key: kind, title: KIND_LABEL[kind], person: null, data });
    }
    return out;
  }, [byPerson, filtered, people, show]);

  const selected = selectedKey ? items.find((i) => i.key === selectedKey) ?? null : null;
  const onPressRow = useCallback((key: string) => setSelectedKey(key), []);
  const messageCount = filtered.reduce((sum, i) => sum + i.count, 0);

  if (!index) return <Loading />;

  const header = (
    <View style={{ gap: spacing.sm, paddingBottom: spacing.sm }}>
      <TextField value={query} onChangeText={setQuery} placeholder="Search bank, number, name or person" autoCorrect={false} />
      <SegmentedControl<Show>
        options={[
          { value: 'accounts', label: 'Accounts' },
          { value: 'counterparties', label: 'Counterparties' },
          { value: 'all', label: 'Both' },
        ]}
        value={show}
        onChange={setShow}
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        <Chip label="All" selected={scope === 'all'} onPress={() => setScope('all')} />
        <Chip label="Banks" icon="account-balance" selected={scope === 'banks'} onPress={() => setScope('banks')} />
        <Chip label="Providers" icon="smartphone" selected={scope === 'providers'} onPress={() => setScope('providers')} />
        <View style={[styles.chipDivider, { backgroundColor: colors.border }]} />
        {bankChips.map(({ bank, id, count }) => (
          <Chip
            key={id}
            label={`${bank?.shortName ?? `Bank ${id}`} ${count}`}
            selected={bankId === id}
            onPress={() => setBankId(bankId === id ? null : id)}
          />
        ))}
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        <Chip label="Everyone" icon="people" selected={person === null} onPress={() => setPerson(null)} />
        <Chip label="Unassigned" icon="person-off" selected={person === 'unassigned'} onPress={() => setPerson('unassigned')} />
        {personChips.map((p) => (
          <Chip key={p.id} label={p.name} icon="person" selected={person === p.id} onPress={() => setPerson(person === p.id ? null : p.id)} />
        ))}
      </ScrollView>
      <View style={[ui.rowCenter, { justifyContent: 'space-between' }]}>
        <Text style={{ color: colors.textSecondary, fontSize: 13, flex: 1 }}>
          {plural(filtered.length, 'account')} · {plural(messageCount, 'message')}
        </Text>
        <Chip label="Group by person" icon="account-tree" selected={byPerson} onPress={() => setByPerson((v) => !v)} />
      </View>
    </View>
  );

  return (
    <View style={[ui.flex, { backgroundColor: colors.background }]}>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.key}
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl * 2 }}
        keyboardShouldPersistTaps="handled"
        stickySectionHeadersEnabled={false}
        initialNumToRender={15}
        windowSize={11}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <EmptyState
            icon="manage-search"
            title={items.length === 0 ? 'No accounts found yet' : 'Nothing matches'}
            message={
              items.length === 0
                ? 'Scan your bank SMS under Money → Accounts. Every account in them shows up here.'
                : 'Try another bank, person or search.'
            }
          />
        }
        renderSectionHeader={({ section }) => (
          <Pressable
            disabled={!section.person}
            onPress={() => section.person && navigation.navigate('PersonDetail', { personId: section.person.id })}
            style={[ui.rowCenter, styles.sectionHeader]}
          >
            {section.person ? <PersonAvatar name={section.person.name} type={section.person.type} size={28} /> : null}
            <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
              {section.title.toUpperCase()} ({section.data.length})
            </Text>
            {section.person ? <Icon name="chevron-right" size={18} color={colors.textMuted} /> : null}
          </Pressable>
        )}
        renderItem={({ item }) => (
          <ParsedAccountRow
            item={item}
            bank={banksById.get(item.bankId) ?? null}
            person={item.personId !== null ? peopleById.get(item.personId) ?? null : null}
            holderName={holderOf(item)}
            calendar={calendar}
            onPress={onPressRow}
          />
        )}
      />
      <ParsedAccountSheet
        item={selected}
        holderName={selected ? holderOf(selected) : null}
        bank={selected ? bankById(banks, selected.bankId) : null}
        people={people}
        peopleById={peopleById}
        transactions={transactions}
        navigation={navigation as unknown as AppNavigation}
        onClose={() => setSelectedKey(null)}
        onLabel={(group) => {
          setSelectedKey(null);
          setLabeling(group);
        }}
      />
      <LabelAccountSheet item={labeling} onClose={() => setLabeling(null)} />
    </View>
  );
}

/** One account: its numbers, who it belongs to, and its messages with the SMS they came from. */
function ParsedAccountSheet(props: {
  item: ParsedAccount | null;
  holderName: string | null;
  bank: Bank | null;
  people: Person[];
  peopleById: Map<number, Person>;
  transactions: Transaction[];
  navigation: AppNavigation;
  onClose: () => void;
  onLabel: (group: UnlabeledAccount) => void;
}) {
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const { item, bank, navigation } = props;
  const [saving, setSaving] = useState(false);
  const [showMessages, setShowMessages] = useState(false);
  const [limit, setLimit] = useState(MESSAGE_PAGE);
  const [bodies, setBodies] = useState<Map<string, string>>(new Map());
  const itemKey = item?.key ?? null;

  useEffect(() => {
    setShowMessages(false);
    setLimit(MESSAGE_PAGE);
    setBodies(new Map());
  }, [itemKey]);

  const messages = useMemo(() => {
    if (!item || !showMessages) return [];
    const refs = new Set(item.references);
    return props.transactions
      .filter((t) => refs.has(t.reference))
      .sort((a, b) => (txDate(b)?.getTime() ?? 0) - (txDate(a)?.getTime() ?? 0));
  }, [item, showMessages, props.transactions]);
  const visible = messages.slice(0, limit);

  useEffect(() => {
    const missing = visible.map((t) => t.reference).filter((r) => !bodies.has(r));
    if (missing.length === 0) return;
    let cancelled = false;
    sourceSmsRepository
      .getForTransactionReferences(missing)
      .then((found) => {
        if (cancelled) return;
        setBodies((current) => {
          const next = new Map(current);
          for (const r of missing) next.set(r, '');
          for (const m of found) next.set(m.transactionReference, m.body);
          return next;
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.length, itemKey, showMessages]);

  if (!item) return null;

  const owner = item.personId !== null ? props.peopleById.get(item.personId) ?? null : null;
  const savedOwner = item.personSource === 'number';
  const canAssign = !!item.accountNumber;

  const assign = async (personId: number | null) => {
    if (!item.accountNumber || saving) return;
    if (personId !== null && personId === item.personId && savedOwner) return;
    setSaving(true);
    try {
      await peopleRepository.setAccountOwner({
        bankId: item.bankId,
        accountNumber: item.accountNumber,
        wallet: item.provider,
        personId,
        replaceAliasIds: item.personAliasIds,
      });
      notifyDataChanged();
    } catch (error) {
      showError('Could not save', error);
    } finally {
      setSaving(false);
    }
  };

  const createPerson = async (name: string): Promise<number | null> => {
    try {
      return await peopleRepository.createPerson({ name });
    } catch (error) {
      showError('Could not add person', error);
      return null;
    }
  };

  const go = (open: () => void) => {
    props.onClose();
    open();
  };

  const stats: [string, React.ReactNode][] = [
    ['Messages', <Text style={{ color: colors.text }}>{formatNumber(item.count, 0)}</Text>],
    ['Money in', <AmountText value={item.credit} color={colors.income} />],
    ['Money out', <AmountText value={item.debit} />],
  ];
  if (item.kind !== 'counterparty' && item.lastBalance !== null) stats.push(['Last balance', <AmountText value={item.lastBalance} />]);
  if (item.firstDate) stats.push(['First seen', <Text style={{ color: colors.text }}>{formatDate(item.firstDate, calendar)}</Text>]);
  if (item.lastDate) stats.push(['Last seen', <Text style={{ color: colors.text }}>{formatDate(item.lastDate, calendar)}</Text>]);

  return (
    <Sheet visible onClose={props.onClose} title={SHEET_TITLE[item.kind]}>
      <View style={{ gap: spacing.md }}>
        <View style={[ui.rowCenter, { gap: spacing.md }]}>
          <BankAvatar bank={bank} size={44} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }}>{bank?.name ?? 'Bank'}</Text>
            <Pressable
              disabled={!item.accountNumber}
              onPress={() =>
                item.accountNumber &&
                void Clipboard.setStringAsync(item.accountNumber).then(() => Alert.alert('Copied', 'Number copied to clipboard.'))
              }
            >
              <Text style={{ color: colors.textSecondary }} selectable>
                {parsedAccountNumberLabel(item)}
                {item.provider ? ' · wallet' : ''}
              </Text>
            </Pressable>
            {props.holderName ? <Text style={{ color: colors.textSecondary, fontSize: 13 }}>{props.holderName}</Text> : null}
          </View>
        </View>

        <Card style={{ gap: spacing.xs, paddingVertical: spacing.sm }}>
          {stats.map(([label, value]) => (
            <View key={label} style={[ui.rowCenter, { justifyContent: 'space-between' }]}>
              <Text style={{ color: colors.textSecondary }}>{label}</Text>
              {value}
            </View>
          ))}
        </Card>

        <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>BELONGS TO</Text>
        {owner ? (
          <ListRow
            left={<PersonAvatar name={owner.name} type={owner.type} size={36} />}
            title={owner.name}
            subtitle={savedOwner ? 'Saved on their page under Details' : 'Guessed from their matched messages · pick to save'}
            chevron
            onPress={() => go(() => navigation.navigate('PersonDetail', { personId: owner.id }))}
          />
        ) : (
          <Text style={{ color: colors.textMuted }}>Unassigned</Text>
        )}
        {canAssign ? (
          <>
            <PersonChooser
              people={props.people}
              selectedId={savedOwner ? item.personId : undefined}
              onSelect={(id) => void assign(id)}
              onCreatePerson={createPerson}
            />
            {owner && savedOwner ? (
              <Button title="Clear person" icon="person-remove" variant="ghost" compact disabled={saving} onPress={() => void assign(null)} />
            ) : null}
            <Text style={{ color: colors.textMuted, fontSize: 12 }}>
              Saved as their {item.provider ? 'wallet number' : 'account number'} for {bank?.shortName ?? 'this bank'}. Money sent to or from
              it is grouped under them in People too.
            </Text>
          </>
        ) : (
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>
            This wallet&apos;s own number isn&apos;t printed in its messages. Label it with its number first, then pick who it belongs to.
          </Text>
        )}

        <Divider />
        {item.account ? (
          <Button
            title="Open account"
            icon="account-balance-wallet"
            variant="secondary"
            onPress={() =>
              go(() => navigation.navigate('AccountDetail', { accountNumber: item.account!.accountNumber, bank: item.account!.bank }))
            }
          />
        ) : null}
        {item.unlabeled ? (
          <Button title="Label as my account" icon="label" variant="secondary" onPress={() => props.onLabel(item.unlabeled!)} />
        ) : null}
        {item.count > 0 ? (
          showMessages ? null : (
            <Button title={`Show ${plural(item.count, 'message')}`} icon="sms" variant="ghost" onPress={() => setShowMessages(true)} />
          )
        ) : (
          <Text style={{ color: colors.textMuted }}>No messages for this account yet.</Text>
        )}
        {showMessages ? (
          <View style={{ gap: spacing.xs }}>
            {visible.map((tx) => {
              const body = bodies.get(tx.reference);
              return (
                <View key={tx.reference} style={[styles.message, { borderColor: colors.border }]}>
                  <TransactionRow tx={tx} showDate onPress={() => go(() => navigation.navigate('TransactionDetail', { reference: tx.reference }))} />
                  {body === undefined ? null : body ? (
                    <Text style={{ color: colors.textSecondary, fontSize: 12 }} selectable>
                      {body}
                    </Text>
                  ) : (
                    <Text style={{ color: colors.textMuted, fontSize: 12, fontStyle: 'italic' }}>Original SMS not kept for this one.</Text>
                  )}
                </View>
              );
            })}
            {messages.length > visible.length ? (
              <Button
                title={`Show more (${formatNumber(messages.length - visible.length, 0)} left)`}
                variant="ghost"
                compact
                onPress={() => setLimit((l) => l + MESSAGE_PAGE)}
              />
            ) : null}
          </View>
        ) : null}
      </View>
    </Sheet>
  );
}

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 15, fontWeight: '600' },
});

const styles = StyleSheet.create({
  chips: { gap: spacing.sm, alignItems: 'center' },
  chipDivider: { width: StyleSheet.hairlineWidth, height: 24 },
  sectionHeader: { paddingTop: spacing.md, paddingBottom: spacing.xs, gap: spacing.sm },
  sectionTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 0.8 },
  message: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: spacing.sm, gap: spacing.xs },
});
