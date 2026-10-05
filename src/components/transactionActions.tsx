import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { isManagedCategory } from '../models/category';
import { isCredit, makeTransaction, selectedCategoryIds, type Transaction } from '../models/transaction';
import { transactionRepository } from '../repositories/transactionRepository';
import { notifyDataChanged, useData } from '../store/dataStore';
import { useTheme } from '../store/settingsStore';
import { spacing } from '../theme/colors';
import { atmWithdrawalReferences } from '../utils/cashPocket';
import { showError } from './dialogs';
import { TransactionRow } from './finance';
import { SplitEditorSheet, pocketWithdrawalFor } from './splits';
import { Chip, Icon, Sheet, styles as ui } from './ui';

// ATM detection scans every transaction; share the result between rows of the same list.
let atmCache: { transactions: readonly Transaction[]; refs: Set<string> } | null = null;

function atmRefsFor(transactions: readonly Transaction[]): Set<string> {
  if (atmCache?.transactions !== transactions) atmCache = { transactions, refs: atmWithdrawalReferences(transactions) };
  return atmCache.refs;
}

/** Why a transaction can't be split from the list, or null when it can. */
function splitBlocker(tx: Transaction): string | null {
  const { categories, selfTransferReferences, transactions } = useData.getState();
  if (selfTransferReferences.has(tx.reference)) return 'Self transfers can’t be split.';
  if (pocketWithdrawalFor(tx, transactions, atmRefsFor(transactions))) return 'ATM withdrawals are tracked as a cash pocket.';
  const ids = selectedCategoryIds(tx);
  if (categories.some((c) => c.id != null && ids.includes(c.id) && isManagedCategory(c))) {
    return 'Loans, repayments and reimbursements already link to a person.';
  }
  return null;
}

/**
 * A transaction row that expands on tap into quick actions: categorize, split, or open the details.
 */
export function ExpandableTransactionRow(props: { tx: Transaction; showDate?: boolean; onOpen: () => void }) {
  const colors = useTheme();
  const splitsByParent = useData((s) => s.splitsByParent);
  useData((s) => s.version); // re-check what can be split when categories or links change
  const [expanded, setExpanded] = useState(false);
  const [sheet, setSheet] = useState<'category' | 'split' | null>(null);
  const { tx } = props;
  const blocker = expanded ? splitBlocker(tx) : null;
  const splits = splitsByParent.get(tx.reference) ?? [];

  return (
    <View style={expanded ? [styles.expanded, { backgroundColor: colors.surfaceMuted }] : null}>
      <TransactionRow tx={tx} showDate={props.showDate} onPress={() => setExpanded((v) => !v)} />
      {expanded ? (
        <View style={styles.actions}>
          <ActionButton icon="label-outline" label="Categorize" onPress={() => setSheet('category')} />
          <ActionButton
            icon="call-split"
            label={splits.length > 0 ? 'Edit split' : 'Split'}
            disabled={!!blocker}
            onPress={() => setSheet('split')}
          />
          <ActionButton icon="open-in-new" label="Details" onPress={props.onOpen} />
        </View>
      ) : null}
      {expanded && blocker ? <Text style={[styles.hint, { color: colors.textMuted }]}>{blocker}</Text> : null}
      {sheet === 'category' ? <QuickCategorySheet tx={tx} onClose={() => setSheet(null)} onOpenDetails={props.onOpen} /> : null}
      {sheet === 'split' ? <SplitEditorSheet visible tx={tx} splits={splits} onClose={() => setSheet(null)} /> : null}
    </View>
  );
}

function ActionButton(props: { icon: string; label: string; onPress: () => void; disabled?: boolean }) {
  const colors = useTheme();
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      style={({ pressed }) => [
        styles.action,
        { backgroundColor: colors.surface, borderColor: colors.border, opacity: props.disabled ? 0.45 : pressed ? 0.7 : 1 },
      ]}
    >
      <Icon name={props.icon} size={18} color={colors.primary} />
      <Text style={{ color: colors.text, fontWeight: '600', fontSize: 13 }}>{props.label}</Text>
    </Pressable>
  );
}

/** Pick everyday categories without leaving the list. Loans and the like need the detail page. */
function QuickCategorySheet(props: { tx: Transaction; onClose: () => void; onOpenDetails: () => void }) {
  const colors = useTheme();
  const categories = useData((s) => s.categories);
  const [selected, setSelected] = useState<number[]>(() => selectedCategoryIds(props.tx));
  const flow = isCredit(props.tx) ? 'income' : 'expense';
  const choices = categories.filter((c) => c.flow === flow && c.id != null && !isManagedCategory(c));

  const toggle = async (id: number) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    const previous = selected;
    setSelected(next);
    const tx = props.tx;
    const primary = tx.categoryId != null && next.includes(tx.categoryId) ? tx.categoryId : next[0] ?? null;
    try {
      await transactionRepository.updateTransactionCategories([
        makeTransaction({ ...tx, categoryId: primary, categoryIds: next.length > 0 ? next : null }),
      ]);
      notifyDataChanged();
    } catch (error) {
      setSelected(previous);
      showError('Could not update categories', error);
    }
  };

  return (
    <Sheet visible onClose={props.onClose} title="Categorize">
      <View style={{ gap: spacing.md }}>
        <View style={ui.rowWrap}>
          {choices.map((c) => (
            <Chip key={c.id!} label={c.name} selected={selected.includes(c.id!)} onPress={() => void toggle(c.id!)} />
          ))}
        </View>
        <Pressable
          onPress={() => {
            props.onClose();
            props.onOpenDetails();
          }}
        >
          <Text style={{ color: colors.textSecondary }}>
            Loan, repayment or reimbursement? <Text style={{ color: colors.primary, fontWeight: '600' }}>Open details</Text>
          </Text>
        </Pressable>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  expanded: { borderRadius: 10, marginHorizontal: -spacing.xs, paddingHorizontal: spacing.xs, paddingBottom: spacing.sm },
  actions: { flexDirection: 'row', gap: spacing.sm },
  action: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingVertical: spacing.sm,
  },
  hint: { fontSize: 12, marginTop: spacing.xs, textAlign: 'center' },
});
