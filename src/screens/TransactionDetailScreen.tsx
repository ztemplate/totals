import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { confirm, showError } from '../components/dialogs';
import { AmountText, BankAvatar, CategoryIcon, counterpartyOf } from '../components/finance';
import { DateField } from '../components/dateRange';
import { PersonPickerSheet } from '../components/people';
import { CashSourceSection, PocketSection, SplitEditorSheet, SplitSection, isCashSpend, pocketWithdrawalFor } from '../components/splits';
import { Button, Card, Chip, Divider, EmptyState, Icon, ListRow, Loading, SectionTitle, Sheet, TextField, styles as ui } from '../components/ui';
import {
  isLoanDebtCategory,
  isManagedCategory,
  isReimbursementCategory,
  isRepaymentCategory,
  type Category,
} from '../models/category';
import type { LoanDebtDirection, LoanDebtEntry, LoanDebtRepayment, ReimbursementAllocation } from '../models/loanDebt';
import type { TransactionSourceSms } from '../models/misc';
import {
  isCredit,
  isDebit,
  makeTransaction,
  selectedCategoryIds,
  txDate,
  txDisplayReference,
  type Transaction,
} from '../models/transaction';
import type { StackScreenProps } from '../navigation/types';
import { bankById } from '../repositories/bankRepository';
import { cashLinkRepository } from '../repositories/cashLinkRepository';
import { loanDebtRepository } from '../repositories/loanDebtRepository';
import { peopleRepository } from '../repositories/peopleRepository';
import { reimbursementRepository } from '../repositories/reimbursementRepository';
import { splitRepository } from '../repositories/splitRepository';
import { sourceSmsRepository } from '../repositories/sourceSmsRepository';
import { transactionRepository } from '../repositories/transactionRepository';
import { autoCategorization } from '../services/autoCategorization';
import { loadLoanDebtItems, type LoanDebtItem } from '../services/loanDebtSummary';
import { notifyDataChanged, useData } from '../store/dataStore';
import { useSettings, useTheme } from '../store/settingsStore';
import { spacing } from '../theme/colors';
import { atmWithdrawalReferences, isOpenableLink, withdrawalReferenceOf } from '../utils/cashPocket';
import { addDays, parseDateInput, toDateInput } from '../utils/dates';
import { formatDateTime, formatMoney, formatNumber, maskAccountNumber, parseAmountInput, titleCase } from '../utils/format';
import { matchTransactionToPerson, type PeopleIndex } from '../utils/personMatching';
import { addCalendarMonths } from '../utils/planning';
import { transactionDebitOutflow, transactionFeeAmount } from '../utils/transactionAmounts';

const EPSILON = 0.005;

type SheetKind = 'loan' | 'repayment' | 'reimbursement';

interface Related {
  sms: TransactionSourceSms | null;
  loanEntry: LoanDebtEntry | null;
  loanRemaining: number | null;
  repayments: LoanDebtRepayment[];
  /** Allocations made by this credit (when it is a reimbursement). */
  reimbursementsGiven: ReimbursementAllocation[];
  /** Allocations received by this expense from reimbursement credits. */
  reimbursementsReceived: ReimbursementAllocation[];
}

const EMPTY_RELATED: Related = {
  sms: null,
  loanEntry: null,
  loanRemaining: null,
  repayments: [],
  reimbursementsGiven: [],
  reimbursementsReceived: [],
};

function loanDirectionFor(tx: Transaction): LoanDebtDirection {
  // Money sent under "Loan" means you lent it; money received under "Debt" means you borrowed it.
  return isCredit(tx) ? 'borrowed' : 'lent';
}

function amountDraft(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export function TransactionDetailScreen({ route, navigation }: StackScreenProps<'TransactionDetail'>) {
  const { reference } = route.params;
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const { transactions, categories, banksWithCash, selfTransferReferences, splitsByParent, version } = useData();

  const storeTx = useMemo(() => transactions.find((t) => t.reference === reference) ?? null, [transactions, reference]);
  const [fetchedTx, setFetchedTx] = useState<Transaction | null | undefined>(undefined);
  const tx = storeTx ?? fetchedTx ?? null;

  const [related, setRelated] = useState<Related>(EMPTY_RELATED);
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [savingNote, setSavingNote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const [pendingIds, setPendingIds] = useState<number[]>([]);
  const [showSms, setShowSms] = useState(false);
  const [splitSheet, setSplitSheet] = useState(false);
  const atmRefs = useMemo(() => atmWithdrawalReferences(transactions), [transactions]);

  useEffect(() => {
    if (storeTx) return;
    let cancelled = false;
    void transactionRepository.getTransactionByReference(reference).then((found) => {
      if (!cancelled) setFetchedTx(found);
    });
    return () => {
      cancelled = true;
    };
  }, [reference, storeTx]);

  const loadRelated = useCallback(async () => {
    try {
      const [sms, loanEntry, loanRemaining, repayments, reimbursementsGiven, reimbursementsReceived] = await Promise.all([
        sourceSmsRepository.getForTransaction(reference),
        loanDebtRepository.getEntryForTransaction(reference),
        loanDebtRepository.getRemainingAmount(reference),
        loanDebtRepository.getRepaymentsForTransaction(reference),
        reimbursementRepository.getForReimbursement(reference),
        reimbursementRepository.getForExpense(reference),
      ]);
      setRelated({ sms, loanEntry, loanRemaining, repayments, reimbursementsGiven, reimbursementsReceived });
    } catch (error) {
      if (__DEV__) console.warn('debug: Failed to load transaction links', error);
    }
  }, [reference]);

  useEffect(() => {
    void loadRelated();
  }, [loadRelated, version]);

  const categoriesById = useMemo(() => new Map(categories.map((c) => [c.id ?? -1, c])), [categories]);
  const transactionsByRef = useMemo(() => new Map(transactions.map((t) => [t.reference, t])), [transactions]);

  const [peopleIndex, setPeopleIndex] = useState<PeopleIndex | null>(null);
  const [personSheet, setPersonSheet] = useState(false);
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
  const personMatch = useMemo(() => (tx && peopleIndex ? matchTransactionToPerson(tx, peopleIndex) : null), [tx, peopleIndex]);
  const matchedPerson = personMatch ? peopleIndex?.byId.get(personMatch.personId) ?? null : null;

  if (!storeTx && fetchedTx === undefined) return <Loading />;
  if (!tx) {
    return (
      <View style={[ui.flex, { backgroundColor: colors.background }]}>
        <EmptyState icon="search-off" title="Transaction not found" message="It may have been deleted." />
      </View>
    );
  }

  const credit = isCredit(tx);
  const flow = credit ? 'income' : 'expense';
  const selected = selectedCategoryIds(tx);
  const flowCategories = categories.filter((c) => c.flow === flow && c.id != null);
  const bank = bankById(banksWithCash, tx.bankId);
  const date = txDate(tx);
  const fees = transactionFeeAmount(tx);
  const isSelf = selfTransferReferences.has(tx.reference);
  const note = noteDraft ?? tx.note ?? '';
  const noteDirty = noteDraft !== null && noteDraft.trim() !== (tx.note ?? '').trim();
  const selectedManaged = selected.map((id) => categoriesById.get(id)).filter((c): c is Category => isManagedCategory(c));
  const splits = splitsByParent.get(tx.reference) ?? [];
  const pocketWithdrawal = pocketWithdrawalFor(tx, transactions, atmRefs);
  const atmWithdrawalRef = withdrawalReferenceOf(tx);
  // Loan/repayment/reimbursement transactions already carry their own links; splitting them would double count.
  const canSplit = selectedManaged.length === 0 && !isSelf && !pocketWithdrawal;

  const saveCategories = async (ids: number[], promptRule: boolean) => {
    const primary = tx.categoryId != null && ids.includes(tx.categoryId) ? tx.categoryId : ids[0] ?? null;
    await transactionRepository.updateTransactionCategories([
      makeTransaction({ ...tx, categoryId: primary, categoryIds: ids.length > 0 ? ids : null }),
    ]);
    setFetchedTx((prev) => (prev ? makeTransaction({ ...prev, categoryId: primary, categoryIds: ids }) : prev));
    notifyDataChanged();
    if (promptRule) await maybePromptRule(ids, primary);
  };

  const maybePromptRule = async (ids: number[], primary: number | null) => {
    const counterparty = autoCategorization.resolvePrimaryCounterparty({
      type: tx.type,
      receiver: tx.receiver,
      creditor: tx.creditor,
    });
    if (!counterparty) return;
    const ruleIds = ids.filter((id) => !isManagedCategory(categoriesById.get(id)));
    if (ruleIds.length === 0) return;
    if (!(await autoCategorization.isEnabled()) || !(await autoCategorization.isPromptEnabled())) return;
    const ruleFlow = autoCategorization.flowForTransactionType(tx.type);
    if (await autoCategorization.isPromptDismissed(counterparty, ruleFlow)) return;
    const existing = await autoCategorization.getRulesForCounterparty(counterparty, ruleFlow);
    if (existing.length === ruleIds.length && existing.every((r) => ruleIds.includes(r.categoryId))) return;

    const names = ruleIds
      .map((id) => categoriesById.get(id)?.name)
      .filter(Boolean)
      .join(', ');
    const who = titleCase(counterparty);
    Alert.alert(
      'Auto-categorize?',
      `Always categorize ${ruleFlow === 'income' ? 'money from' : 'payments to'} ${who} as ${names}?`,
      [
        {
          text: "Don't ask again",
          onPress: () => {
            void autoCategorization.dismissPrompt(counterparty, ruleFlow);
          },
        },
        { text: 'Not now', style: 'cancel' },
        {
          text: 'Always',
          onPress: () => {
            void (async () => {
              await autoCategorization.replaceRules({
                counterparty,
                flow: ruleFlow,
                categoryIds: ruleIds,
                primaryCategoryId: primary != null && ruleIds.includes(primary) ? primary : ruleIds[0],
              });
              await offerApplyToPast(counterparty, ruleIds);
            })().catch((error) => showError('Could not save rule', error));
          },
        },
      ],
    );
  };

  /** After creating a rule, offer to categorize earlier uncategorized transactions from the same counterparty. */
  const offerApplyToPast = async (counterparty: string, ruleIds: number[]) => {
    const normalized = autoCategorization.normalizeCounterparty(counterparty);
    const matches = useData.getState().transactions.filter((t) => {
      if (t.reference === tx.reference || selectedCategoryIds(t).length > 0) return false;
      if (autoCategorization.flowForTransactionType(t.type) !== autoCategorization.flowForTransactionType(tx.type)) return false;
      const cp = autoCategorization.resolvePrimaryCounterparty({ type: t.type, receiver: t.receiver, creditor: t.creditor });
      return !!cp && autoCategorization.normalizeCounterparty(cp) === normalized;
    });
    if (matches.length === 0) return;
    const ok = await confirm(
      'Apply to past transactions?',
      `${matches.length} uncategorized transaction${matches.length === 1 ? '' : 's'} from ${titleCase(counterparty)} can use this rule too.`,
      'Apply',
    );
    if (!ok) return;
    await transactionRepository.updateTransactionCategories(
      matches.map((t) => makeTransaction({ ...t, categoryId: ruleIds[0], categoryIds: ruleIds })),
    );
    notifyDataChanged();
  };

  const run = async (label: string, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      showError(label, error);
    } finally {
      setBusy(false);
    }
  };

  const onToggleCategory = (category: Category) => {
    const id = category.id;
    if (id == null) return;
    const isOn = selected.includes(id);
    const next = isOn ? selected.filter((x) => x !== id) : [...selected, id];

    if (!isOn) {
      if (isManagedCategory(category)) {
        const other = selectedManaged.find((c) => c.id !== id);
        if (other) {
          Alert.alert('Remove the other link first', `This transaction is already marked as ${other.name}.`);
          return;
        }
        setPendingIds(next);
        if (isLoanDebtCategory(category)) setSheet('loan');
        else if (isRepaymentCategory(category)) setSheet('repayment');
        else if (isReimbursementCategory(category)) setSheet('reimbursement');
        return;
      }
      void run('Could not update categories', () => saveCategories(next, true));
      return;
    }

    if (isLoanDebtCategory(category) && related.loanEntry) {
      void (async () => {
        const ok = await confirm(
          `Remove ${category.name}?`,
          `The link to ${related.loanEntry?.personName} and any repayments recorded against it will stop counting.`,
          'Remove',
          true,
        );
        if (!ok) return;
        await run('Could not remove link', async () => {
          await loanDebtRepository.deleteEntryForTransaction(tx.reference);
          await saveCategories(next, false);
          await loadRelated();
        });
      })();
      return;
    }
    if (isRepaymentCategory(category) && related.repayments.length > 0) {
      void run('Could not remove repayment', async () => {
        await loanDebtRepository.deleteRepaymentForTransaction(tx.reference);
        await saveCategories(next, false);
        await loadRelated();
      });
      return;
    }
    if (isReimbursementCategory(category) && related.reimbursementsGiven.length > 0) {
      void run('Could not remove reimbursement', async () => {
        await reimbursementRepository.deleteForReimbursement(tx.reference);
        await saveCategories(next, false);
        await loadRelated();
      });
      return;
    }
    void run('Could not update categories', () => saveCategories(next, false));
  };

  const onSheetSaved = () => {
    const ids = pendingIds;
    setSheet(null);
    void run('Could not update categories', async () => {
      await saveCategories(ids, false);
      await loadRelated();
    });
  };

  const saveNote = async () => {
    setSavingNote(true);
    try {
      await transactionRepository.updateNote(tx.reference, noteDraft);
      setFetchedTx((prev) => (prev ? { ...prev, note: noteDraft?.trim() || null } : prev));
      setNoteDraft(null);
      notifyDataChanged();
    } catch (error) {
      showError('Could not save note', error);
    } finally {
      setSavingNote(false);
    }
  };

  const onDelete = async () => {
    const ok = await confirm(
      'Delete transaction?',
      'This removes it from Totals. A bank SMS sync may add it again if the message is still on the phone.',
      'Delete',
      true,
    );
    if (!ok) return;
    await run('Could not delete', async () => {
      await loanDebtRepository.deleteRepaymentForTransaction(tx.reference);
      await loanDebtRepository.deleteEntryForTransaction(tx.reference);
      await splitRepository.deleteForTransaction(tx.reference);
      await cashLinkRepository.unlink(tx.reference);
      await transactionRepository.deleteTransactionsByReferences([tx.reference]);
      notifyDataChanged();
      navigation.goBack();
    });
  };

  const copyReference = () => {
    void Clipboard.setStringAsync(txDisplayReference(tx)).then(() => Alert.alert('Copied', 'Reference copied to clipboard.'));
  };

  const editManagedLink = (category: Category) => {
    setPendingIds(selected);
    if (isLoanDebtCategory(category)) setSheet('loan');
    else if (isRepaymentCategory(category)) setSheet('repayment');
    else if (isReimbursementCategory(category)) setSheet('reimbursement');
  };

  const counterpartyLabel = credit ? 'From' : 'To';
  const counterparty = (credit ? tx.creditor || tx.receiver : tx.receiver || tx.creditor)?.trim();

  return (
    <View style={[ui.flex, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={ui.screenContent} keyboardShouldPersistTaps="handled">
        <Card style={styles.hero}>
          <View style={ui.rowCenter}>
            <BankAvatar bank={bank} size={44} />
            <View style={ui.flex}>
              <Text style={[styles.heroTitle, { color: colors.text }]} numberOfLines={2}>
                {counterpartyOf(tx)}
              </Text>
              <Text style={{ color: colors.textSecondary }}>{bank?.name ?? 'Unknown bank'}</Text>
            </View>
          </View>
          <AmountText
            value={Math.abs(tx.amount)}
            sign={credit ? '+' : '-'}
            color={credit ? colors.income : colors.expense}
            style={styles.heroAmount}
          />
          <View style={ui.rowWrap}>
            <Chip label={credit ? 'Income' : isDebit(tx) ? 'Expense' : tx.type ?? 'Unknown'} selected color={credit ? colors.income : colors.expense} />
            {isSelf ? <Chip label="Self transfer" selected color={colors.info} /> : null}
            {tx.status ? <Chip label={titleCase(tx.status)} /> : null}
          </View>
        </Card>

        <SectionTitle title="Details" />
        <Card style={{ paddingVertical: spacing.sm }}>
          {counterparty ? <DetailRow label={counterpartyLabel} value={titleCase(counterparty)} /> : null}
          <DetailRow
            label="Person"
            value={
              matchedPerson
                ? `${matchedPerson.name}${personMatch?.source === 'manual' ? '' : ' (auto)'}`
                : peopleIndex?.links.has(tx.reference)
                  ? 'Nobody'
                  : 'Assign'
            }
            icon={matchedPerson ? 'person' : 'person-add-alt'}
            onPress={() => setPersonSheet(true)}
          />
          {date ? <DetailRow label="Date" value={formatDateTime(date, calendar)} /> : null}
          <DetailRow label="Reference" value={txDisplayReference(tx)} onPress={copyReference} icon="content-copy" />
          {tx.accountNumber || tx.ownerAccountNumber ? (
            <DetailRow label="Account" value={maskAccountNumber(tx.ownerAccountNumber || tx.accountNumber || '')} />
          ) : null}
          {tx.serviceCharge ? <DetailRow label="Service charge" value={formatMoney(tx.serviceCharge)} /> : null}
          {tx.vat ? <DetailRow label="VAT" value={formatMoney(tx.vat)} /> : null}
          {fees > 0 && !credit ? <DetailRow label="Total outflow" value={formatMoney(transactionDebitOutflow(tx))} /> : null}
          {tx.currentBalance ? <DetailRow label="Balance after" value={`ETB ${tx.currentBalance}`} /> : null}
          {atmWithdrawalRef ? (
            <DetailRow
              label="Withdrawal"
              value="Open"
              icon="local-atm"
              onPress={() => navigation.push('TransactionDetail', { reference: atmWithdrawalRef })}
            />
          ) : isOpenableLink(tx.transactionLink) ? (
            <DetailRow
              label="Receipt"
              value="Open"
              icon="open-in-new"
              onPress={() => {
                void Linking.openURL(tx.transactionLink!).catch((error) => showError('Could not open link', error));
              }}
            />
          ) : null}
        </Card>

        <SectionTitle title="Categories" />
        <Card>
          <View style={ui.rowWrap}>
            {flowCategories.map((c) => (
              <Chip
                key={c.id!}
                label={c.name}
                selected={selected.includes(c.id!)}
                onPress={() => onToggleCategory(c)}
                icon={selected[0] === c.id ? 'star' : undefined}
              />
            ))}
          </View>
          {selected.length > 1 ? (
            <Text style={[styles.hint, { color: colors.textMuted }]}>The starred category is the primary one used in reports.</Text>
          ) : null}
        </Card>

        {canSplit ? (
          <SplitSection
            tx={tx}
            splits={splits}
            people={peopleIndex?.byId ?? new Map()}
            onEdit={() => setSplitSheet(true)}
            onOpenPerson={(personId) => navigation.push('PersonDetail', { personId })}
          />
        ) : null}

        {pocketWithdrawal ? (
          <PocketSection
            withdrawal={pocketWithdrawal}
            onOpenTransaction={(ref) => navigation.push('TransactionDetail', { reference: ref })}
            onAddCashSpend={() => navigation.navigate('AddCash', { type: 'DEBIT', withdrawalReference: pocketWithdrawal.reference })}
          />
        ) : isCashSpend(tx) ? (
          <CashSourceSection tx={tx} onOpenTransaction={(ref) => navigation.push('TransactionDetail', { reference: ref })} />
        ) : null}

        {selectedManaged.map((category) => (
          <ManagedLinkCard
            key={category.id!}
            category={category}
            related={related}
            transactionsByRef={transactionsByRef}
            onEdit={() => editManagedLink(category)}
            onOpenLoans={() => navigation.navigate('Loans', { reference: tx.reference })}
            onOpenTransaction={(ref) => navigation.push('TransactionDetail', { reference: ref })}
          />
        ))}

        {!credit && related.reimbursementsReceived.length > 0 ? (
          <>
            <SectionTitle title="Reimbursed by" />
            <Card style={{ paddingVertical: spacing.xs }}>
              {related.reimbursementsReceived.map((a) => {
                const source = transactionsByRef.get(a.reimbursementTransactionReference);
                return (
                  <ListRow
                    key={a.id ?? a.reimbursementTransactionReference}
                    title={source ? counterpartyOf(source) : a.reimbursementTransactionReference}
                    subtitle={source && txDate(source) ? formatDateTime(txDate(source)!, calendar) : null}
                    value={formatMoney(a.appliedAmount)}
                    chevron
                    onPress={() => navigation.push('TransactionDetail', { reference: a.reimbursementTransactionReference })}
                    onLongPress={() => {
                      if (a.id == null) return;
                      void (async () => {
                        const ok = await confirm('Unlink reimbursement?', 'The expense will count in full again.', 'Unlink', true);
                        if (!ok) return;
                        await run('Could not unlink', async () => {
                          await transactionRepository.unlinkReimbursementAllocation(a.id!);
                          notifyDataChanged();
                          await loadRelated();
                        });
                      })();
                    }}
                  />
                );
              })}
            </Card>
          </>
        ) : null}

        <SectionTitle title="Note" />
        <Card style={{ gap: spacing.sm }}>
          <TextField value={note} onChangeText={setNoteDraft} placeholder="Add a note" multiline />
          {noteDirty ? (
            <View style={[ui.rowCenter, { justifyContent: 'flex-end' }]}>
              <Button title="Cancel" variant="ghost" compact onPress={() => setNoteDraft(null)} />
              <Button title="Save note" compact loading={savingNote} onPress={() => void saveNote()} />
            </View>
          ) : null}
        </Card>

        {related.sms ? (
          <>
            <SectionTitle
              title="Source SMS"
              action={{ label: showSms ? 'Hide' : 'Show', onPress: () => setShowSms((v) => !v) }}
            />
            {showSms ? (
              <Card style={{ gap: spacing.xs }}>
                <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                  {related.sms.senderAddress ?? 'Unknown sender'}
                  {related.sms.receivedAt ? ` · ${formatDateTime(new Date(related.sms.receivedAt), calendar)}` : ''}
                </Text>
                <Text selectable style={{ color: colors.text, lineHeight: 20 }}>
                  {related.sms.body}
                </Text>
              </Card>
            ) : null}
          </>
        ) : null}

        <Button title="Delete transaction" icon="delete-outline" variant="danger" onPress={() => void onDelete()} loading={busy} />
      </ScrollView>

      <LoanPersonSheet
        visible={sheet === 'loan'}
        tx={tx}
        entry={related.loanEntry}
        onClose={() => setSheet(null)}
        onSaved={onSheetSaved}
      />
      <RepaymentSheet
        visible={sheet === 'repayment'}
        tx={tx}
        existing={related.repayments}
        onClose={() => setSheet(null)}
        onSaved={onSheetSaved}
      />
      <ReimbursementSheet
        visible={sheet === 'reimbursement'}
        tx={tx}
        existing={related.reimbursementsGiven}
        onClose={() => setSheet(null)}
        onSaved={onSheetSaved}
      />
      <SplitEditorSheet visible={splitSheet} tx={tx} splits={splits} onClose={() => setSplitSheet(false)} />
      <PersonPickerSheet
        visible={personSheet}
        tx={tx}
        index={peopleIndex}
        currentPersonId={matchedPerson?.id ?? null}
        onClose={() => setPersonSheet(false)}
        onOpenPerson={(personId) => {
          setPersonSheet(false);
          navigation.push('PersonDetail', { personId });
        }}
      />
    </View>
  );
}

function DetailRow(props: { label: string; value: string; onPress?: () => void; icon?: string }) {
  const colors = useTheme();
  return (
    <Pressable onPress={props.onPress} disabled={!props.onPress} style={styles.detailRow}>
      <Text style={{ color: colors.textSecondary, flexShrink: 0 }}>{props.label}</Text>
      <View style={[ui.rowCenter, { flexShrink: 1, gap: spacing.xs }]}>
        <Text style={{ color: colors.text, fontWeight: '500', textAlign: 'right', flexShrink: 1 }} selectable>
          {props.value}
        </Text>
        {props.icon ? <Icon name={props.icon} size={16} color={colors.primary} /> : null}
      </View>
    </Pressable>
  );
}

function ManagedLinkCard(props: {
  category: Category;
  related: Related;
  transactionsByRef: Map<string, Transaction>;
  onEdit: () => void;
  onOpenLoans: () => void;
  onOpenTransaction: (reference: string) => void;
}) {
  const colors = useTheme();
  const { category, related } = props;

  if (isLoanDebtCategory(category)) {
    const entry = related.loanEntry;
    return (
      <Card style={{ gap: spacing.sm }}>
        <View style={ui.rowCenter}>
          <CategoryIcon category={category} size={32} />
          <Text style={[styles.linkTitle, { color: colors.text }]}>{category.name}</Text>
          <View style={ui.flex} />
          <Button title="Edit" variant="ghost" compact onPress={props.onEdit} />
        </View>
        {entry ? (
          <>
            <Text style={{ color: colors.text }}>
              {entry.direction === 'lent' ? `Lent to ${entry.personName}` : `Borrowed from ${entry.personName}`}
              {entry.status !== 'active' ? ` · ${titleCase(entry.status)}` : ''}
            </Text>
            {related.loanRemaining != null ? (
              <Text style={{ color: colors.textSecondary }}>Remaining: {formatMoney(related.loanRemaining)}</Text>
            ) : null}
            {entry.returnDate ? (
              <Text style={{ color: colors.textSecondary }}>Expected back: {toDateInput(new Date(entry.returnDate))}</Text>
            ) : null}
            <Button title="Open in Loans & debts" variant="secondary" compact icon="handshake" onPress={props.onOpenLoans} />
          </>
        ) : (
          <Text style={{ color: colors.warning }}>No person linked yet. Tap Edit to add one.</Text>
        )}
      </Card>
    );
  }

  if (isRepaymentCategory(category)) {
    return (
      <Card style={{ gap: spacing.sm }}>
        <View style={ui.rowCenter}>
          <CategoryIcon category={category} size={32} />
          <Text style={[styles.linkTitle, { color: colors.text }]}>{category.name}</Text>
          <View style={ui.flex} />
          <Button title="Edit" variant="ghost" compact onPress={props.onEdit} />
        </View>
        {related.repayments.length === 0 && !related.loanEntry ? (
          <Text style={{ color: colors.warning }}>Not applied to any loan or debt yet.</Text>
        ) : null}
        {related.repayments.map((r) => {
          const target = props.transactionsByRef.get(r.loanDebtTransactionReference);
          return (
            <ListRow
              key={r.id ?? r.loanDebtTransactionReference}
              title={target ? counterpartyOf(target) : r.loanDebtTransactionReference}
              subtitle={target && txDate(target) ? toDateInput(txDate(target)) : null}
              value={formatMoney(r.appliedAmount)}
              chevron
              onPress={() => props.onOpenTransaction(r.loanDebtTransactionReference)}
            />
          );
        })}
        {related.loanEntry && related.loanEntry.source === 'repayment_surplus' ? (
          <Text style={{ color: colors.textSecondary }}>
            Surplus of {formatMoney(related.loanEntry.principalAmount ?? 0)} recorded as{' '}
            {related.loanEntry.direction === 'lent' ? 'lent to' : 'borrowed from'} {related.loanEntry.personName}.
          </Text>
        ) : null}
      </Card>
    );
  }

  // Reimbursement
  return (
    <Card style={{ gap: spacing.sm }}>
      <View style={ui.rowCenter}>
        <CategoryIcon category={category} size={32} />
        <Text style={[styles.linkTitle, { color: colors.text }]}>{category.name}</Text>
        <View style={ui.flex} />
        <Button title="Edit" variant="ghost" compact onPress={props.onEdit} />
      </View>
      {related.reimbursementsGiven.length === 0 ? (
        <Text style={{ color: colors.warning }}>Not applied to any expense yet.</Text>
      ) : null}
      {related.reimbursementsGiven.map((a) => {
        const expense = props.transactionsByRef.get(a.expenseTransactionReference);
        return (
          <ListRow
            key={a.id ?? a.expenseTransactionReference}
            title={expense ? counterpartyOf(expense) : a.expenseTransactionReference}
            subtitle={expense && txDate(expense) ? toDateInput(txDate(expense)) : null}
            value={formatMoney(a.appliedAmount)}
            chevron
            onPress={() => props.onOpenTransaction(a.expenseTransactionReference)}
          />
        );
      })}
    </Card>
  );
}

function LoanPersonSheet(props: {
  visible: boolean;
  tx: Transaction;
  entry: LoanDebtEntry | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const colors = useTheme();
  const direction = loanDirectionFor(props.tx);
  const calendar = useSettings((s) => s.calendar);
  const [name, setName] = useState('');
  const [returnDate, setReturnDate] = useState('');
  const [principal, setPrincipal] = useState('');
  const [people, setPeople] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!props.visible) return;
    setName(props.entry?.personName ?? '');
    setReturnDate(props.entry?.returnDate ? toDateInput(new Date(props.entry.returnDate)) : '');
    setPrincipal(props.entry?.principalAmount != null ? amountDraft(props.entry.principalAmount) : '');
    void Promise.all([loanDebtRepository.getKnownPeople(), peopleRepository.getPeople()])
      .then(([loanNames, saved]) => {
        const seen = new Set<string>();
        const merged: string[] = [];
        for (const n of [...saved.map((p) => p.name), ...loanNames]) {
          const key = n.trim().toLowerCase();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          merged.push(n.trim());
        }
        setPeople(merged);
      })
      .catch((error) => {
        if (__DEV__) console.warn('debug: Failed to load people names', error);
      });
  }, [props.visible, props.entry]);

  const dateError = returnDate.trim() && !parseDateInput(returnDate) ? 'Use YYYY-MM-DD' : null;
  const principalValue = principal.trim() ? parseAmountInput(principal) : null;
  const principalError = principal.trim() && (principalValue === null || principalValue <= 0) ? 'Enter a positive amount' : null;
  const filteredPeople = people
    .filter((p) => !name.trim() || p.toLowerCase().includes(name.trim().toLowerCase()))
    .filter((p) => p.toLowerCase() !== name.trim().toLowerCase())
    .slice(0, 8);

  const save = async () => {
    if (!name.trim()) {
      Alert.alert('Person required', direction === 'lent' ? 'Who did you lend to?' : 'Who did you borrow from?');
      return;
    }
    if (dateError || principalError) return;
    setSaving(true);
    try {
      await loanDebtRepository.upsertTransactionPerson({
        transactionReference: props.tx.reference,
        personName: name,
        direction,
        principalAmount: principalValue,
        returnDate: parseDateInput(returnDate),
        replaceReturnDate: true,
      });
      props.onSaved();
    } catch (error) {
      showError('Could not save', error);
    } finally {
      setSaving(false);
    }
  };

  const today = new Date();
  return (
    <Sheet visible={props.visible} onClose={props.onClose} title={direction === 'lent' ? 'Money lent' : 'Money borrowed'}>
      <View style={{ gap: spacing.md }}>
        <Text style={{ color: colors.textSecondary }}>
          {direction === 'lent'
            ? `You sent ${formatMoney(Math.abs(props.tx.amount))}. Who owes it back?`
            : `You received ${formatMoney(Math.abs(props.tx.amount))}. Who do you owe?`}
        </Text>
        <TextField label="Person" value={name} onChangeText={setName} placeholder="Name" autoCapitalize="words" />
        {filteredPeople.length > 0 ? (
          <View style={ui.rowWrap}>
            {filteredPeople.map((p) => (
              <Chip key={p} label={p} icon="person" onPress={() => setName(p)} />
            ))}
          </View>
        ) : null}
        <TextField
          label="Amount (optional)"
          value={principal}
          onChangeText={setPrincipal}
          placeholder={formatNumber(Math.abs(props.tx.amount))}
          keyboardType="decimal-pad"
          error={principalError}
        />
        <DateField
          label="Expected return date (optional)"
          value={parseDateInput(returnDate)}
          onChange={(d) => setReturnDate(d ? toDateInput(d) : '')}
          placeholder="No date"
          clearable
        />
        <View style={ui.rowWrap}>
          <Chip label="1 week" onPress={() => setReturnDate(toDateInput(addDays(today, 7)))} />
          <Chip label="2 weeks" onPress={() => setReturnDate(toDateInput(addDays(today, 14)))} />
          <Chip label="1 month" onPress={() => setReturnDate(toDateInput(addCalendarMonths(today, 1, calendar)))} />
        </View>
        <Button title="Save" onPress={() => void save()} loading={saving} />
      </View>
    </Sheet>
  );
}

function RepaymentSheet(props: {
  visible: boolean;
  tx: Transaction;
  existing: LoanDebtRepayment[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const transactions = useData((s) => s.transactions);
  const [items, setItems] = useState<LoanDebtItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [surplusName, setSurplusName] = useState('');
  const [saving, setSaving] = useState(false);
  const credit = isCredit(props.tx);
  const direction: LoanDebtDirection = credit ? 'lent' : 'borrowed';
  const total = Math.abs(props.tx.amount);

  const existingByTarget = useMemo(
    () => new Map(props.existing.map((r) => [r.loanDebtTransactionReference, r.appliedAmount])),
    [props.existing],
  );

  useEffect(() => {
    if (!props.visible) return;
    const initial: Record<string, string> = {};
    for (const r of props.existing) initial[r.loanDebtTransactionReference] = amountDraft(r.appliedAmount);
    setDrafts(initial);
    setSurplusName('');
    void loadLoanDebtItems(transactions).then((loaded) => {
      setItems(loaded);
      const surplus = loaded.find((i) => i.entry.transactionReference === props.tx.reference && i.entry.source === 'repayment_surplus');
      if (surplus) setSurplusName(surplus.entry.personName);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.visible]);

  const candidates = items.filter((i) => {
    const ref = i.entry.transactionReference;
    if (ref === props.tx.reference || i.entry.direction !== direction || !i.entry.personName.trim()) return false;
    return i.effectiveStatus === 'active' || existingByTarget.has(ref);
  });

  const availableFor = (item: LoanDebtItem) =>
    (item.remaining ?? item.original ?? 0) + (existingByTarget.get(item.entry.transactionReference) ?? 0);

  const allocated = Object.values(drafts).reduce((sum, v) => sum + (parseAmountInput(v) ?? 0), 0);
  const surplus = total - allocated;

  const toggle = (item: LoanDebtItem) => {
    const ref = item.entry.transactionReference;
    const next = { ...drafts };
    if (ref in next) {
      delete next[ref];
    } else {
      next[ref] = amountDraft(Math.max(0, Math.min(availableFor(item), total - allocated)));
      if (!surplusName) setSurplusName(item.entry.personName);
    }
    setDrafts(next);
  };

  const save = async () => {
    const allocations = Object.entries(drafts)
      .map(([ref, value]) => ({ loanDebtTransactionReference: ref, appliedAmount: parseAmountInput(value) ?? 0 }))
      .filter((a) => a.appliedAmount > 0);
    if (allocated - total > EPSILON) {
      Alert.alert('Too much allocated', `You can apply at most ${formatMoney(total)}.`);
      return;
    }
    for (const a of allocations) {
      const item = items.find((i) => i.entry.transactionReference === a.loanDebtTransactionReference);
      if (item && a.appliedAmount - availableFor(item) > EPSILON) {
        Alert.alert('Too much for one entry', `${item.entry.personName} only has ${formatMoney(availableFor(item))} remaining.`);
        return;
      }
    }
    const hasSurplus = surplus > EPSILON && !!surplusName.trim();
    if (allocations.length === 0 && !hasSurplus) {
      Alert.alert('Nothing to save', 'Pick a loan or debt this repayment goes toward.');
      return;
    }
    setSaving(true);
    try {
      await loanDebtRepository.saveRepaymentFlow({
        repaymentTransactionReference: props.tx.reference,
        allocations,
        surplusPersonName: hasSurplus ? surplusName : null,
        surplusDirection: hasSurplus ? (direction === 'lent' ? 'borrowed' : 'lent') : null,
        surplusPrincipalAmount: hasSurplus ? surplus : null,
      });
      props.onSaved();
    } catch (error) {
      showError('Could not save repayment', error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet visible={props.visible} onClose={props.onClose} title={credit ? 'Repayment received' : 'Repayment sent'}>
      <View style={{ gap: spacing.md }}>
        <Text style={{ color: colors.textSecondary }}>
          {credit
            ? 'Which loans that you gave does this repayment cover?'
            : 'Which debts that you owe does this repayment cover?'}
        </Text>
        {candidates.length === 0 ? (
          <Text style={{ color: colors.textMuted }}>
            No active {credit ? 'loans' : 'debts'} found. Mark the original transaction as {credit ? 'Loan' : 'Debt'} first.
          </Text>
        ) : null}
        {candidates.map((item) => {
          const ref = item.entry.transactionReference;
          const isSelected = ref in drafts;
          const d = item.sourceTransaction ? txDate(item.sourceTransaction) : null;
          return (
            <Card key={ref} style={{ gap: spacing.sm, padding: spacing.md }}>
              <Pressable onPress={() => toggle(item)} style={ui.rowCenter}>
                <Icon name={isSelected ? 'check-box' : 'check-box-outline-blank'} color={isSelected ? colors.primary : colors.textMuted} />
                <View style={ui.flex}>
                  <Text style={{ color: colors.text, fontWeight: '600' }}>{item.entry.personName}</Text>
                  <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                    {d ? `${formatDateTime(d, calendar)} · ` : ''}Remaining {formatMoney(availableFor(item))}
                  </Text>
                </View>
              </Pressable>
              {isSelected ? (
                <TextField
                  value={drafts[ref]}
                  onChangeText={(v) => setDrafts((prev) => ({ ...prev, [ref]: v }))}
                  keyboardType="decimal-pad"
                  placeholder="Amount"
                />
              ) : null}
            </Card>
          );
        })}
        <Divider />
        <Text style={{ color: colors.text }}>
          Applied {formatMoney(allocated)} of {formatMoney(total)}
        </Text>
        {surplus > EPSILON ? (
          <>
            <Text style={{ color: colors.textSecondary }}>
              {formatMoney(surplus)} is left over. Name a person to record it as{' '}
              {direction === 'lent' ? 'money you now owe them' : 'money they now owe you'}, or leave it blank.
            </Text>
            <TextField label="Leftover person (optional)" value={surplusName} onChangeText={setSurplusName} autoCapitalize="words" />
          </>
        ) : null}
        {surplus < -EPSILON ? <Text style={{ color: colors.expense }}>Allocated amount exceeds the transaction.</Text> : null}
        <Button title="Save repayment" onPress={() => void save()} loading={saving} />
      </View>
    </Sheet>
  );
}

function ReimbursementSheet(props: {
  visible: boolean;
  tx: Transaction;
  existing: ReimbursementAllocation[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const { transactions, reimbursedByExpense, selfTransferReferences } = useData();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const total = Math.abs(props.tx.amount);

  const existingByExpense = useMemo(
    () => new Map(props.existing.map((a) => [a.expenseTransactionReference, a.appliedAmount])),
    [props.existing],
  );

  useEffect(() => {
    if (!props.visible) return;
    const initial: Record<string, string> = {};
    for (const a of props.existing) initial[a.expenseTransactionReference] = amountDraft(a.appliedAmount);
    setDrafts(initial);
    setQuery('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.visible]);

  const availableFor = (expense: Transaction) =>
    Math.max(
      0,
      transactionDebitOutflow(expense) -
        ((reimbursedByExpense.get(expense.reference) ?? 0) - (existingByExpense.get(expense.reference) ?? 0)),
    );

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    const debits = transactions.filter(
      (t) => isDebit(t) && t.reference !== props.tx.reference && !selfTransferReferences.has(t.reference),
    );
    const chosen = debits.filter((t) => t.reference in drafts);
    const others = debits
      .filter((t) => !(t.reference in drafts))
      .filter((t) => {
        if (!q) return true;
        return [counterpartyOf(t), t.note, String(t.amount)].filter(Boolean).join(' ').toLowerCase().includes(q);
      })
      .slice(0, 50);
    return [...chosen, ...others];
    // Re-sorting while typing amounts would make rows jump, so only drafts' keys matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, props.tx.reference, selfTransferReferences, query, Object.keys(drafts).join('|')]);

  const allocated = Object.values(drafts).reduce((sum, v) => sum + (parseAmountInput(v) ?? 0), 0);

  const toggle = (expense: Transaction) => {
    setDrafts((prev) => {
      const next = { ...prev };
      if (expense.reference in next) {
        delete next[expense.reference];
      } else {
        const used = Object.values(prev).reduce((sum, v) => sum + (parseAmountInput(v) ?? 0), 0);
        next[expense.reference] = amountDraft(Math.max(0, Math.min(availableFor(expense), total - used)));
      }
      return next;
    });
  };

  const save = async () => {
    const allocations = Object.entries(drafts)
      .map(([ref, value]) => ({ expenseTransactionReference: ref, appliedAmount: parseAmountInput(value) ?? 0 }))
      .filter((a) => a.appliedAmount > 0);
    if (allocations.length === 0) {
      Alert.alert('Pick an expense', 'Choose at least one expense this money paid back.');
      return;
    }
    setSaving(true);
    try {
      await reimbursementRepository.replaceForReimbursement({
        reimbursementTransactionReference: props.tx.reference,
        allocations,
      });
      props.onSaved();
    } catch (error) {
      showError('Could not save reimbursement', error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet visible={props.visible} onClose={props.onClose} title="Reimbursement">
      <View style={{ gap: spacing.md }}>
        <Text style={{ color: colors.textSecondary }}>
          Which expenses did this {formatMoney(total)} pay back? Reimbursed amounts are subtracted from your spending and not
          counted as income.
        </Text>
        <TextField value={query} onChangeText={setQuery} placeholder="Search expenses" />
        {candidates.map((expense) => {
          const isSelected = expense.reference in drafts;
          const d = txDate(expense);
          return (
            <Card key={expense.reference} style={{ gap: spacing.sm, padding: spacing.md }}>
              <Pressable onPress={() => toggle(expense)} style={ui.rowCenter}>
                <Icon name={isSelected ? 'check-box' : 'check-box-outline-blank'} color={isSelected ? colors.primary : colors.textMuted} />
                <View style={ui.flex}>
                  <Text style={{ color: colors.text, fontWeight: '600' }} numberOfLines={1}>
                    {counterpartyOf(expense)}
                  </Text>
                  <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                    {d ? `${formatDateTime(d, calendar)} · ` : ''}
                    {formatMoney(transactionDebitOutflow(expense))} · {formatMoney(availableFor(expense))} open
                  </Text>
                </View>
              </Pressable>
              {isSelected ? (
                <TextField
                  value={drafts[expense.reference]}
                  onChangeText={(v) => setDrafts((prev) => ({ ...prev, [expense.reference]: v }))}
                  keyboardType="decimal-pad"
                  placeholder="Amount"
                />
              ) : null}
            </Card>
          );
        })}
        <Divider />
        <Text style={{ color: allocated - total > EPSILON ? colors.expense : colors.text }}>
          Applied {formatMoney(allocated)} of {formatMoney(total)}
        </Text>
        <Button title="Save reimbursement" onPress={() => void save()} loading={saving} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  hero: { gap: spacing.md },
  heroTitle: { fontSize: 18, fontWeight: '700' },
  heroAmount: { fontSize: 30, fontWeight: '800' },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.lg,
    paddingVertical: spacing.sm,
  },
  hint: { fontSize: 12, marginTop: spacing.sm },
  linkTitle: { fontSize: 15, fontWeight: '700' },
});
