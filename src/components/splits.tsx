import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { isManagedCategory, type Category } from '../models/category';
import type { LoanDebtEntry } from '../models/loanDebt';
import type { PeopleGroup } from '../models/peopleGroup';
import type { Person } from '../models/person';
import { splitLoanReference, type TransactionSplit } from '../models/split';
import { isCredit, selectedCategoryIds, txDate, type Transaction } from '../models/transaction';
import { cashLinkRepository } from '../repositories/cashLinkRepository';
import { loanDebtRepository } from '../repositories/loanDebtRepository';
import { peopleGroupRepository } from '../repositories/peopleGroupRepository';
import { peopleRepository } from '../repositories/peopleRepository';
import { splitRepository } from '../repositories/splitRepository';
import { notifyDataChanged, useData } from '../store/dataStore';
import { useSettings, useTheme } from '../store/settingsStore';
import { spacing } from '../theme/colors';
import { CASH_BANK_ID } from '../utils/cashConstants';
import { listPockets, summarizePocket, unlinkedCashSpends, withdrawalReferenceOf } from '../utils/cashPocket';
import { formatDateTime, formatMoney, parseAmountInput } from '../utils/format';
import {
  allocatedAmount,
  entriesFromSplits,
  entriesToDrafts,
  equalEntries,
  groupEntries,
  newEntry,
  validateEntries,
  type SplitEntry,
} from '../utils/splitDrafts';
import { equalSplit, remainingAmount, roundMoney, splitTotal } from '../utils/transactionSplits';
import { confirm, showError } from './dialogs';
import { CategoryIcon, counterpartyOf } from './finance';
import { PersonAvatar, PersonChooser } from './people';
import { Button, Card, Chip, Divider, Icon, ListRow, Pill, ProgressBar, SectionTitle, Sheet, TextField, styles as ui } from './ui';

const EPSILON = 0.005;

function splitFlowCategories(categories: Category[], tx: Transaction): Category[] {
  const flow = isCredit(tx) ? 'income' : 'expense';
  return categories.filter((c) => c.flow === flow && c.id != null && !isManagedCategory(c));
}

// ------------------------------------------------------------------ split section

interface SplitLoanState {
  entry: LoanDebtEntry | null;
  remaining: number | null;
}

/** The parts of a transaction, shown on its detail page. */
export function SplitSection(props: {
  tx: Transaction;
  splits: TransactionSplit[];
  people: Map<number, Person>;
  onEdit: () => void;
  onOpenPerson: (personId: number) => void;
}) {
  const colors = useTheme();
  const { categories, version } = useData();
  const { tx, splits } = props;
  const [loans, setLoans] = useState<Map<number, SplitLoanState>>(new Map());
  const [busy, setBusy] = useState(false);
  const total = Math.abs(tx.amount);
  const left = remainingAmount(total, splits);
  const credit = isCredit(tx);

  useEffect(() => {
    let cancelled = false;
    const loanSplits = splits.filter((s) => s.kind === 'loan');
    void Promise.all(
      loanSplits.map(async (s) => {
        const reference = splitLoanReference(s.parentReference, s.id);
        const [entry, remaining] = await Promise.all([
          loanDebtRepository.getEntryForTransaction(reference),
          loanDebtRepository.getRemainingAmount(reference),
        ]);
        return [s.id, { entry, remaining }] as const;
      }),
    )
      .then((pairs) => {
        if (!cancelled) setLoans(new Map(pairs));
      })
      .catch((error) => {
        if (__DEV__) console.warn('debug: Failed to load split loans', error);
      });
    return () => {
      cancelled = true;
    };
  }, [splits, version]);

  const togglePaid = async (split: TransactionSplit, state: SplitLoanState | undefined) => {
    if (busy) return;
    const paid = state?.entry?.status !== 'active' || state?.remaining === 0;
    setBusy(true);
    try {
      await splitRepository.setLoanStatus(split, paid ? 'active' : 'settled');
      notifyDataChanged();
    } catch (error) {
      showError('Could not update', error);
    } finally {
      setBusy(false);
    }
  };

  if (splits.length === 0) {
    return (
      <>
        <SectionTitle title="Split" />
        <Card style={{ gap: spacing.sm }}>
          <Text style={{ color: colors.textSecondary }}>
            {credit
              ? 'Part of this money for someone else, or for different things? Split it.'
              : 'Paid for several things or for other people? Split it into categories, or into loans to share the bill.'}
          </Text>
          <Button title="Split transaction" icon="call-split" variant="secondary" compact onPress={props.onEdit} />
        </Card>
      </>
    );
  }

  const parentCategory = categories.find((c) => c.id === (tx.categoryIds?.[0] ?? tx.categoryId));
  return (
    <>
      <SectionTitle title="Split" action={{ label: 'Edit', onPress: props.onEdit }} />
      <Card style={{ paddingVertical: spacing.xs }}>
        {splits.map((split) => {
          if (split.kind === 'loan') {
            const person = split.personId != null ? props.people.get(split.personId) : null;
            const state = loans.get(split.id);
            const paid = !!state && (state.entry?.status !== 'active' || state.remaining === 0);
            const partial = !paid && state?.remaining != null && state.remaining < split.amount - EPSILON;
            return (
              <ListRow
                key={split.id}
                left={<PersonAvatar name={person?.name ?? '?'} type={person?.type} size={36} />}
                title={person?.name ?? 'Deleted person'}
                subtitle={[
                  credit ? 'You owe them' : 'Owes you',
                  categories.find((c) => c.id === split.categoryId)?.name,
                  partial ? `${formatMoney(state!.remaining!)} left` : null,
                  split.note,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                onPress={person ? () => props.onOpenPerson(person.id) : undefined}
                right={
                  <View style={{ alignItems: 'flex-end', gap: 4 }}>
                    <Text style={{ color: colors.text, fontWeight: '600' }}>{formatMoney(split.amount)}</Text>
                    <Pressable onPress={() => void togglePaid(split, state)} hitSlop={6}>
                      <Pill label={paid ? 'Paid' : 'Pending'} color={paid ? colors.income : colors.warning} />
                    </Pressable>
                  </View>
                }
              />
            );
          }
          const category = categories.find((c) => c.id === split.categoryId) ?? parentCategory ?? null;
          return (
            <ListRow
              key={split.id}
              left={<CategoryIcon category={category} size={36} />}
              title={category?.name ?? 'Uncategorized'}
              subtitle={split.note}
              right={<Text style={{ color: colors.text, fontWeight: '600' }}>{formatMoney(split.amount)}</Text>}
            />
          );
        })}
        {left > 0 ? (
          <>
            <Divider />
            <ListRow
              left={<CategoryIcon category={parentCategory} size={36} />}
              title={parentCategory ? `Rest · ${parentCategory.name}` : 'Rest'}
              subtitle="Stays with this transaction's categories"
              right={<Text style={{ color: colors.textSecondary, fontWeight: '600' }}>{formatMoney(left)}</Text>}
            />
          </>
        ) : null}
      </Card>
      <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: -spacing.xs }}>
        Tap Paid / Pending to mark a share as settled. Repayments can also be linked from the money they send back.
      </Text>
    </>
  );
}

// ------------------------------------------------------------------ split editor

type EntryPanel = 'category' | 'person' | 'note';

const SPLIT_COUNTS = [2, 3, 4, 5, 6];

/**
 * Splits a transaction into entries. Each entry has an amount, a category and a person: "Me" keeps the part as
 * your own spending in its category, anyone else turns it into a loan to them (or a debt, for money received).
 */
export function SplitEditorSheet(props: { visible: boolean; tx: Transaction; splits: TransactionSplit[]; onClose: () => void }) {
  const colors = useTheme();
  const categories = useData((s) => s.categories);
  const { tx } = props;
  const credit = isCredit(tx);
  const total = Math.abs(tx.amount);
  const [rows, setRows] = useState<SplitEntry[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [groups, setGroups] = useState<PeopleGroup[]>([]);
  const [open, setOpen] = useState<{ key: string; panel: EntryPanel } | null>(null);
  const [groupPicker, setGroupPicker] = useState(false);
  const [includeMe, setIncludeMe] = useState(true);
  const [saving, setSaving] = useState(false);

  const flowCategories = useMemo(() => splitFlowCategories(categories, tx), [categories, tx]);
  const peopleById = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);

  const reloadPeople = () =>
    Promise.all([peopleRepository.getPeople(), peopleGroupRepository.getGroups()])
      .then(([loadedPeople, loadedGroups]) => {
        setPeople(loadedPeople);
        setGroups(loadedGroups);
      })
      .catch((error) => {
        if (__DEV__) console.warn('debug: Failed to load people', error);
      });

  useEffect(() => {
    if (!props.visible) return;
    if (props.splits.length > 0) {
      setRows(entriesFromSplits(props.splits));
    } else {
      // Start with two equal parts, yours first in the transaction's own category.
      const parentCategory = selectedCategoryIds(tx).find((id) => flowCategories.some((c) => c.id === id)) ?? null;
      const [mine, other] = equalEntries(total, 2, []);
      setRows([{ ...mine, categoryId: parentCategory }, other]);
    }
    setOpen(null);
    setGroupPicker(false);
    setIncludeMe(true);
    void reloadPeople();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.visible, tx.reference]);

  const allocated = allocatedAmount(rows);
  const left = roundMoney(total - allocated);

  const update = (key: string, patch: Partial<SplitEntry>) => setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const remove = (key: string) => setRows((prev) => prev.filter((r) => r.key !== key));
  const addEntry = () => {
    const entry = newEntry(Math.max(0, left));
    setRows((prev) => [...prev, entry]);
    setOpen(null);
  };
  const togglePanel = (key: string, panel: EntryPanel) =>
    setOpen((current) => (current?.key === key && current.panel === panel ? null : { key, panel }));

  const createPerson = async (name: string): Promise<number | null> => {
    try {
      const id = await peopleRepository.createPerson({ name });
      await reloadPeople();
      return id;
    } catch (error) {
      showError('Could not add person', error);
      return null;
    }
  };

  const applyGroup = (group: PeopleGroup) => {
    if (group.memberIds.length === 0) {
      Alert.alert('Empty group', `Add people to ${group.name} first (People → Groups).`);
      return;
    }
    setRows((prev) => groupEntries(total, group.memberIds, prev, includeMe));
    setGroupPicker(false);
    setOpen(null);
  };

  const save = async () => {
    const error = validateEntries(total, rows);
    if (error) {
      Alert.alert('Check the parts', error);
      return;
    }
    setSaving(true);
    try {
      await splitRepository.saveSplits({ parentReference: tx.reference, parentType: tx.type, drafts: entriesToDrafts(rows) });
      notifyDataChanged();
      props.onClose();
    } catch (err) {
      showError('Could not save split', err);
    } finally {
      setSaving(false);
    }
  };

  const removeAll = async () => {
    const ok = await confirm('Remove split?', 'The parts and any loans they created are removed.', 'Remove', true);
    if (!ok) return;
    setSaving(true);
    try {
      await splitRepository.deleteForTransaction(tx.reference);
      notifyDataChanged();
      props.onClose();
    } catch (err) {
      showError('Could not remove split', err);
    } finally {
      setSaving(false);
    }
  };

  const over = left < -EPSILON;

  return (
    <Sheet visible={props.visible} onClose={props.onClose} title="Split transaction">
      <View style={{ gap: spacing.md }}>
        <Text style={{ color: colors.textSecondary }}>
          {formatMoney(total)} {credit ? 'from' : 'to'} {counterpartyOf(tx)}. Parts for other people become{' '}
          {credit ? 'debts you owe them' : 'loans they owe you'}. Anything not split stays with the transaction's categories.
        </Text>

        <View style={{ gap: spacing.sm }}>
          <Text style={[styles.label, { color: colors.textSecondary }]}>SPLIT EQUALLY INTO</Text>
          <View style={ui.rowWrap}>
            {SPLIT_COUNTS.map((n) => (
              <Chip
                key={n}
                label={String(n)}
                selected={rows.length === n}
                onPress={() => {
                  setRows((prev) => equalEntries(total, n, prev));
                  setOpen(null);
                }}
              />
            ))}
            <Chip label="Split with group" icon="groups" selected={groupPicker} onPress={() => setGroupPicker((v) => !v)} />
          </View>
        </View>

        {groupPicker ? (
          <Card style={{ gap: spacing.sm, padding: spacing.md }}>
            <Text style={{ color: colors.text, fontWeight: '700' }}>Pick a group</Text>
            {groups.length === 0 ? (
              <Text style={{ color: colors.textSecondary }}>
                No groups yet. Create one under Money → People → Groups, e.g. your flatmates or a team.
              </Text>
            ) : (
              groups.map((group) => (
                <ListRow
                  key={group.id}
                  icon="groups"
                  title={group.name}
                  subtitle={
                    group.memberIds.length === 0
                      ? 'No members'
                      : group.memberIds
                          .map((id) => peopleById.get(id)?.name)
                          .filter(Boolean)
                          .join(', ')
                  }
                  value={`${group.memberIds.length + (includeMe ? 1 : 0)} × ${formatMoney(
                    equalSplit(total, Math.max(1, group.memberIds.length + (includeMe ? 1 : 0)))[0] ?? 0,
                    { compact: true },
                  )}`}
                  onPress={() => applyGroup(group)}
                />
              ))
            )}
            <View style={ui.rowWrap}>
              <Chip label="Include me" icon="person-outline" selected={includeMe} onPress={() => setIncludeMe((v) => !v)} />
            </View>
          </Card>
        ) : null}

        {rows.map((row, index) => (
          <SplitEntryCard
            key={row.key}
            index={index}
            row={row}
            credit={credit}
            categories={flowCategories}
            people={people}
            person={row.personId != null ? peopleById.get(row.personId) ?? null : null}
            panel={open?.key === row.key ? open.panel : null}
            onTogglePanel={(panel) => togglePanel(row.key, panel)}
            onChange={(patch) => update(row.key, patch)}
            onRemove={() => remove(row.key)}
            onCreatePerson={createPerson}
          />
        ))}

        <Button title="Add entry" icon="add" variant="secondary" onPress={addEntry} />

        <Divider />
        <View style={ui.rowCenter}>
          <Text style={[ui.flex, { color: colors.text }]}>
            Split {formatMoney(allocated)} of {formatMoney(total)}
          </Text>
          <Text style={{ color: over ? colors.expense : colors.textSecondary, fontWeight: '600' }}>
            {over ? `${formatMoney(-left)} too much` : `${formatMoney(Math.max(0, left))} left`}
          </Text>
        </View>
        <ProgressBar progress={total > 0 ? allocated / total : 0} color={over ? colors.expense : colors.primary} />
        <Button title="Save split" icon="check" onPress={() => void save()} loading={saving} disabled={over} />
        {props.splits.length > 0 ? (
          <Button title="Remove split" variant="ghost" icon="delete-outline" onPress={() => void removeAll()} disabled={saving} />
        ) : null}
      </View>
    </Sheet>
  );
}

function SplitEntryCard(props: {
  index: number;
  row: SplitEntry;
  credit: boolean;
  categories: Category[];
  people: Person[];
  person: Person | null;
  panel: EntryPanel | null;
  onTogglePanel: (panel: EntryPanel) => void;
  onChange: (patch: Partial<SplitEntry>) => void;
  onRemove: () => void;
  onCreatePerson: (name: string) => Promise<number | null>;
}) {
  const colors = useTheme();
  const { row, person } = props;
  const amount = parseAmountInput(row.amount);
  const amountError = row.amount.trim() && (amount === null || amount <= 0) ? 'Enter a positive amount' : null;
  const category = props.categories.find((c) => c.id === row.categoryId) ?? null;
  const mine = row.personId == null;
  const showNote = props.panel === 'note' || !!row.note;
  return (
    <Card style={{ gap: spacing.sm, padding: spacing.md }}>
      <View style={ui.rowCenter}>
        <Text style={{ color: colors.textMuted, fontWeight: '700', width: 22 }}>{props.index + 1}</Text>
        <TextField
          value={row.amount}
          onChangeText={(v) => props.onChange({ amount: v })}
          keyboardType="decimal-pad"
          placeholder="Amount"
          error={amountError}
          containerStyle={ui.flex}
        />
        <Pressable onPress={props.onRemove} hitSlop={8} accessibilityLabel="Remove entry">
          <Icon name="close" size={20} color={colors.textMuted} />
        </Pressable>
      </View>
      <View style={ui.rowCenter}>
        <EntryButton
          active={props.panel === 'category'}
          left={<CategoryIcon category={category} size={22} />}
          label={category?.name ?? 'Category'}
          muted={!category}
          onPress={() => props.onTogglePanel('category')}
        />
        <EntryButton
          active={props.panel === 'person'}
          left={mine ? <Icon name="person-outline" size={20} color={colors.primary} /> : <PersonAvatar name={person?.name ?? '?'} type={person?.type} size={22} />}
          label={mine ? 'Me' : person?.name ?? (props.people.length > 0 ? 'Deleted person' : '…')}
          onPress={() => props.onTogglePanel('person')}
        />
        <Pressable onPress={() => props.onTogglePanel('note')} hitSlop={8} accessibilityLabel="Note">
          <Icon name="notes" size={20} color={row.note ? colors.primary : colors.textMuted} />
        </Pressable>
      </View>
      {!mine ? (
        <Text style={{ color: colors.textMuted, fontSize: 12 }}>
          {props.credit ? `You owe ${person?.name ?? 'them'} this part` : `${person?.name ?? 'They'} owes you this part`}
        </Text>
      ) : null}
      {props.panel === 'category' ? (
        <View style={ui.rowWrap}>
          {props.categories.map((c) => (
            <Chip
              key={c.id!}
              label={c.name}
              selected={row.categoryId === c.id}
              onPress={() => {
                props.onChange({ categoryId: row.categoryId === c.id ? null : c.id! });
                props.onTogglePanel('category');
              }}
            />
          ))}
        </View>
      ) : null}
      {props.panel === 'person' ? (
        <PersonChooser
          people={props.people}
          selectedId={row.personId}
          allowMe
          onSelect={(id) => {
            props.onChange({ personId: id });
            props.onTogglePanel('person');
          }}
          onCreatePerson={props.onCreatePerson}
        />
      ) : null}
      {showNote ? (
        <TextField value={row.note} onChangeText={(v) => props.onChange({ note: v })} placeholder="Note (optional)" />
      ) : null}
    </Card>
  );
}

function EntryButton(props: { left: React.ReactNode; label: string; active: boolean; muted?: boolean; onPress: () => void }) {
  const colors = useTheme();
  return (
    <Pressable
      onPress={props.onPress}
      style={[
        styles.entryButton,
        { borderColor: props.active ? colors.primary : colors.border, backgroundColor: props.active ? colors.primarySoft : colors.surface },
      ]}
    >
      {props.left}
      <Text style={{ flex: 1, color: props.muted ? colors.textMuted : colors.text }} numberOfLines={1}>
        {props.label}
      </Text>
      <Icon name={props.active ? 'expand-less' : 'expand-more'} size={18} color={colors.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 12, fontWeight: '700', letterSpacing: 0.8 },
  entryButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
});

// ------------------------------------------------------------------ cash pocket

/** On an ATM withdrawal (or its cash wallet credit): how much of the cash has been accounted for. */
export function PocketSection(props: {
  withdrawal: Transaction;
  onOpenTransaction: (reference: string) => void;
  onAddCashSpend: () => void;
}) {
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const { transactions, cashLinks } = useData();
  const [linking, setLinking] = useState(false);
  const summary = useMemo(() => summarizePocket(props.withdrawal, cashLinks, transactions), [props.withdrawal, cashLinks, transactions]);

  const unlink = async (spend: Transaction) => {
    const ok = await confirm('Unlink cash spending?', `${counterpartyOf(spend)} will no longer count against this withdrawal.`, 'Unlink', true);
    if (!ok) return;
    try {
      await cashLinkRepository.unlink(spend.reference);
      notifyDataChanged();
    } catch (error) {
      showError('Could not unlink', error);
    }
  };

  return (
    <>
      <SectionTitle title="Cash pocket" />
      <Card style={{ gap: spacing.sm }}>
        <View style={ui.rowCenter}>
          <Icon name="account-balance-wallet" color={colors.info} />
          <Text style={[ui.flex, { color: colors.text }]}>
            Spent {formatMoney(summary.spent)} of {formatMoney(summary.withdrawn)}
          </Text>
          <Text style={{ color: summary.remaining > 0 ? colors.income : colors.textSecondary, fontWeight: '700' }}>
            {formatMoney(summary.remaining)} left
          </Text>
        </View>
        <ProgressBar progress={summary.withdrawn > 0 ? summary.spent / summary.withdrawn : 0} color={colors.info} />
        {summary.spends.length === 0 ? (
          <Text style={{ color: colors.textMuted }}>
            Link the cash expenses paid from this withdrawal to see where the money went.
          </Text>
        ) : (
          summary.spends.map((spend) => {
            const d = txDate(spend);
            return (
              <ListRow
                key={spend.reference}
                title={counterpartyOf(spend)}
                subtitle={d ? formatDateTime(d, calendar) : null}
                value={formatMoney(Math.abs(spend.amount))}
                onPress={() => props.onOpenTransaction(spend.reference)}
                onLongPress={() => void unlink(spend)}
              />
            );
          })
        )}
        <View style={ui.rowWrap}>
          <Button title="Link cash spending" icon="link" variant="secondary" compact onPress={() => setLinking(true)} />
          <Button title="Add cash expense" icon="add" variant="ghost" compact onPress={props.onAddCashSpend} />
        </View>
        {summary.spends.length > 0 ? (
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>Long-press a spend to unlink it.</Text>
        ) : null}
      </Card>
      <LinkCashSpendsSheet visible={linking} withdrawal={props.withdrawal} remaining={summary.remaining} onClose={() => setLinking(false)} />
    </>
  );
}

function LinkCashSpendsSheet(props: { visible: boolean; withdrawal: Transaction; remaining: number; onClose: () => void }) {
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const { transactions, cashLinks } = useData();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (props.visible) setChosen(new Set());
  }, [props.visible]);

  const candidates = useMemo(
    () => unlinkedCashSpends(transactions, cashLinks, txDate(props.withdrawal)).reverse().slice(0, 100),
    [transactions, cashLinks, props.withdrawal],
  );
  const chosenTotal = candidates.filter((t) => chosen.has(t.reference)).reduce((sum, t) => sum + Math.abs(t.amount), 0);

  const save = async () => {
    setSaving(true);
    try {
      for (const reference of chosen) await cashLinkRepository.link(reference, props.withdrawal.reference);
      notifyDataChanged();
      props.onClose();
    } catch (error) {
      showError('Could not link', error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet visible={props.visible} onClose={props.onClose} title="Paid from this withdrawal">
      <View style={{ gap: spacing.md }}>
        <Text style={{ color: colors.textSecondary }}>
          Cash expenses recorded after the withdrawal that are not linked yet. {formatMoney(props.remaining)} is unaccounted for.
        </Text>
        {candidates.length === 0 ? (
          <Text style={{ color: colors.textMuted }}>No unlinked cash expenses since this withdrawal. Add one from the cash wallet.</Text>
        ) : null}
        {candidates.map((t) => {
          const selected = chosen.has(t.reference);
          const d = txDate(t);
          return (
            <ListRow
              key={t.reference}
              left={<Icon name={selected ? 'check-box' : 'check-box-outline-blank'} color={selected ? colors.primary : colors.textMuted} />}
              title={counterpartyOf(t)}
              subtitle={[d ? formatDateTime(d, calendar) : null, t.note].filter(Boolean).join(' · ')}
              value={formatMoney(Math.abs(t.amount))}
              onPress={() =>
                setChosen((prev) => {
                  const next = new Set(prev);
                  if (next.has(t.reference)) next.delete(t.reference);
                  else next.add(t.reference);
                  return next;
                })
              }
            />
          );
        })}
        <Text style={{ color: chosenTotal - props.remaining > EPSILON ? colors.warning : colors.text }}>
          Selected {formatMoney(chosenTotal)}
          {chosenTotal - props.remaining > EPSILON ? ' (more than what is left)' : ''}
        </Text>
        <Button title="Link" icon="link" onPress={() => void save()} loading={saving} disabled={chosen.size === 0} />
      </View>
    </Sheet>
  );
}

/** On a cash expense: which ATM withdrawal paid for it. */
export function CashSourceSection(props: { tx: Transaction; onOpenTransaction: (reference: string) => void }) {
  const colors = useTheme();
  const { transactions, cashLinks } = useData();
  const [picking, setPicking] = useState(false);
  const link = cashLinks.find((l) => l.cashReference === props.tx.reference);
  const withdrawal = link ? transactions.find((t) => t.reference === link.withdrawalReference) ?? null : null;
  const summary = useMemo(
    () => (withdrawal ? summarizePocket(withdrawal, cashLinks, transactions) : null),
    [withdrawal, cashLinks, transactions],
  );

  const unlink = async () => {
    try {
      await cashLinkRepository.unlink(props.tx.reference);
      notifyDataChanged();
    } catch (error) {
      showError('Could not unlink', error);
    }
  };

  return (
    <>
      <SectionTitle title="Paid from" />
      <Card style={{ gap: spacing.sm }}>
        {withdrawal && summary ? (
          <>
            <ListRow
              icon="local-atm"
              iconColor={colors.info}
              title={`ATM withdrawal · ${formatMoney(summary.withdrawn)}`}
              subtitle={`${formatMoney(summary.remaining)} of it left unaccounted`}
              chevron
              onPress={() => props.onOpenTransaction(withdrawal.reference)}
            />
            <View style={ui.rowWrap}>
              <Button title="Change" variant="ghost" compact onPress={() => setPicking(true)} />
              <Button title="Unlink" variant="ghost" compact onPress={() => void unlink()} />
            </View>
          </>
        ) : (
          <>
            <Text style={{ color: colors.textSecondary }}>Was this paid with cash from an ATM withdrawal?</Text>
            <Button title="Pick withdrawal" icon="local-atm" variant="secondary" compact onPress={() => setPicking(true)} />
          </>
        )}
      </Card>
      <PickWithdrawalSheet visible={picking} tx={props.tx} currentReference={withdrawal?.reference ?? null} onClose={() => setPicking(false)} />
    </>
  );
}

export function PickWithdrawalSheet(props: {
  visible: boolean;
  tx: Transaction | null;
  currentReference: string | null;
  onClose: () => void;
  /** When set, the choice is returned instead of saved (used before the cash expense exists). */
  onPick?: (withdrawalReference: string) => void;
}) {
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const { transactions, cashLinks } = useData();
  const spendTime = props.tx ? txDate(props.tx)?.getTime() ?? null : null;
  const pockets = useMemo(
    () =>
      listPockets(transactions, cashLinks)
        .filter((p) => spendTime === null || (txDate(p.withdrawal)?.getTime() ?? 0) <= spendTime + 60_000)
        .filter((p) => p.summary.remaining > EPSILON || p.withdrawal.reference === props.currentReference)
        .slice(0, 30),
    [transactions, cashLinks, spendTime, props.currentReference],
  );

  const pick = async (reference: string) => {
    if (props.onPick) {
      props.onPick(reference);
      props.onClose();
      return;
    }
    if (!props.tx) return;
    try {
      await cashLinkRepository.link(props.tx.reference, reference);
      notifyDataChanged();
      props.onClose();
    } catch (error) {
      showError('Could not link', error);
    }
  };

  return (
    <Sheet visible={props.visible} onClose={props.onClose} title="Which withdrawal?">
      <View style={{ gap: spacing.sm }}>
        {pockets.length === 0 ? (
          <Text style={{ color: colors.textMuted }}>No ATM withdrawals with cash left before this expense.</Text>
        ) : null}
        {pockets.map(({ withdrawal, summary }) => {
          const d = txDate(withdrawal);
          const current = withdrawal.reference === props.currentReference;
          return (
            <ListRow
              key={withdrawal.reference}
              icon="local-atm"
              iconColor={colors.info}
              title={`${formatMoney(summary.withdrawn)} · ${formatMoney(summary.remaining)} left`}
              subtitle={d ? formatDateTime(d, calendar) : null}
              right={current ? <Icon name="check" color={colors.primary} /> : undefined}
              onPress={() => void pick(withdrawal.reference)}
            />
          );
        })}
      </View>
    </Sheet>
  );
}

/** The withdrawal a transaction's pocket belongs to: itself, or the bank debit behind an ATM cash credit. */
export function pocketWithdrawalFor(tx: Transaction, transactions: readonly Transaction[], atmRefs: ReadonlySet<string>): Transaction | null {
  if (atmRefs.has(tx.reference)) return tx;
  const linked = withdrawalReferenceOf(tx);
  if (!linked) return null;
  return transactions.find((t) => t.reference === linked) ?? null;
}

export function isCashSpend(tx: Transaction): boolean {
  return tx.bankId === CASH_BANK_ID && !isCredit(tx) && tx.type === 'DEBIT';
}

export { splitTotal };
