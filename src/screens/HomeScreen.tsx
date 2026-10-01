import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AmountText, BankAvatar, TransactionRow } from '../components/finance';
import { Card, EmptyState, IconButton, Icon, SectionTitle, styles as ui } from '../components/ui';
import { useAppNavigation } from '../navigation/types';
import { bankById } from '../repositories/bankRepository';
import { smsService } from '../services/smsService';
import { spendingSummary } from '../services/spendingSummary';
import { useData } from '../store/dataStore';
import { useSettings, useTheme } from '../store/settingsStore';
import { radius, spacing } from '../theme/colors';
import { accountDisplayBalance, totalBalance } from '../utils/balances';
import { maskAccountNumber } from '../utils/format';

interface SpendingSnapshot {
  today: number;
  week: number;
  month: number;
}

export function HomeScreen() {
  const colors = useTheme();
  const navigation = useAppNavigation();
  const { transactions, accounts, banksWithCash, version, profiles, activeProfileId } = useData();
  const hideBalances = useSettings((s) => s.hideBalances);
  const toggleHideBalances = useSettings((s) => s.toggleHideBalances);
  const [spending, setSpending] = useState<SpendingSnapshot | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      spendingSummary.getTodaySpending(),
      spendingSummary.getCurrentWeekSpending(),
      spendingSummary.getCurrentMonthSpending(),
    ])
      .then(([today, week, month]) => {
        if (!cancelled) setSpending({ today, week, month });
      })
      .catch((error) => {
        if (__DEV__) console.warn('debug: Failed to compute spending summary', error);
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  const visibleAccounts = useMemo(
    () => [...accounts].sort((a, b) => Number(a.isDormant) - Number(b.isDormant)),
    [accounts],
  );
  const total = useMemo(() => totalBalance(accounts, transactions), [accounts, transactions]);
  const recent = transactions.slice(0, 8);
  const activeProfile = profiles.find((p) => p.id === activeProfileId);

  const syncSms = useCallback(async () => {
    setSyncing(true);
    try {
      const result = await smsService.syncTodayBankSms();
      if (result.permissionDenied) {
        Alert.alert('SMS permission needed', 'Allow SMS access so Totals can read bank messages.');
      } else if (result.added > 0) {
        Alert.alert('SMS synced', `Added ${result.added} new transaction${result.added === 1 ? '' : 's'} from today.`);
      }
      await useData.getState().refresh();
    } catch (error) {
      Alert.alert('Sync failed', error instanceof Error ? error.message : String(error));
    } finally {
      setSyncing(false);
    }
  }, []);

  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={ui.screenContent}
      refreshControl={<RefreshControl refreshing={syncing} onRefresh={() => void syncSms()} tintColor={colors.primary} />}
    >
      <Card style={{ backgroundColor: colors.primary, borderColor: colors.primary }}>
        <View style={ui.rowCenter}>
          <Text style={[styles.balanceLabel, { color: colors.onPrimary }]}>
            Total balance{activeProfile && profiles.length > 1 ? ` · ${activeProfile.name}` : ''}
          </Text>
          <View style={ui.flex} />
          <IconButton
            name={hideBalances ? 'visibility-off' : 'visibility'}
            color={colors.onPrimary}
            onPress={() => void toggleHideBalances()}
            accessibilityLabel="Toggle balance visibility"
          />
        </View>
        <AmountText value={total} color={colors.onPrimary} style={styles.balance} />
        <Text style={{ color: colors.onPrimary, opacity: 0.8 }}>
          {accounts.filter((a) => a.includeInTotals && !a.isDormant).length} account(s) included
        </Text>
      </Card>

      <View style={styles.quickActions}>
        <QuickAction icon="add-circle-outline" label="Cash" onPress={() => navigation.navigate('AddCash')} />
        <QuickAction icon="handshake" label="Loans" onPress={() => navigation.navigate('Loans')} />
        <QuickAction icon="account-balance" label="Accounts" onPress={() => navigation.navigate('Accounts')} />
        <QuickAction icon="sync" label={syncing ? 'Syncing…' : 'Sync SMS'} onPress={() => void syncSms()} />
      </View>

      <SectionTitle title="Spending" action={{ label: 'Details', onPress: () => navigation.navigate('Money', { flow: 'expense' }) }} />
      <View style={styles.spendingRow}>
        <SpendingTile label="Today" value={spending?.today} />
        <SpendingTile label="This week" value={spending?.week} />
        <SpendingTile label="This month" value={spending?.month} />
      </View>

      <SectionTitle title="Accounts" action={{ label: 'Manage', onPress: () => navigation.navigate('Accounts') }} />
      {visibleAccounts.length === 0 ? (
        <Card>
          <EmptyState
            icon="account-balance"
            title="No accounts yet"
            message="Add a bank account so Totals can read its SMS."
            action={{ label: 'Add account', onPress: () => navigation.navigate('AddAccount') }}
          />
        </Card>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.md }}>
          {visibleAccounts.map((account) => {
            const bank = bankById(banksWithCash, account.bank);
            return (
              <Card
                key={`${account.bank}|${account.accountNumber}`}
                style={[styles.accountCard, account.isDormant && { opacity: 0.6 }]}
                onPress={() => navigation.navigate('AccountDetail', { accountNumber: account.accountNumber, bank: account.bank })}
              >
                <View style={ui.rowCenter}>
                  <BankAvatar bank={bank} size={32} />
                  <View style={ui.flex}>
                    <Text style={{ color: colors.text, fontWeight: '600' }} numberOfLines={1}>
                      {bank?.shortName ?? 'Account'}
                    </Text>
                    <Text style={{ color: colors.textSecondary, fontSize: 12 }} numberOfLines={1}>
                      {maskAccountNumber(account.accountNumber)}
                    </Text>
                  </View>
                </View>
                <AmountText value={accountDisplayBalance(account, transactions)} style={styles.accountBalance} />
                {!account.includeInTotals || account.isDormant ? (
                  <Text style={{ color: colors.textMuted, fontSize: 11 }}>
                    {account.isDormant ? 'Dormant' : 'Excluded from totals'}
                  </Text>
                ) : null}
              </Card>
            );
          })}
          <Card style={[styles.accountCard, ui.center]} onPress={() => navigation.navigate('AddAccount')}>
            <Icon name="add" size={28} color={colors.primary} />
            <Text style={{ color: colors.primary, fontWeight: '600' }}>Add account</Text>
          </Card>
        </ScrollView>
      )}

      <SectionTitle title="Recent transactions" action={{ label: 'See all', onPress: () => navigation.navigate('Money') }} />
      <Card style={{ paddingVertical: spacing.sm }}>
        {recent.length === 0 ? (
          <EmptyState
            icon="receipt-long"
            title="No transactions yet"
            message="Bank SMS will appear here automatically. Pull down to scan today's messages."
          />
        ) : (
          recent.map((tx) => (
            <TransactionRow
              key={tx.reference}
              tx={tx}
              showDate
              onPress={() => navigation.navigate('TransactionDetail', { reference: tx.reference })}
            />
          ))
        )}
      </Card>
    </ScrollView>
  );
}

function QuickAction(props: { icon: string; label: string; onPress: () => void }) {
  const colors = useTheme();
  return (
    <Pressable
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.quickAction,
        { backgroundColor: colors.surface, borderColor: colors.border },
        pressed && { opacity: 0.8 },
      ]}
    >
      <Icon name={props.icon} color={colors.primary} />
      <Text style={{ color: colors.text, fontSize: 12, fontWeight: '600' }} numberOfLines={1}>
        {props.label}
      </Text>
    </Pressable>
  );
}

function SpendingTile(props: { label: string; value: number | undefined }) {
  const colors = useTheme();
  return (
    <Card style={styles.spendingTile}>
      <Text style={{ color: colors.textSecondary, fontSize: 12 }}>{props.label}</Text>
      {props.value === undefined ? (
        <Text style={{ color: colors.textMuted }}>…</Text>
      ) : (
        <AmountText value={props.value} compact color={colors.expense} style={{ fontWeight: '700', fontSize: 15 }} />
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  balanceLabel: { fontSize: 14, fontWeight: '600', opacity: 0.9 },
  balance: { fontSize: 32, fontWeight: '800', marginVertical: spacing.xs },
  quickActions: { flexDirection: 'row', gap: spacing.sm },
  quickAction: {
    flex: 1,
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.md,
    borderRadius: radius.input,
    borderWidth: StyleSheet.hairlineWidth,
  },
  spendingRow: { flexDirection: 'row', gap: spacing.sm },
  spendingTile: { flex: 1, padding: spacing.md, gap: spacing.xs },
  accountCard: { width: 190, gap: spacing.sm, padding: spacing.md },
  accountBalance: { fontSize: 18, fontWeight: '700' },
});
