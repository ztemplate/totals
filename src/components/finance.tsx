import React from 'react';
import { Image, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import { bankImage } from '../data/bankImages';
import { bankById } from '../repositories/bankRepository';
import type { Bank } from '../models/bank';
import { categoryIconName, type Category } from '../models/category';
import { isCredit, selectedCategoryIds, txDate, type Transaction } from '../models/transaction';
import { useData } from '../store/dataStore';
import { useSettings, useTheme } from '../store/settingsStore';
import { categoryColor, spacing } from '../theme/colors';
import { CASH_ATM_REFERENCE_PREFIX } from '../utils/cashConstants';
import { formatMoney, formatTime, initials, relativeDayLabel, titleCase } from '../utils/format';
import { transactionFeeAmount } from '../utils/transactionAmounts';
import { Icon, Pill } from './ui';

/** Money text that respects the "hide balances" preference. */
export function AmountText(props: {
  value: number;
  style?: StyleProp<TextStyle>;
  compact?: boolean;
  sign?: '+' | '-' | null;
  color?: string;
  alwaysVisible?: boolean;
}) {
  const colors = useTheme();
  const hidden = useSettings((s) => s.hideBalances) && !props.alwaysVisible;
  const text = formatMoney(Math.abs(props.value), { compact: props.compact, hidden });
  const prefix = props.sign && !hidden ? `${props.sign} ` : props.value < 0 && !props.sign && !hidden ? '-' : '';
  return <Text style={[{ color: props.color ?? colors.text, fontVariant: ['tabular-nums'] }, props.style]}>{`${prefix}${text}`}</Text>;
}

export function BankAvatar(props: { bank: Bank | null | undefined; size?: number }) {
  const colors = useTheme();
  const size = props.size ?? 40;
  const source = bankImage(props.bank?.image);
  if (source) {
    return (
      <Image
        source={source}
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.surfaceMuted }}
        resizeMode="cover"
      />
    );
  }
  return (
    <View style={[avatarStyles.circle, { width: size, height: size, borderRadius: size / 2, backgroundColor: colors.primarySoft }]}>
      <Text style={{ color: colors.primary, fontWeight: '700', fontSize: size * 0.35 }}>
        {initials(props.bank?.shortName || props.bank?.name || '?')}
      </Text>
    </View>
  );
}

export function CategoryIcon(props: { category: Category | null | undefined; size?: number }) {
  const colors = useTheme();
  const size = props.size ?? 40;
  if (!props.category) {
    return (
      <View style={[avatarStyles.circle, { width: size, height: size, borderRadius: size / 2, backgroundColor: colors.surfaceMuted }]}>
        <Icon name="help-outline" size={size * 0.5} color={colors.textMuted} />
      </View>
    );
  }
  const color = categoryColor(props.category.colorKey, props.category.id);
  return (
    <View style={[avatarStyles.circle, { width: size, height: size, borderRadius: size / 2, backgroundColor: `${color}22` }]}>
      <Icon name={categoryIconName(props.category.iconKey)} size={size * 0.5} color={color} />
    </View>
  );
}

export function counterpartyOf(tx: Transaction): string {
  const raw = isCredit(tx) ? tx.creditor || tx.receiver : tx.receiver || tx.creditor;
  const trimmed = (raw ?? '').trim();
  return trimmed ? titleCase(trimmed) : isCredit(tx) ? 'Money received' : 'Money sent';
}

export function categoriesFor(tx: Transaction, categories: Category[]): Category[] {
  const ids = selectedCategoryIds(tx);
  return ids.map((id) => categories.find((c) => c.id === id)).filter((c): c is Category => !!c);
}

export function TransactionRow(props: { tx: Transaction; onPress?: () => void; showDate?: boolean }) {
  const colors = useTheme();
  const { banksWithCash, categories, selfTransferReferences, splitsByParent } = useData();
  const calendar = useSettings((s) => s.calendar);
  const { tx } = props;
  const credit = isCredit(tx);
  const bank = bankById(banksWithCash, tx.bankId);
  const txCategories = categoriesFor(tx, categories);
  const primary = txCategories[0];
  const date = txDate(tx);
  const self = selfTransferReferences.has(tx.reference);
  const splitCount = splitsByParent.get(tx.reference)?.length ?? 0;
  // A bank debit mirrored into the cash wallet is an ATM withdrawal: money moved to your pocket.
  const toPocket = !credit && selfTransferReferences.has(`${CASH_ATM_REFERENCE_PREFIX}${tx.reference}`);
  const amount = credit ? Math.abs(tx.amount) : Math.abs(tx.amount) + transactionFeeAmount(tx);
  const subtitleParts = [
    primary ? (txCategories.length > 1 ? `${primary.name} +${txCategories.length - 1}` : primary.name) : 'Uncategorized',
    bank?.shortName,
    date ? (props.showDate ? `${relativeDayLabel(date, calendar)} ${formatTime(date)}` : formatTime(date)) : null,
  ].filter(Boolean);
  return (
    <Pressable
      onPress={props.onPress}
      style={({ pressed }) => [txStyles.row, pressed && { backgroundColor: colors.surfaceMuted }]}
    >
      <View>
        <CategoryIcon category={primary} size={42} />
        {bank ? (
          <View style={[txStyles.bankBadge, { borderColor: colors.surface }]}>
            <BankAvatar bank={bank} size={18} />
          </View>
        ) : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[txStyles.title, { color: colors.text }]} numberOfLines={1}>
          {counterpartyOf(tx)}
        </Text>
        <Text style={{ color: colors.textSecondary, fontSize: 12 }} numberOfLines={1}>
          {subtitleParts.join(' · ')}
        </Text>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        <AmountText
          value={amount}
          sign={credit ? '+' : '-'}
          color={self ? colors.textSecondary : credit ? colors.income : colors.text}
          style={txStyles.amount}
        />
        {toPocket ? (
          <Pill label="To pocket" color={colors.info} />
        ) : self ? (
          <Pill label="Self" color={colors.info} />
        ) : null}
        {splitCount > 0 ? <Pill label={`Split · ${splitCount}`} color={colors.primary} /> : null}
      </View>
    </Pressable>
  );
}

/** Groups transactions by calendar day, newest first. */
export function groupByDay(transactions: Transaction[]): { key: string; date: Date | null; items: Transaction[] }[] {
  const groups = new Map<string, { key: string; date: Date | null; items: Transaction[] }>();
  for (const tx of transactions) {
    const d = txDate(tx);
    const key = d ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` : 'unknown';
    let group = groups.get(key);
    if (!group) {
      group = { key, date: d ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : null, items: [] };
      groups.set(key, group);
    }
    group.items.push(tx);
  }
  return [...groups.values()].sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
}

export function sortByTimeDesc(transactions: Transaction[]): Transaction[] {
  return [...transactions].sort((a, b) => (txDate(b)?.getTime() ?? 0) - (txDate(a)?.getTime() ?? 0));
}

const avatarStyles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center' },
});

const txStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm, paddingHorizontal: spacing.xs, borderRadius: 8 },
  title: { fontSize: 15, fontWeight: '600' },
  amount: { fontSize: 15, fontWeight: '700' },
  bankBadge: { position: 'absolute', right: -4, bottom: -4, borderWidth: 2, borderRadius: 11 },
});
