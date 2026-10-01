import React, { useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { showError } from '../components/dialogs';
import { Button, Card, Chip, Screen, SectionTitle, SegmentedControl, TextField, styles as ui } from '../components/ui';
import { isManagedCategory } from '../models/category';
import { makeTransaction } from '../models/transaction';
import type { StackScreenProps } from '../navigation/types';
import { transactionRepository } from '../repositories/transactionRepository';
import { notifyDataChanged, useData } from '../store/dataStore';
import { useTheme } from '../store/settingsStore';
import { spacing } from '../theme/colors';
import { CASH_ACCOUNT_NUMBER, CASH_BANK_ID, newManualCashReference } from '../utils/cashConstants';
import { addDays, parseDateInput, toDateInput } from '../utils/dates';
import { parseAmountInput } from '../utils/format';

type CashType = 'DEBIT' | 'CREDIT';

export function AddCashScreen({ route, navigation }: StackScreenProps<'AddCash'>) {
  const colors = useTheme();
  const categories = useData((s) => s.categories);
  const [type, setType] = useState<CashType>(route.params?.type ?? 'DEBIT');
  const [amount, setAmount] = useState('');
  const [counterparty, setCounterparty] = useState('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(toDateInput(new Date()));
  const [categoryIds, setCategoryIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);

  const flow = type === 'CREDIT' ? 'income' : 'expense';
  // Loan/debt, repayment and reimbursement links need the transaction detail flow, so they are picked after saving.
  const flowCategories = categories.filter((c) => c.flow === flow && c.id != null && !isManagedCategory(c));
  const parsedAmount = parseAmountInput(amount);
  const amountError = amount.trim() && (parsedAmount === null || parsedAmount <= 0) ? 'Enter a positive amount' : null;
  const parsedDate = parseDateInput(date);
  const dateError = date.trim() && !parsedDate ? 'Use YYYY-MM-DD' : null;

  const switchType = (next: CashType) => {
    setType(next);
    setCategoryIds([]);
  };

  const toggleCategory = (id: number) =>
    setCategoryIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const save = async () => {
    if (parsedAmount === null || parsedAmount <= 0) {
      Alert.alert('Amount required', 'Enter how much cash was spent or received.');
      return;
    }
    if (!parsedDate) {
      Alert.alert('Invalid date', 'Use the YYYY-MM-DD format.');
      return;
    }
    const now = new Date();
    const isToday = toDateInput(parsedDate) === toDateInput(now);
    // Keep the current time for today's entries so they sort naturally; past days use midday.
    const time = isToday
      ? now
      : new Date(parsedDate.getFullYear(), parsedDate.getMonth(), parsedDate.getDate(), 12, 0, 0);
    const name = counterparty.trim() || null;
    const reference = newManualCashReference();
    setSaving(true);
    try {
      await transactionRepository.saveTransaction(
        makeTransaction({
          amount: parsedAmount,
          reference,
          type,
          bankId: CASH_BANK_ID,
          accountNumber: CASH_ACCOUNT_NUMBER,
          receiver: type === 'DEBIT' ? name : null,
          creditor: type === 'CREDIT' ? name : null,
          note: note.trim() || null,
          time: time.toISOString(),
          status: 'COMPLETED',
          categoryId: categoryIds[0] ?? null,
          categoryIds: categoryIds.length > 0 ? categoryIds : null,
          sourceType: 'manual',
        }),
        { skipAutoCategorization: categoryIds.length > 0 },
      );
      notifyDataChanged();
      navigation.replace('TransactionDetail', { reference });
    } catch (error) {
      showError('Could not save', error);
    } finally {
      setSaving(false);
    }
  };

  const today = new Date();
  return (
    <Screen edges={['left', 'right', 'bottom']}>
      <SegmentedControl<CashType>
        options={[
          { value: 'DEBIT', label: 'Spent' },
          { value: 'CREDIT', label: 'Received' },
        ]}
        value={type}
        onChange={switchType}
      />
      <Card style={{ gap: spacing.md }}>
        <TextField
          label="Amount (ETB)"
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder="0.00"
          autoFocus
          error={amountError}
          style={{ fontSize: 22, fontWeight: '700' }}
        />
        <TextField
          label={type === 'DEBIT' ? 'Paid to' : 'Received from'}
          value={counterparty}
          onChangeText={setCounterparty}
          placeholder={type === 'DEBIT' ? 'Shop, person…' : 'Person, employer…'}
          autoCapitalize="words"
        />
        <TextField label="Date" value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" error={dateError} />
        <View style={ui.rowWrap}>
          <Chip label="Today" selected={date === toDateInput(today)} onPress={() => setDate(toDateInput(today))} />
          <Chip
            label="Yesterday"
            selected={date === toDateInput(addDays(today, -1))}
            onPress={() => setDate(toDateInput(addDays(today, -1)))}
          />
        </View>
        <TextField label="Note" value={note} onChangeText={setNote} placeholder="Optional" multiline />
      </Card>

      <SectionTitle title="Category" />
      <Card>
        <View style={ui.rowWrap}>
          {flowCategories.map((c) => (
            <Chip key={c.id!} label={c.name} selected={categoryIds.includes(c.id!)} onPress={() => toggleCategory(c.id!)} />
          ))}
        </View>
        <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: spacing.sm }}>
          Leave empty to use your auto-categorization rules. Loans, debts, repayments and reimbursements can be linked
          from the transaction after saving.
        </Text>
      </Card>

      <Button title={type === 'DEBIT' ? 'Save expense' : 'Save income'} icon="check" onPress={() => void save()} loading={saving} />
    </Screen>
  );
}
