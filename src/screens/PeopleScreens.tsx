import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { confirm, showError } from '../components/dialogs';
import { AmountText, BankAvatar, sortByTimeDesc, TransactionRow } from '../components/finance';
import { PersonAvatar, PersonFormSheet } from '../components/people';
import {
  Button,
  Card,
  Chip,
  Divider,
  EmptyState,
  IconButton,
  ListRow,
  Pill,
  Screen,
  SectionTitle,
  SegmentedControl,
  TextField,
  styles as ui,
} from '../components/ui';
import type { PersonAccount, PersonAccountKind } from '../models/person';
import { txDate, type Transaction } from '../models/transaction';
import type { StackScreenProps } from '../navigation/types';
import { bankById } from '../repositories/bankRepository';
import { peopleRepository } from '../repositories/peopleRepository';
import { loadLoanDebtItems, type LoanDebtItem } from '../services/loanDebtSummary';
import { notifyDataChanged, useData } from '../store/dataStore';
import { useSettings, useTheme } from '../store/settingsStore';
import { spacing } from '../theme/colors';
import { formatDate, formatMoney, relativeDayLabel, titleCase } from '../utils/format';
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

export function PeopleScreen({ navigation }: StackScreenProps<'People'>) {
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const { index, byPerson, loansByPerson } = usePeopleData();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<PeopleSort>('recent');
  const [adding, setAdding] = useState(false);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => <IconButton name="person-add" accessibilityLabel="Add person" onPress={() => setAdding(true)} />,
    });
  }, [navigation]);

  const rows = useMemo(() => {
    const key = normalizePersonName(query);
    const list = (index?.people ?? [])
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
  }, [index, byPerson, loansByPerson, query, sort]);

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

  if (!index) {
    return (
      <Screen edges={['left', 'right', 'bottom']}>
        <Text style={{ color: colors.textSecondary }}>Loading…</Text>
      </Screen>
    );
  }

  return (
    <Screen edges={['left', 'right', 'bottom']}>
      {index.people.length === 0 ? (
        <EmptyState
          icon="people"
          title="No people yet"
          message="Add someone you send money to or receive from. Link their CBE, telebirr and other accounts by the name each bank prints, or by their phone or account number, and every matching message is grouped under them."
          action={{ label: 'Add person', onPress: () => setAdding(true) }}
        />
      ) : (
        <>
          <View style={[ui.rowCenter, { gap: spacing.md }]}>
            <Card style={{ flex: 1, gap: 4 }}>
              <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Owed to you</Text>
              <AmountText value={totals.owesMe} color={colors.income} style={{ fontSize: 18, fontWeight: '700' }} compact />
            </Card>
            <Card style={{ flex: 1, gap: 4 }}>
              <Text style={{ color: colors.textSecondary, fontSize: 12 }}>You owe</Text>
              <AmountText value={totals.iOwe} color={colors.expense} style={{ fontSize: 18, fontWeight: '700' }} compact />
            </Card>
          </View>
          <TextField value={query} onChangeText={setQuery} placeholder="Search people" />
          <SegmentedControl<PeopleSort>
            options={[
              { value: 'recent', label: 'Recent' },
              { value: 'owed', label: 'Balance' },
              { value: 'name', label: 'Name' },
            ]}
            value={sort}
            onChange={setSort}
          />
          {rows.length === 0 ? <Text style={{ color: colors.textMuted }}>No one matches "{query.trim()}".</Text> : null}
          {rows.map(({ person, summary }) => (
            <Card key={person.id} onPress={() => navigation.navigate('PersonDetail', { personId: person.id })} style={{ gap: spacing.sm }}>
              <View style={ui.rowCenter}>
                <PersonAvatar name={person.name} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }} numberOfLines={1}>
                    {person.name}
                  </Text>
                  <Text style={{ color: colors.textSecondary, fontSize: 12 }} numberOfLines={1}>
                    {summary.count === 0
                      ? 'No transactions matched yet'
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
      <PersonFormSheet
        visible={adding}
        onClose={() => setAdding(false)}
        onSaved={(personId) => {
          setAdding(false);
          navigation.navigate('PersonDetail', { personId });
        }}
      />
    </Screen>
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
          <PersonAvatar name={person.name} size={52} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.text, fontSize: 20, fontWeight: '700' }} numberOfLines={1}>
              {person.name}
            </Text>
            {person.phone ? <Text style={{ color: colors.textSecondary }}>{person.phone}</Text> : null}
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

      <SectionTitle title="Accounts & names" />
      <Card style={{ gap: spacing.xs }}>
        <Text style={{ color: colors.textMuted, fontSize: 12 }}>
          Messages are matched to {person.name} by the name each bank prints, or by a phone or account number in the
          message. Their own name always counts at every bank. Long-press to remove.
        </Text>
        {aliases.length === 0 ? (
          <Text style={{ color: colors.textSecondary, paddingVertical: spacing.sm }}>Only their name is used so far.</Text>
        ) : (
          aliases.map((alias) => {
            const bank = bankById(banksWithCash, alias.bankId);
            return (
              <ListRow
                key={alias.id}
                left={bank ? <BankAvatar bank={bank} size={36} /> : undefined}
                icon={bank ? undefined : KIND_ICON[alias.kind]}
                title={alias.kind === 'name' ? titleCase(alias.identifier) : alias.identifier}
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
            {aliasText.trim() ? `Saved as: ${KIND_LABEL[aliasKind]}` : ''}
          </Text>
          <Button title="Add" compact icon="add" disabled={!aliasText.trim()} onPress={() => void addAlias()} />
        </View>
      </Card>

      <SectionTitle title="Suggested from your messages" />
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
      <Card style={{ gap: spacing.xs }}>
        {txs.length === 0 ? (
          <Text style={{ color: colors.textSecondary }}>
            No transactions matched yet. Add the name their bank shows above, or open a transaction and choose "Person".
          </Text>
        ) : (
          txs
            .slice(0, txLimit)
            .map((tx) => (
              <TransactionRow
                key={tx.reference}
                tx={tx}
                showDate
                onPress={() => navigation.push('TransactionDetail', { reference: tx.reference })}
              />
            ))
        )}
        {txs.length > txLimit ? (
          <Button title={`Show more (${txs.length - txLimit})`} variant="ghost" onPress={() => setTxLimit((n) => n + TX_PAGE)} />
        ) : null}
      </Card>

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
  if (item.transaction) return txDate(item.transaction);
  const d = new Date(item.entry.createdAt);
  return Number.isNaN(d.getTime()) ? null : d;
}
