import * as Clipboard from 'expo-clipboard';
import { CameraView, useCameraPermissions } from 'expo-camera';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { hasSmsPermission, requestSmsPermission } from '../../modules/sms-reader';
import { DateRangeSheet } from '../components/dateRange';
import { confirm, showError } from '../components/dialogs';
import { AmountText, BankAvatar, sortByTimeDesc } from '../components/finance';
import { ExpandableTransactionRow } from '../components/transactionActions';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  Icon,
  IconButton,
  ListRow,
  Pill,
  ProgressBar,
  Screen,
  SectionTitle,
  SegmentedControl,
  Sheet,
  TextField,
  ToggleRow,
  styles as ui,
} from '../components/ui';
import type { Account } from '../models/account';
import type { Bank } from '../models/bank';
import type { UserAccount } from '../models/misc';
import type { AppNavigation, StackScreenProps } from '../navigation/types';
import { accountRepository } from '../repositories/accountRepository';
import { bankById } from '../repositories/bankRepository';
import { sourceSmsRepository } from '../repositories/sourceSmsRepository';
import { userAccountRepository } from '../repositories/userAccountRepository';
import { claimMessagesForAccount, labelDetectedAccount, reconcileAccounts } from '../services/accountLabeling';
import { smsService, type TodaySmsSyncResult } from '../services/smsService';
import { notifyDataChanged, useData } from '../store/dataStore';
import { useSettings, useTheme } from '../store/settingsStore';
import { radius, spacing } from '../theme/colors';
import { decodeAccountSharePayload, encodeAccountSharePayload, type AccountShareEntry, type AccountSharePayload } from '../utils/accountSharePayload';
import { suggestedAccountHolderNameFromSms, transactionBelongsToAccount } from '../utils/accountIdentity';
import { accountDisplayBalance } from '../utils/balances';
import { CASH_BANK_ID } from '../utils/cashConstants';
import type { DateRange } from '../utils/dateRange';
import { formatDateTime, formatNumber, maskAccountNumber, parseAmountInput, relativeDayLabel } from '../utils/format';
import { detectUnlabeledAccounts, isMaskedAccountNumber, type UnlabeledAccount } from '../utils/unlabeledAccounts';

const QR_COLOR = '#1976D2';

async function copyNumber(accountNumber: string): Promise<void> {
  try {
    await Clipboard.setStringAsync(accountNumber);
    Alert.alert('Copied', `${accountNumber} copied to clipboard.`);
  } catch (error) {
    showError('Could not copy', error);
  }
}

function shareEntry(bank: Bank | null, accountNumber: string, name: string | null, fallbackBankId: number): AccountShareEntry {
  return {
    bankId: bank?.id ?? fallbackBankId,
    accountNumber,
    name,
    bankName: bank?.name ?? null,
    bankShortName: bank?.shortName ?? null,
  };
}

/** Bottom sheet with a scannable QR code for one or more account numbers. */
function QrShareSheet(props: { visible: boolean; onClose: () => void; name: string; entries: AccountShareEntry[] }) {
  const colors = useTheme();
  const value = useMemo(
    () => (props.entries.length > 0 ? encodeAccountSharePayload({ name: props.name, accounts: props.entries }) : ''),
    [props.entries, props.name],
  );
  return (
    <Sheet visible={props.visible} onClose={props.onClose} title="Share account">
      <View style={{ alignItems: 'center', gap: spacing.md }}>
        {value ? (
          <View style={styles.qrFrame}>
            <QRCode value={value} size={220} color={QR_COLOR} backgroundColor="#FFFFFF" />
          </View>
        ) : null}
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}>{props.name}</Text>
        <Text style={{ color: colors.textSecondary, textAlign: 'center' }}>
          Scan this code from Totals ("Accounts" → scan) to add {props.entries.length === 1 ? 'this account' : 'these accounts'}.
        </Text>
        <View style={{ alignSelf: 'stretch' }}>
          {props.entries.map((entry) => (
            <ListRow
              key={`${entry.bankId}:${entry.accountNumber}`}
              title={entry.accountNumber}
              subtitle={entry.bankName ?? entry.bankShortName}
              right={<IconButton name="content-copy" onPress={() => void copyNumber(entry.accountNumber)} />}
            />
          ))}
        </View>
      </View>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Accounts list (tracked accounts + Account Hub)
// ---------------------------------------------------------------------------

type AccountsTab = 'tracked' | 'hub';

export function AccountsScreen({ navigation }: StackScreenProps<'Accounts'>) {
  const [tab, setTab] = useState<AccountsTab>('tracked');

  useEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={ui.rowCenter}>
          <IconButton name="qr-code-scanner" accessibilityLabel="Scan account QR" onPress={() => navigation.navigate('ScanAccount')} />
          <IconButton name="add" accessibilityLabel="Add account" onPress={() => navigation.navigate('AddAccount')} />
        </View>
      ),
    });
  }, [navigation]);

  return (
    <Screen edges={['left', 'right', 'bottom']}>
      <SegmentedControl<AccountsTab>
        options={[
          { value: 'tracked', label: 'My accounts' },
          { value: 'hub', label: 'Account hub' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'tracked' ? <TrackedAccounts navigation={navigation as unknown as AppNavigation} /> : <AccountHub navigation={navigation} />}
    </Screen>
  );
}

/** Registered accounts grouped by bank, followed by the accounts found in bank SMS that are not labeled yet. */
export function TrackedAccounts({ navigation }: { navigation: AppNavigation }) {
  const colors = useTheme();
  const { accounts, banks, banksWithCash, transactions } = useData();
  const unlabeled = useMemo(() => detectUnlabeledAccounts(transactions, accounts, banks), [transactions, accounts, banks]);

  const groups = useMemo(() => {
    const byBank = new Map<number, Account[]>();
    for (const account of accounts) {
      const list = byBank.get(account.bank) ?? [];
      list.push(account);
      byBank.set(account.bank, list);
    }
    return [...byBank.entries()]
      .map(([bankId, list]) => ({
        bank: bankById(banksWithCash, bankId),
        bankId,
        accounts: list.sort((a, b) => Number(b.isDefault) - Number(a.isDefault)),
      }))
      // Cash wallet last, banks in their catalogue order.
      .sort((a, b) => (a.bankId === CASH_BANK_ID ? 1 : b.bankId === CASH_BANK_ID ? -1 : a.bankId - b.bankId));
  }, [accounts, banksWithCash]);

  const bankAccountCount = accounts.filter((a) => a.bank !== CASH_BANK_ID).length;

  return (
    <>
      {bankAccountCount === 0 && unlabeled.length === 0 ? (
        <EmptyState
          icon="account-balance"
          title="No bank accounts yet"
          message="Import your bank SMS to find your accounts automatically, or add one by hand."
          action={{ label: 'Add account', onPress: () => navigation.navigate('AddAccount') }}
        />
      ) : null}
      <UnlabeledAccounts items={unlabeled} navigation={navigation} />
      <SmsScanCard hasAccounts={bankAccountCount > 0} />
      {groups.map((group) => (
        <View key={group.bankId} style={{ gap: spacing.sm }}>
          <SectionTitle title={group.bank?.name ?? `Bank ${group.bankId}`} />
          <Card style={{ paddingVertical: spacing.xs }}>
            {group.accounts.map((account) => (
              <ListRow
                key={account.accountNumber}
                left={<BankAvatar bank={group.bank} size={40} />}
                title={account.accountHolderName || group.bank?.shortName || 'Account'}
                subtitle={account.bank === CASH_BANK_ID ? 'Cash wallet' : maskAccountNumber(account.accountNumber)}
                onPress={() => navigation.navigate('AccountDetail', { accountNumber: account.accountNumber, bank: account.bank })}
                right={
                  <View style={{ alignItems: 'flex-end', gap: 4 }}>
                    <AmountText
                      value={accountDisplayBalance(account, transactions)}
                      style={{ fontWeight: '700', color: account.isDormant ? colors.textMuted : colors.text }}
                    />
                    <View style={[ui.rowCenter, { gap: 4 }]}>
                      {account.isDefault && group.accounts.length > 1 ? <Pill label="Default" /> : null}
                      {account.isDormant ? <Pill label="Dormant" color={colors.textMuted} /> : null}
                      {!account.isDormant && !account.includeInTotals ? <Pill label="Excluded" color={colors.warning} /> : null}
                    </View>
                  </View>
                }
              />
            ))}
          </Card>
        </View>
      ))}
      <View style={[ui.rowCenter, { gap: spacing.md }]}>
        <Button title="Add account" icon="add" style={{ flex: 1 }} onPress={() => navigation.navigate('AddAccount')} />
        <Button
          title="Scan QR"
          icon="qr-code-scanner"
          variant="secondary"
          style={{ flex: 1 }}
          onPress={() => navigation.navigate('ScanAccount')}
        />
      </View>
    </>
  );
}

function unlabeledTitle(item: UnlabeledAccount, bank: Bank | null): string {
  if (item.accountNumber) return isMaskedAccountNumber(item.accountNumber) ? item.accountNumber : maskAccountNumber(item.accountNumber);
  if (bank?.simBased) return item.subscriptionId != null ? `SIM ${item.subscriptionId}` : 'Your number';
  return 'Number not in SMS';
}

/** Accounts seen in imported bank messages that are not registered yet, with a one-tap label flow. */
function UnlabeledAccounts({ items, navigation }: { items: UnlabeledAccount[]; navigation: AppNavigation }) {
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const banks = useData((s) => s.banks);
  const [labeling, setLabeling] = useState<UnlabeledAccount | null>(null);

  if (items.length === 0) return null;

  return (
    <View style={{ gap: spacing.sm }}>
      <SectionTitle title={`Unlabeled accounts (${items.length})`} />
      <Card style={{ gap: spacing.sm }}>
        <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
          Found in your bank SMS. Label the ones that are yours; their messages are already imported.
        </Text>
        {items.map((item) => {
          const bank = bankById(banks, item.bankId);
          return (
            <ListRow
              key={item.key}
              left={<BankAvatar bank={bank} size={40} />}
              title={`${bank?.shortName || bank?.name || 'Bank'} · ${unlabeledTitle(item, bank)}`}
              subtitle={`${item.count} message${item.count === 1 ? '' : 's'}${
                item.lastDate ? ` · last ${relativeDayLabel(item.lastDate, calendar)}` : ''
              }`}
              onPress={() => setLabeling(item)}
              onLongPress={() => navigation.navigate('Tabs', { screen: 'Money', params: { bankId: item.bankId } })}
              right={<Button title="Label" compact variant="secondary" onPress={() => setLabeling(item)} />}
            />
          );
        })}
      </Card>
      <LabelAccountSheet item={labeling} onClose={() => setLabeling(null)} />
    </View>
  );
}

type ScanKind = 'new' | 'range' | 'full' | 'recheck';

function scanSummary(result: TodaySmsSyncResult): string {
  if (result.processed === 0) return 'No bank messages in that period.';
  const parts = [
    result.added === 0 ? 'No new transactions.' : `${result.added} new transaction${result.added === 1 ? '' : 's'} added.`,
    `${result.processed} message${result.processed === 1 ? '' : 's'} read`,
  ];
  if (result.duplicates > 0) parts.push(`${result.duplicates} already imported`);
  if (result.noPattern > 0) parts.push(`${result.noPattern} not understood`);
  return `${parts[0]} ${parts.slice(1).join(', ')}.`;
}

/**
 * Reads bank SMS into the app: only what arrived since the last scan, a chosen date range, or the
 * whole inbox. Every scan also re-checks which account owns each message and its balance.
 */
function SmsScanCard({ hasAccounts }: { hasAccounts: boolean }) {
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const version = useData((s) => s.version);
  const [lastScan, setLastScan] = useState<Date | null | undefined>(undefined);
  const [imported, setImported] = useState(false);
  const [running, setRunning] = useState<ScanKind | null>(null);
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null);
  const [rangeSheet, setRangeSheet] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([smsService.getLastScanAt(), smsService.hasImportedAllBankHistory()])
      .then(([at, done]) => {
        if (!alive) return;
        setLastScan(at);
        setImported(done);
      })
      .catch(() => alive && setLastScan(null));
    return () => {
      alive = false;
    };
  }, [version, running]);

  if (Platform.OS !== 'android') return null;

  const run = async (kind: ScanKind, scan: () => Promise<TodaySmsSyncResult | string>) => {
    if (running) return;
    if (kind !== 'recheck' && !hasSmsPermission() && !(await requestSmsPermission())) {
      Alert.alert('SMS permission needed', 'Allow SMS access so bank messages can be read.');
      return;
    }
    setRunning(kind);
    setProgress(null);
    try {
      const result = await scan();
      if (typeof result === 'string') Alert.alert('Accounts checked', result);
      else if (result.permissionDenied) Alert.alert('SMS permission needed', 'Allow SMS access so bank messages can be read.');
      else Alert.alert('Scan complete', scanSummary(result));
    } catch (error) {
      showError('Could not scan SMS', error);
    } finally {
      setRunning(null);
      setProgress(null);
      notifyDataChanged();
    }
  };

  const onProgress = (processed: number, total: number) => setProgress({ processed, total });

  const scanNew = () => run('new', () => smsService.syncBankSmsSinceLastScan({ onProgress }));
  const scanRange = (range: DateRange | null) => {
    if (!range) return;
    void run('range', () => smsService.syncBankSmsBetween({ start: range.start, end: range.end, onProgress }));
  };
  const scanAll = async () => {
    if (
      imported &&
      !(await confirm('Re-scan every message?', 'Reads your whole inbox again. Already imported messages are skipped.', 'Re-scan'))
    ) {
      return;
    }
    void run('full', () => smsService.syncAllBankHistory({ onProgress }));
  };
  const recheck = () =>
    run('recheck', async () => {
      const { moved, balances } = await reconcileAccounts();
      if (moved === 0 && balances === 0) return 'Every message is under the right account and balances are up to date.';
      return [
        moved > 0 ? `${moved} message${moved === 1 ? '' : 's'} moved to the right account.` : null,
        balances > 0 ? `${balances} balance${balances === 1 ? '' : 's'} updated from the latest message.` : null,
      ]
        .filter(Boolean)
        .join(' ');
    });

  const neverScanned = lastScan === null && !imported;

  return (
    <View style={{ gap: spacing.sm }}>
      <SectionTitle title={neverScanned && !hasAccounts ? 'Find your accounts' : 'Bank SMS'} />
      <Card style={{ gap: spacing.sm }}>
        <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
          {neverScanned
            ? 'Read every supported bank SMS once and list the accounts they mention, no need to add accounts first.'
            : lastScan
              ? `Last scanned ${formatDateTime(lastScan, calendar)}.`
              : 'Scan for messages that arrived since your last import.'}
        </Text>
        {running ? (
          <View style={{ gap: spacing.xs }}>
            <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
              {running === 'recheck'
                ? 'Checking accounts…'
                : `Reading bank SMS… ${progress && progress.total > 0 ? `${progress.processed} of ${progress.total}` : ''}`}
            </Text>
            <ProgressBar progress={progress && progress.total > 0 ? progress.processed / progress.total : 0} />
          </View>
        ) : neverScanned ? (
          <Button title="Import all bank SMS" icon="sms" onPress={() => void scanAll()} />
        ) : (
          <>
            <Button
              title="Scan new messages"
              icon="sync"
              onPress={() => void scanNew()}
            />
            <View style={[ui.rowCenter, { gap: spacing.sm }]}>
              <Button
                title="Date range"
                icon="date-range"
                variant="secondary"
                compact
                style={{ flex: 1 }}
                onPress={() => setRangeSheet(true)}
              />
              <Button title="Full re-scan" icon="sms" variant="secondary" compact style={{ flex: 1 }} onPress={() => void scanAll()} />
            </View>
            {hasAccounts ? (
              <Button
                title="Recheck balances & owners"
                icon="fact-check"
                variant="ghost"
                compact
                onPress={() => void recheck()}
              />
            ) : null}
          </>
        )}
      </Card>
      <DateRangeSheet visible={rangeSheet} onClose={() => setRangeSheet(false)} value={null} onChange={scanRange} />
    </View>
  );
}

function LabelAccountSheet({ item, onClose }: { item: UnlabeledAccount | null; onClose: () => void }) {
  const colors = useTheme();
  const banks = useData((s) => s.banks);
  const bank = item ? bankById(banks, item.bankId) : null;
  const [number, setNumber] = useState('');
  const [holder, setHolder] = useState('');
  const [balance, setBalance] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!item) return;
    setNumber(item.accountNumber && !isMaskedAccountNumber(item.accountNumber) ? item.accountNumber : '');
    setBalance(item.lastBalance != null ? String(item.lastBalance) : '');
    setHolder('');
    let cancelled = false;
    // The greeting in the messages ("Dear Abebe") is the best guess for the holder name.
    sourceSmsRepository
      .getForTransactionReferences(item.references.slice(-30))
      .then((messages) => {
        if (cancelled) return;
        const name = messages.map((m) => suggestedAccountHolderNameFromSms(m.body)).find(Boolean);
        if (name) setHolder((current) => current || name);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [item]);

  const parsedBalance = parseAmountInput(balance);
  const masked = !!item?.accountNumber && isMaskedAccountNumber(item.accountNumber);

  const save = async () => {
    if (!item) return;
    const accountNumber = number.trim() || item.accountNumber || '';
    if (!accountNumber) {
      Alert.alert('Number required', bank?.simBased ? 'Enter your phone number for this SIM.' : 'Enter the account number.');
      return;
    }
    setSaving(true);
    try {
      const moved = await labelDetectedAccount({
        bankId: item.bankId,
        accountNumber,
        accountHolderName: holder,
        balance: parsedBalance ?? 0,
        subscriptionId: item.subscriptionId,
        references: item.references,
      });
      notifyDataChanged();
      onClose();
      Alert.alert('Account added', `${moved} message${moved === 1 ? '' : 's'} now belong to this account.`);
    } catch (error) {
      showError('Could not label account', error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet visible={item !== null} onClose={onClose} title="Label account">
      {item ? (
        <View style={{ gap: spacing.md }}>
          <View style={[ui.rowCenter, { gap: spacing.md }]}>
            <BankAvatar bank={bank} size={44} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }}>{bank?.name ?? 'Bank'}</Text>
              <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                {item.count} messages · in {formatNumber(item.credit)} · out {formatNumber(item.debit)}
              </Text>
            </View>
          </View>
          <TextField
            label={bank?.simBased ? 'Phone number' : 'Account number'}
            value={number}
            onChangeText={setNumber}
            keyboardType="number-pad"
            placeholder={item.accountNumber ?? (bank?.simBased ? '09…' : 'Account number')}
          />
          {masked ? (
            <Text style={{ color: colors.textMuted, fontSize: 12 }}>
              The bank hides part of the number. Enter the full number, or leave it empty to keep {item.accountNumber}.
            </Text>
          ) : null}
          <TextField label="Account holder name" value={holder} onChangeText={setHolder} autoCapitalize="words" placeholder="As it appears in the SMS" />
          <TextField label="Current balance" value={balance} onChangeText={setBalance} keyboardType="decimal-pad" placeholder="0" />
          <Button title="Add to my accounts" icon="check" loading={saving} onPress={() => void save()} />
        </View>
      ) : null}
    </Sheet>
  );
}

function AccountHub({ navigation }: { navigation: StackScreenProps<'Accounts'>['navigation'] }) {
  const colors = useTheme();
  const { banks, accounts, version } = useData();
  const [items, setItems] = useState<UserAccount[] | null>(null);
  const [search, setSearch] = useState('');
  const [bankFilter, setBankFilter] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [share, setShare] = useState<{ name: string; entries: AccountShareEntry[] } | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await userAccountRepository.getUserAccounts());
    } catch (error) {
      if (__DEV__) console.warn('debug: Failed to load user accounts', error);
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, version]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (items ?? []).filter((item) => {
      if (bankFilter !== null && item.bankId !== bankFilter) return false;
      if (!q) return true;
      const bank = bankById(banks, item.bankId);
      return [item.accountHolderName, item.accountNumber, bank?.name, bank?.shortName]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [items, search, bankFilter, banks]);

  const hubBanks = useMemo(() => {
    const ids = [...new Set((items ?? []).map((i) => i.bankId))];
    return ids.map((id) => bankById(banks, id)).filter((b): b is Bank => !!b);
  }, [items, banks]);

  const selectionMode = selected.size > 0;
  const toggleSelected = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const shareItems = (list: UserAccount[]) => {
    if (list.length === 0) return;
    const names = [...new Set(list.map((i) => i.accountHolderName.trim()).filter(Boolean))];
    setShare({
      name: names.length === 1 ? names[0] : 'Shared accounts',
      entries: list.map((i) => shareEntry(bankById(banks, i.bankId), i.accountNumber, i.accountHolderName || null, i.bankId)),
    });
  };

  const deleteItems = async (list: UserAccount[]) => {
    const ok = await confirm(
      list.length === 1 ? 'Remove account?' : `Remove ${list.length} accounts?`,
      'They will be removed from the Account Hub. Tracked accounts are not affected.',
      'Remove',
      true,
    );
    if (!ok) return;
    try {
      for (const item of list) if (item.id != null) await userAccountRepository.deleteUserAccount(item.id);
      setSelected(new Set());
      await load();
    } catch (error) {
      showError('Could not remove', error);
    }
  };

  const importTracked = async () => {
    let added = 0;
    try {
      for (const account of accounts) {
        if (account.bank === CASH_BANK_ID) continue;
        if (await userAccountRepository.userAccountExists(account.accountNumber, account.bank)) continue;
        await userAccountRepository.saveUserAccount({
          accountNumber: account.accountNumber,
          bankId: account.bank,
          accountHolderName: account.accountHolderName,
          createdAt: new Date().toISOString(),
        });
        added++;
      }
      await load();
      Alert.alert('Account hub', added > 0 ? `Added ${added} account${added === 1 ? '' : 's'}.` : 'Your accounts are already in the hub.');
    } catch (error) {
      showError('Could not import', error);
    }
  };

  const showItemActions = (item: UserAccount) => {
    const bank = bankById(banks, item.bankId);
    Alert.alert(item.accountHolderName || item.accountNumber, bank?.name ?? undefined, [
      { text: 'Copy number', onPress: () => void copyNumber(item.accountNumber) },
      { text: 'Share QR', onPress: () => shareItems([item]) },
      {
        text: 'Track this account',
        onPress: () =>
          navigation.navigate('AddAccount', {
            accountNumber: item.accountNumber,
            bank: item.bankId,
            accountHolderName: item.accountHolderName,
          }),
      },
      { text: 'Remove', style: 'destructive', onPress: () => void deleteItems([item]) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  if (items === null) return <Text style={{ color: colors.textSecondary }}>Loading…</Text>;

  const selectedItems = (items ?? []).filter((i) => i.id != null && selected.has(i.id));

  return (
    <>
      <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
        Keep account numbers you share often (yours, family, business partners). Copy them or share them as a QR code.
      </Text>
      <TextField value={search} onChangeText={setSearch} placeholder="Search name, number or bank" />
      {hubBanks.length > 1 ? (
        <View style={ui.rowWrap}>
          <Chip label="All banks" selected={bankFilter === null} onPress={() => setBankFilter(null)} />
          {hubBanks.map((bank) => (
            <Chip
              key={bank.id}
              label={bank.shortName || bank.name}
              selected={bankFilter === bank.id}
              onPress={() => setBankFilter(bankFilter === bank.id ? null : bank.id)}
            />
          ))}
        </View>
      ) : null}

      {selectionMode ? (
        <Card style={[ui.rowCenter, { paddingVertical: spacing.sm }]}>
          <Text style={{ color: colors.text, fontWeight: '600', flex: 1 }}>{selected.size} selected</Text>
          <IconButton name="qr-code" accessibilityLabel="Share selected" onPress={() => shareItems(selectedItems)} />
          <IconButton
            name="delete-outline"
            color={colors.expense}
            accessibilityLabel="Remove selected"
            onPress={() => void deleteItems(selectedItems)}
          />
          <IconButton name="close" accessibilityLabel="Clear selection" onPress={() => setSelected(new Set())} />
        </Card>
      ) : null}

      {visible.length === 0 ? (
        <EmptyState
          icon="contacts"
          title={items.length === 0 ? 'Account hub is empty' : 'No matches'}
          message={items.length === 0 ? 'Add accounts manually, scan a Totals QR, or import your tracked accounts.' : undefined}
        />
      ) : (
        <Card style={{ paddingVertical: spacing.xs }}>
          {visible.map((item) => {
            const bank = bankById(banks, item.bankId);
            const isSelected = item.id != null && selected.has(item.id);
            return (
              <ListRow
                key={item.id ?? `${item.bankId}:${item.accountNumber}`}
                left={
                  isSelected ? (
                    <View style={[styles.selectedAvatar, { backgroundColor: colors.primary }]}>
                      <Icon name="check" color={colors.onPrimary} />
                    </View>
                  ) : (
                    <BankAvatar bank={bank} size={40} />
                  )
                }
                title={item.accountHolderName || 'Unnamed'}
                subtitle={`${bank?.shortName ?? 'Bank'} · ${item.accountNumber}`}
                onPress={() => (selectionMode && item.id != null ? toggleSelected(item.id) : showItemActions(item))}
                onLongPress={() => item.id != null && toggleSelected(item.id)}
                right={
                  selectionMode ? null : (
                    <View style={ui.rowCenter}>
                      <IconButton name="content-copy" size={20} onPress={() => void copyNumber(item.accountNumber)} />
                      <IconButton name="qr-code" size={20} onPress={() => shareItems([item])} />
                    </View>
                  )
                }
              />
            );
          })}
        </Card>
      )}

      <View style={[ui.rowCenter, { gap: spacing.md }]}>
        <Button title="Add" icon="add" style={{ flex: 1 }} onPress={() => setAdding(true)} />
        <Button title="Scan QR" icon="qr-code-scanner" variant="secondary" style={{ flex: 1 }} onPress={() => navigation.navigate('ScanAccount')} />
      </View>
      <Button title="Import my tracked accounts" icon="download" variant="ghost" onPress={() => void importTracked()} />

      <HubAccountForm
        visible={adding}
        onClose={() => setAdding(false)}
        onSaved={() => {
          setAdding(false);
          void load();
        }}
      />
      <QrShareSheet
        visible={share !== null}
        onClose={() => setShare(null)}
        name={share?.name ?? ''}
        entries={share?.entries ?? []}
      />
    </>
  );
}

function BankPicker(props: { banks: Bank[]; value: number | null; onChange: (id: number) => void }) {
  return (
    <View style={ui.rowWrap}>
      {props.banks.map((bank) => (
        <Chip
          key={bank.id}
          label={bank.shortName || bank.name}
          selected={props.value === bank.id}
          onPress={() => props.onChange(bank.id)}
        />
      ))}
    </View>
  );
}

function HubAccountForm(props: { visible: boolean; onClose: () => void; onSaved: () => void }) {
  const banks = useData((s) => s.banks);
  const [bankId, setBankId] = useState<number | null>(null);
  const [number, setNumber] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (props.visible) {
      setBankId(null);
      setNumber('');
      setName('');
    }
  }, [props.visible]);

  const save = async () => {
    const accountNumber = number.trim();
    if (bankId === null || !accountNumber) {
      Alert.alert('Missing details', 'Choose a bank and enter the account number.');
      return;
    }
    setSaving(true);
    try {
      if (await userAccountRepository.userAccountExists(accountNumber, bankId)) {
        Alert.alert('Already saved', 'This account is already in your Account Hub.');
        return;
      }
      await userAccountRepository.saveUserAccount({
        accountNumber,
        bankId,
        accountHolderName: name.trim(),
        createdAt: new Date().toISOString(),
      });
      props.onSaved();
    } catch (error) {
      showError('Could not save', error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet visible={props.visible} onClose={props.onClose} title="Add to account hub">
      <View style={{ gap: spacing.md }}>
        <BankPicker banks={banks} value={bankId} onChange={setBankId} />
        <TextField label="Account number" value={number} onChangeText={setNumber} keyboardType="number-pad" />
        <TextField label="Account holder name" value={name} onChangeText={setName} autoCapitalize="words" />
        <Button title="Save" icon="check" loading={saving} onPress={() => void save()} />
      </View>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Account detail
// ---------------------------------------------------------------------------

const TX_PAGE = 50;

export function AccountDetailScreen({ route, navigation }: StackScreenProps<'AccountDetail'>) {
  const colors = useTheme();
  const { accounts, banksWithCash, transactions } = useData();
  const { accountNumber, bank: bankId } = route.params;
  const account = accounts.find((a) => a.bank === bankId && a.accountNumber === accountNumber) ?? null;
  const bank = bankById(banksWithCash, bankId);
  const isCash = bankId === CASH_BANK_ID;

  const [editing, setEditing] = useState(false);
  const [holder, setHolder] = useState('');
  const [number, setNumber] = useState('');
  const [balance, setBalance] = useState('');
  const [saving, setSaving] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{ processed: number; total: number } | null>(null);
  const [limit, setLimit] = useState(TX_PAGE);

  useEffect(() => {
    navigation.setOptions({ title: bank?.shortName || bank?.name || 'Account' });
  }, [navigation, bank]);

  const accountTransactions = useMemo(() => {
    if (!account) return [];
    return sortByTimeDesc(transactions.filter((tx) => transactionBelongsToAccount(tx, account, bank, accounts)));
  }, [account, transactions, bank, accounts]);

  const totals = useMemo(() => {
    let income = 0;
    let expense = 0;
    for (const tx of accountTransactions) {
      if (tx.type === 'CREDIT') income += Math.abs(tx.amount);
      else expense += Math.abs(tx.amount);
    }
    return { income, expense };
  }, [accountTransactions]);

  if (!account) {
    return (
      <Screen edges={['left', 'right', 'bottom']}>
        <EmptyState icon="account-balance" title="Account not found" message="It may have been deleted." />
      </Screen>
    );
  }

  const startEditing = () => {
    setHolder(account.accountHolderName);
    setNumber(account.accountNumber);
    setBalance(String(account.balance));
    setEditing(true);
  };

  const saveEdits = async () => {
    const newNumber = number.trim();
    const parsedBalance = parseAmountInput(balance);
    if (!isCash && !newNumber) {
      Alert.alert('Account number required', 'Enter the account number.');
      return;
    }
    if (balance.trim() && parsedBalance === null) {
      Alert.alert('Invalid balance', 'Enter a number.');
      return;
    }
    setSaving(true);
    try {
      if (!isCash && newNumber !== account.accountNumber && (await accountRepository.accountExists(newNumber, bankId))) {
        Alert.alert('Already exists', 'Another account with this number is already tracked.');
        return;
      }
      await accountRepository.updateAccountDetails({
        accountNumber: account.accountNumber,
        bank: bankId,
        newAccountNumber: isCash ? undefined : newNumber,
        accountHolderName: holder.trim(),
        balance: parsedBalance ?? undefined,
      });
      // Messages are matched on both the holder name and the number; re-check them after either changes.
      if (!isCash && (newNumber !== account.accountNumber || holder.trim() !== account.accountHolderName.trim())) {
        // A balance typed in here wins over the one in the newest message.
        await reconcileAccounts({ balances: parsedBalance == null || parsedBalance === account.balance });
      }
      setEditing(false);
      notifyDataChanged();
      if (!isCash && newNumber !== account.accountNumber) {
        navigation.setParams({ accountNumber: newNumber, bank: bankId });
      }
    } catch (error) {
      showError('Could not save', error);
    } finally {
      setSaving(false);
    }
  };

  const updatePreferences = async (prefs: { includeInTotals?: boolean; isDormant?: boolean }) => {
    try {
      await accountRepository.updateAccountPreferences({ accountNumber: account.accountNumber, bank: bankId, ...prefs });
      notifyDataChanged();
    } catch (error) {
      showError('Could not update', error);
    }
  };

  const makeDefault = async () => {
    try {
      await accountRepository.setDefaultAccount(account.accountNumber, bankId);
      notifyDataChanged();
    } catch (error) {
      showError('Could not update', error);
    }
  };

  const resync = async () => {
    if (Platform.OS !== 'android') {
      Alert.alert('Not available', 'Reading SMS is only possible on Android.');
      return;
    }
    setSyncProgress({ processed: 0, total: 0 });
    try {
      const result = await smsService.syncBankHistory({
        bankId,
        accountNumber: account.accountNumber,
        onProgress: (processed, total) => setSyncProgress({ processed, total }),
      });
      notifyDataChanged();
      if (result.permissionDenied) {
        Alert.alert('SMS permission needed', 'Allow Totals to read SMS to import past transactions.');
      } else {
        Alert.alert(
          'Sync complete',
          `${result.added} new transaction${result.added === 1 ? '' : 's'} added from ${result.processed} message${
            result.processed === 1 ? '' : 's'
          }.` + (result.noPattern > 0 ? ` ${result.noPattern} message(s) could not be parsed.` : ''),
        );
      }
    } catch (error) {
      showError('Sync failed', error);
    } finally {
      setSyncProgress(null);
    }
  };

  const remove = async () => {
    const bankAccounts = accounts.filter((a) => a.bank === bankId);
    const message =
      bankAccounts.length === 1 && !isCash
        ? `This removes the account and every ${bank?.shortName ?? 'bank'} transaction. This cannot be undone.`
        : 'This removes the account and its transactions. This cannot be undone.';
    const ok = await confirm('Delete account?', message, 'Delete', true);
    if (!ok) return;
    try {
      await accountRepository.deleteAccount(account.accountNumber, bankId);
      notifyDataChanged();
      navigation.goBack();
    } catch (error) {
      showError('Could not delete', error);
    }
  };

  const bankAccountCount = accounts.filter((a) => a.bank === bankId).length;
  const displayBalance = accountDisplayBalance(account, transactions);
  const shareEntries = [shareEntry(bank, account.accountNumber, account.accountHolderName || null, bankId)];

  return (
    <Screen edges={['left', 'right', 'bottom']}>
      <Card style={{ alignItems: 'center', gap: spacing.sm }}>
        <BankAvatar bank={bank} size={56} />
        <Text style={{ color: colors.textSecondary }}>{bank?.name ?? 'Account'}</Text>
        <AmountText value={displayBalance} style={{ fontSize: 28, fontWeight: '800' }} />
        <Text style={{ color: colors.text, fontWeight: '600' }}>{account.accountHolderName || '—'}</Text>
        {!isCash ? (
          <Pressable onPress={() => void copyNumber(account.accountNumber)} style={ui.rowCenter} hitSlop={8}>
            <Text style={{ color: colors.textSecondary, fontVariant: ['tabular-nums'] }}>{account.accountNumber}</Text>
            <Icon name="content-copy" size={16} color={colors.textMuted} />
          </Pressable>
        ) : null}
        <View style={[ui.rowCenter, { gap: 4 }]}>
          {account.isDefault && bankAccountCount > 1 ? <Pill label="Default" /> : null}
          {account.isDormant ? <Pill label="Dormant" color={colors.textMuted} /> : null}
          {!account.isDormant && !account.includeInTotals ? <Pill label="Excluded from totals" color={colors.warning} /> : null}
        </View>
      </Card>

      <View style={[ui.rowCenter, { gap: spacing.md }]}>
        <Card style={{ flex: 1, gap: 4 }}>
          <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Money in</Text>
          <AmountText value={totals.income} color={colors.income} compact style={{ fontSize: 16, fontWeight: '700' }} />
        </Card>
        <Card style={{ flex: 1, gap: 4 }}>
          <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Money out</Text>
          <AmountText value={totals.expense} color={colors.expense} compact style={{ fontSize: 16, fontWeight: '700' }} />
        </Card>
      </View>

      {editing ? (
        <Card style={{ gap: spacing.md }}>
          <TextField label="Account holder name" value={holder} onChangeText={setHolder} autoCapitalize="words" />
          {!isCash ? (
            <TextField label="Account number" value={number} onChangeText={setNumber} autoCapitalize="characters" />
          ) : null}
          <TextField
            label={isCash ? 'Opening balance' : 'Balance'}
            value={balance}
            onChangeText={setBalance}
            keyboardType="decimal-pad"
          />
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>
            {isCash
              ? 'The cash balance is the opening balance plus your cash transactions.'
              : 'The balance is updated automatically from the next bank SMS.'}
          </Text>
          <View style={[ui.rowCenter, { gap: spacing.md }]}>
            <Button title="Cancel" variant="secondary" style={{ flex: 1 }} onPress={() => setEditing(false)} />
            <Button title="Save" icon="check" style={{ flex: 1 }} loading={saving} onPress={() => void saveEdits()} />
          </View>
        </Card>
      ) : null}

      <Card style={{ paddingVertical: spacing.xs }}>
        {!editing ? <ListRow icon="edit" title="Edit details" chevron onPress={startEditing} /> : null}
        {!isCash ? (
          <>
            <ListRow icon="qr-code" title="Share as QR code" chevron onPress={() => setSharing(true)} />
            <ListRow
              icon="sync"
              title="Re-sync SMS history"
              subtitle={
                syncProgress
                  ? syncProgress.total > 0
                    ? `Processing ${syncProgress.processed} of ${syncProgress.total} messages…`
                    : 'Reading messages…'
                  : 'Import past transactions for this account from your inbox'
              }
              disabled={syncProgress !== null}
              onPress={() => void resync()}
            />
            {!account.isDefault && bankAccountCount > 1 ? (
              <ListRow
                icon="star-outline"
                title="Make default"
                subtitle={`Messages that can't be matched to an account go to the default ${bank?.shortName ?? ''} account`}
                onPress={() => void makeDefault()}
              />
            ) : null}
          </>
        ) : null}
        <ToggleRow
          icon="functions"
          title="Include in totals"
          subtitle={account.isDormant ? 'Dormant accounts are never counted' : 'Count this balance in your total balance'}
          value={account.includeInTotals && !account.isDormant}
          disabled={account.isDormant}
          onValueChange={(value) => void updatePreferences({ includeInTotals: value })}
        />
        {!isCash ? (
          <ToggleRow
            icon="bedtime"
            title="Dormant"
            subtitle="Hide from totals; transactions are still recorded"
            value={account.isDormant}
            onValueChange={(value) => void updatePreferences({ isDormant: value })}
          />
        ) : null}
        <ListRow icon="delete-outline" title="Delete account" destructive onPress={() => void remove()} />
      </Card>

      <SectionTitle title={`Transactions (${accountTransactions.length})`} />
      {accountTransactions.length === 0 ? (
        <EmptyState icon="receipt-long" title="No transactions yet" />
      ) : (
        <Card style={{ paddingVertical: spacing.xs }}>
          {accountTransactions.slice(0, limit).map((tx) => (
            <ExpandableTransactionRow
              key={tx.reference}
              tx={tx}
              showDate
              onOpen={() => navigation.push('TransactionDetail', { reference: tx.reference })}
            />
          ))}
          {accountTransactions.length > limit ? (
            <Button title="Show more" variant="ghost" onPress={() => setLimit((l) => l + TX_PAGE)} />
          ) : null}
        </Card>
      )}

      <QrShareSheet
        visible={sharing}
        onClose={() => setSharing(false)}
        name={account.accountHolderName || bank?.name || 'Account'}
        entries={shareEntries}
      />
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Add account
// ---------------------------------------------------------------------------

export function AddAccountScreen({ route, navigation }: StackScreenProps<'AddAccount'>) {
  const colors = useTheme();
  const banks = useData((s) => s.banks);
  const params = route.params;
  const [bankId, setBankId] = useState<number | null>(params?.bank ?? null);
  const [number, setNumber] = useState(params?.accountNumber ?? '');
  const [holder, setHolder] = useState(params?.accountHolderName ?? '');
  const [balance, setBalance] = useState('');
  const [syncSms, setSyncSms] = useState(Platform.OS === 'android');
  const [historyImported, setHistoryImported] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Once every bank SMS is imported, a new account only needs to claim its messages.
    smsService
      .hasImportedAllBankHistory()
      .then((imported) => {
        setHistoryImported(imported);
        if (imported) setSyncSms(false);
      })
      .catch(() => undefined);
  }, []);

  const selectableBanks = banks.filter((b) => b.id !== CASH_BANK_ID);
  const bank = bankById(banks, bankId);
  const parsedBalance = parseAmountInput(balance);
  const balanceError = balance.trim() && parsedBalance === null ? 'Enter a number' : null;

  const save = async () => {
    const accountNumber = number.trim();
    if (bankId === null) {
      Alert.alert('Choose a bank', 'Select the bank this account belongs to.');
      return;
    }
    if (!accountNumber) {
      Alert.alert('Account number required', bank?.simBased ? 'Enter the phone number.' : 'Enter the account number.');
      return;
    }
    if (balanceError) return;
    setSaving(true);
    try {
      if (await accountRepository.accountExists(accountNumber, bankId)) {
        Alert.alert('Already added', 'This account is already being tracked.');
        return;
      }
      await accountRepository.saveAccount({
        accountNumber,
        bank: bankId,
        balance: parsedBalance ?? 0,
        accountHolderName: holder.trim(),
        includeInTotals: true,
        isDormant: false,
        isDefault: false,
      });
      await claimMessagesForAccount({ accountNumber, bank: bankId });
      notifyDataChanged();

      if (syncSms && Platform.OS === 'android') {
        // Same as the Flutter registration flow: import past SMS in the background and notify when done.
        smsService
          .syncBankHistory({ bankId, accountNumber })
          .then((result) => {
            if (result.permissionDenied && __DEV__) console.warn('debug: SMS permission denied during account sync');
          })
          .catch((error) => {
            if (__DEV__) console.warn('debug: Account SMS sync failed', error);
          })
          .finally(() => notifyDataChanged());
        Alert.alert('Adding your account', "You can leave the app, we'll notify you when it's done.");
      }
      navigation.goBack();
    } catch (error) {
      showError('Could not add account', error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen edges={['left', 'right', 'bottom']}>
      <SectionTitle title="Bank" />
      <Card>
        <View style={ui.rowWrap}>
          {selectableBanks.map((b) => (
            <Pressable
              key={b.id}
              onPress={() => setBankId(b.id)}
              style={[
                styles.bankOption,
                {
                  borderColor: bankId === b.id ? colors.primary : colors.border,
                  backgroundColor: bankId === b.id ? colors.primarySoft : colors.surface,
                },
              ]}
            >
              <BankAvatar bank={b} size={36} />
              <Text style={{ color: colors.text, fontSize: 12, fontWeight: bankId === b.id ? '700' : '500' }} numberOfLines={1}>
                {b.shortName || b.name}
              </Text>
            </Pressable>
          ))}
        </View>
      </Card>

      <Card style={{ gap: spacing.md }}>
        <TextField
          label={bank?.simBased ? 'Phone number' : 'Account number'}
          value={number}
          onChangeText={setNumber}
          keyboardType="number-pad"
          placeholder={bank?.simBased ? '09…' : 'e.g. 1000123456789'}
        />
        <TextField
          label="Account holder name"
          value={holder}
          onChangeText={setHolder}
          autoCapitalize="words"
          placeholder="As it appears in the bank SMS"
        />
        <TextField
          label="Current balance (optional)"
          value={balance}
          onChangeText={setBalance}
          keyboardType="decimal-pad"
          placeholder="Updated from the next SMS"
          error={balanceError}
        />
      </Card>

      {Platform.OS === 'android' ? (
        <Card style={{ paddingVertical: spacing.xs }}>
          <ToggleRow
            icon="sms"
            title="Import past SMS"
            subtitle={
              historyImported
                ? 'Your bank SMS are already imported; their messages move to this account. Turn on to read the inbox again.'
                : 'Read previous messages from this bank to build your history'
            }
            value={syncSms}
            onValueChange={setSyncSms}
          />
        </Card>
      ) : null}

      <Button title="Add account" icon="check" loading={saving} onPress={() => void save()} />
      <Button title="Scan account QR" icon="qr-code-scanner" variant="ghost" onPress={() => navigation.replace('ScanAccount')} />
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Scan QR
// ---------------------------------------------------------------------------

export function ScanAccountScreen({ navigation }: StackScreenProps<'ScanAccount'>) {
  const colors = useTheme();
  const banks = useData((s) => s.banks);
  const accounts = useData((s) => s.accounts);
  const [permission, requestPermission] = useCameraPermissions();
  const [payload, setPayload] = useState<AccountSharePayload | null>(null);
  const [savingHub, setSavingHub] = useState(false);
  const handled = useRef(false);
  const lastInvalid = useRef<string | null>(null);

  const onScanned = ({ data }: { data: string }) => {
    if (handled.current) return;
    const decoded = decodeAccountSharePayload(data, banks);
    if (!decoded) {
      if (lastInvalid.current !== data) {
        lastInvalid.current = data;
        Alert.alert('Not a Totals code', 'This QR code does not contain account details.');
      }
      return;
    }
    handled.current = true;
    if (decoded.accounts.length === 1) {
      const entry = decoded.accounts[0];
      navigation.replace('AddAccount', {
        accountNumber: entry.accountNumber,
        bank: entry.bankId,
        accountHolderName: entry.name ?? decoded.name,
      });
      return;
    }
    setPayload(decoded);
  };

  const saveAllToHub = async () => {
    if (!payload) return;
    setSavingHub(true);
    let added = 0;
    try {
      for (const entry of payload.accounts) {
        if (await userAccountRepository.userAccountExists(entry.accountNumber, entry.bankId)) continue;
        await userAccountRepository.saveUserAccount({
          accountNumber: entry.accountNumber,
          bankId: entry.bankId,
          accountHolderName: entry.name ?? payload.name,
          createdAt: new Date().toISOString(),
        });
        added++;
      }
      notifyDataChanged();
      Alert.alert('Account hub', added > 0 ? `Saved ${added} account${added === 1 ? '' : 's'}.` : 'All accounts were already saved.');
    } catch (error) {
      showError('Could not save', error);
    } finally {
      setSavingHub(false);
    }
  };

  if (payload) {
    return (
      <Screen edges={['left', 'right', 'bottom']}>
        <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700' }}>{payload.name}</Text>
        <Text style={{ color: colors.textSecondary }}>
          {payload.accounts.length} accounts found. Track the ones that are yours, or save them all to the Account Hub.
        </Text>
        <Card style={{ paddingVertical: spacing.xs }}>
          {payload.accounts.map((entry) => {
            const bank = bankById(banks, entry.bankId);
            const tracked = accounts.some((a) => a.bank === entry.bankId && a.accountNumber === entry.accountNumber);
            return (
              <ListRow
                key={`${entry.bankId}:${entry.accountNumber}`}
                left={<BankAvatar bank={bank} size={40} />}
                title={entry.name ?? payload.name}
                subtitle={`${bank?.shortName ?? entry.bankShortName ?? entry.bankName ?? 'Bank'} · ${entry.accountNumber}`}
                right={
                  tracked ? (
                    <Pill label="Tracked" color={colors.income} />
                  ) : (
                    <Button
                      title="Track"
                      compact
                      variant="secondary"
                      onPress={() =>
                        navigation.replace('AddAccount', {
                          accountNumber: entry.accountNumber,
                          bank: entry.bankId,
                          accountHolderName: entry.name ?? payload.name,
                        })
                      }
                    />
                  )
                }
              />
            );
          })}
        </Card>
        <Button title="Save all to account hub" icon="contacts" loading={savingHub} onPress={() => void saveAllToHub()} />
        <Button
          title="Scan another"
          variant="ghost"
          icon="qr-code-scanner"
          onPress={() => {
            handled.current = false;
            lastInvalid.current = null;
            setPayload(null);
          }}
        />
      </Screen>
    );
  }

  if (!permission) {
    return (
      <Screen edges={['left', 'right', 'bottom']}>
        <Text style={{ color: colors.textSecondary }}>Checking camera permission…</Text>
      </Screen>
    );
  }

  if (!permission.granted) {
    return (
      <Screen edges={['left', 'right', 'bottom']}>
        <EmptyState
          icon="photo-camera"
          title="Camera access needed"
          message="Allow camera access to scan account QR codes shared from Totals."
          action={{
            label: permission.canAskAgain ? 'Allow camera' : 'Open settings',
            onPress: () => void (permission.canAskAgain ? requestPermission() : Linking.openSettings()),
          }}
        />
      </Screen>
    );
  }

  return (
    <Screen scroll={false} edges={['left', 'right', 'bottom']}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={onScanned}
      />
      <View pointerEvents="none" style={styles.scanOverlay}>
        <View style={[styles.scanFrame, { borderColor: colors.onPrimary }]} />
        <Text style={styles.scanHint}>Point the camera at a Totals account QR code</Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  qrFrame: { padding: spacing.lg, backgroundColor: '#FFFFFF', borderRadius: radius.card * 2 },
  selectedAvatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  bankOption: {
    width: 84,
    alignItems: 'center',
    gap: 6,
    paddingVertical: spacing.sm,
    paddingHorizontal: 4,
    borderRadius: radius.input,
    borderWidth: 1,
  },
  scanOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: spacing.lg },
  scanFrame: { width: 240, height: 240, borderWidth: 3, borderRadius: 24 },
  scanHint: {
    color: '#FFFFFF',
    fontWeight: '600',
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
});
