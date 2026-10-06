import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { DateField } from '../components/dateRange';
import { confirm, showError } from '../components/dialogs';
import { AmountText } from '../components/finance';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  Icon,
  ListRow,
  Pill,
  ProgressBar,
  SectionTitle,
  SegmentedControl,
  Sheet,
  TextField,
  ToggleRow,
  styles as ui,
} from '../components/ui';
import {
  INCOME_CERTAINTIES,
  INCOME_FREQUENCIES,
  LIQUIDITY_OPTIONS,
  PRIORITY_META,
  type Asset,
  type IncomeSource,
  type MoneyOpportunity,
  type PlannedItem,
} from '../models/planning';
import {
  assetRepository,
  incomeSourceRepository,
  opportunityRepository,
  plannedItemRepository,
} from '../repositories/planningRepository';
import { notifyDataChanged, useData } from '../store/dataStore';
import { useSettings, useTheme } from '../store/settingsStore';
import { spacing } from '../theme/colors';
import { totalBalance } from '../utils/balances';
import { parseDateInput, toDateInput } from '../utils/dates';
import { toEthiopian } from '../utils/ethiopianCalendar';
import { formatDate, formatMoney, formatNumber, parseAmountInput } from '../utils/format';
import {
  benchmarkHourlyRate,
  daysUntil,
  incomeForYear,
  LIQUIDITY_FACTOR,
  monthlyEquivalent,
  PLAN_PRIORITIES,
  planShortfall,
  quickSaleValue,
  scoreOpportunity,
  strainMultiplier,
  summarizeAssets,
  type IncomeCertainty,
  type IncomeFrequency,
  type Liquidity,
  type OpportunityScore,
  type OpportunityVerdict,
  type PlanPriority,
  type Strain,
} from '../utils/planning';
import type { CalendarKind } from '../utils/periodUtils';

type Colors = ReturnType<typeof useTheme>;

function priorityColor(priority: PlanPriority, colors: Colors): string {
  if (priority === 'must') return colors.expense;
  if (priority === 'need') return colors.warning;
  return colors.info;
}

function yearLabel(now: Date, calendar: CalendarKind): string {
  return calendar === 'ethiopian' ? `${toEthiopian(now).year} E.C.` : String(now.getFullYear());
}

function dueLabel(date: Date, calendar: CalendarKind): string {
  const days = daysUntil(date);
  const when = formatDate(date, calendar);
  if (days < 0) return `Overdue · ${when}`;
  if (days === 0) return 'Needed today';
  if (days === 1) return 'Needed tomorrow';
  return `By ${when} · ${days} days`;
}

/** Loads a list and reloads it whenever data changes anywhere in the app. */
function useRows<T>(load: () => Promise<T[]>): T[] | null {
  const version = useData((s) => s.version);
  const [rows, setRows] = useState<T[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    load()
      .then((loaded) => !cancelled && setRows(loaded))
      .catch((error) => {
        if (__DEV__) console.warn('debug: Failed to load planning rows', error);
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  return rows;
}

/** Runs `open` when the header + button bumps `request`; a count from before mount is ignored. */
function useAddRequest(request: number, open: () => void) {
  const seen = useRef(request);
  useEffect(() => {
    if (request === seen.current) return;
    seen.current = request;
    open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);
}

function amountText(value: number): string {
  return value > 0 ? String(Number(value.toFixed(2))) : '';
}

function SummaryLine(props: { label: string; value: number; color?: string; bold?: boolean; hint?: string }) {
  const colors = useTheme();
  return (
    <View style={[ui.rowCenter, { justifyContent: 'space-between', gap: spacing.sm }]}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.textSecondary, fontWeight: props.bold ? '700' : '500' }}>{props.label}</Text>
        {props.hint ? <Text style={{ color: colors.textMuted, fontSize: 11 }}>{props.hint}</Text> : null}
      </View>
      <AmountText value={props.value} color={props.color} style={{ fontWeight: props.bold ? '700' : '600' }} />
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Planned spending
// ---------------------------------------------------------------------------------------------

/** Things you plan to buy, by must / need / want, and how much money you are short for each. */
export function PlannedSpendingView(props: { addRequest: number }) {
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const { accounts, transactions } = useData();
  const items = useRows(plannedItemRepository.getAll);
  const sources = useRows(incomeSourceRepository.getAll);
  const [editing, setEditing] = useState<PlannedItem | 'new' | null>(null);
  const [withIncome, setWithIncome] = useState(false);
  const [showBought, setShowBought] = useState(false);

  useAddRequest(props.addRequest, () => setEditing('new'));

  const balance = useMemo(() => totalBalance(accounts, transactions), [accounts, transactions]);
  const incomeToCome = useMemo(() => {
    const now = new Date();
    return (sources ?? [])
      .filter((s) => s.certainty !== 'uncertain')
      .reduce((sum, s) => sum + incomeForYear(incomeInput(s), now, calendar).toCome, 0);
  }, [sources, calendar]);
  const available = Math.max(0, balance) + (withIncome ? incomeToCome : 0);

  const open = useMemo(() => (items ?? []).filter((i) => !i.bought), [items]);
  const bought = useMemo(() => (items ?? []).filter((i) => i.bought), [items]);
  const shortfall = useMemo(
    () =>
      planShortfall(
        open.map((i) => ({ id: i.id, price: i.price, saved: i.saved, priority: i.priority, neededBy: parseDateInput(i.neededBy ?? '') })),
        available,
      ),
    [open, available],
  );

  const markBought = async (item: PlannedItem, value: boolean) => {
    try {
      await plannedItemRepository.setBought(item.id, value);
      notifyDataChanged();
    } catch (error) {
      showError('Could not update item', error);
    }
  };

  if (items === null) return <Text style={{ color: colors.textSecondary }}>Loading…</Text>;

  let cumulativeShort = 0;
  return (
    <>
      {open.length === 0 ? (
        <EmptyState
          icon="shopping-cart"
          title="Nothing planned yet"
          message="Add things you plan to buy, mark each as a must, need or want, and see how much money you are short."
          action={{ label: 'Add planned item', onPress: () => setEditing('new') }}
        />
      ) : (
        <Card style={{ gap: spacing.sm }}>
          <View style={[ui.rowCenter, { justifyContent: 'space-between' }]}>
            <View style={{ gap: 2 }}>
              <Text style={{ color: colors.textMuted, fontSize: 12 }}>Still to pay</Text>
              <AmountText value={shortfall.remaining} style={{ fontSize: 20, fontWeight: '700' }} />
            </View>
            <View style={{ gap: 2, alignItems: 'flex-end' }}>
              <Text style={{ color: colors.textMuted, fontSize: 12 }}>{withIncome ? 'Money + income to come' : 'Money you have'}</Text>
              <AmountText value={available} color={colors.textSecondary} style={{ fontSize: 16, fontWeight: '600' }} />
            </View>
          </View>
          <ProgressBar
            progress={shortfall.remaining > 0 ? (shortfall.remaining - shortfall.short) / shortfall.remaining : 1}
            color={shortfall.short > 0 ? colors.warning : colors.income}
          />
          {PLAN_PRIORITIES.map((p) => {
            const tier = shortfall.tiers[p];
            if (tier.count === 0) return null;
            cumulativeShort += tier.short;
            return (
              <View key={p} style={{ gap: 2 }}>
                <View style={[ui.rowCenter, { justifyContent: 'space-between' }]}>
                  <View style={[ui.rowCenter, { gap: spacing.xs }]}>
                    <Pill label={PRIORITY_META[p].label} color={priorityColor(p, colors)} />
                    <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                      {tier.count} item{tier.count === 1 ? '' : 's'} · <Text>{formatMoney(tier.remaining)}</Text> left
                    </Text>
                  </View>
                  {tier.short > 0 ? (
                    <AmountText value={tier.short} color={colors.expense} sign="-" style={{ fontWeight: '700' }} />
                  ) : (
                    <Text style={{ color: colors.income, fontWeight: '700' }}>Covered</Text>
                  )}
                </View>
                {p !== 'must' && cumulativeShort > tier.short ? (
                  <Text style={{ color: colors.textMuted, fontSize: 11 }}>
                    Short {formatMoney(cumulativeShort)} for {p === 'need' ? 'musts and needs' : 'everything'}
                  </Text>
                ) : null}
              </View>
            );
          })}
          <Text style={{ color: shortfall.short > 0 ? colors.expense : colors.income, fontWeight: '600' }}>
            {shortfall.short > 0
              ? `You are short ${formatMoney(shortfall.short)} in total`
              : `Everything is covered, ${formatMoney(shortfall.leftover)} to spare`}
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: 11 }}>
            Money goes to musts first, then needs, then wants, earliest date first. Savings already put aside for an item
            count as paid.
          </Text>
          {incomeToCome > 0 ? (
            <ToggleRow
              title="Count income still to come"
              subtitle={`${formatMoney(incomeToCome)} certain or likely income left this year (${yearLabel(new Date(), calendar)})`}
              value={withIncome}
              onValueChange={setWithIncome}
            />
          ) : null}
        </Card>
      )}

      {PLAN_PRIORITIES.map((p) => {
        const list = open.filter((i) => i.priority === p);
        if (list.length === 0) return null;
        return (
          <View key={p} style={{ gap: spacing.sm }}>
            <SectionTitle title={`${PRIORITY_META[p].label}s`} />
            {list
              .sort((a, b) => (a.neededBy ?? '9999').localeCompare(b.neededBy ?? '9999') || a.id - b.id)
              .map((item) => (
                <PlannedItemCard
                  key={item.id}
                  item={item}
                  covered={shortfall.coveredById.get(item.id) ?? 0}
                  calendar={calendar}
                  onPress={() => setEditing(item)}
                  onBought={() => void markBought(item, true)}
                />
              ))}
          </View>
        );
      })}

      {open.length > 0 ? <Button title="Add planned item" variant="secondary" icon="add" onPress={() => setEditing('new')} /> : null}

      {bought.length > 0 ? (
        <>
          <SectionTitle
            title={`Bought (${bought.length})`}
            action={{ label: showBought ? 'Hide' : 'Show', onPress: () => setShowBought((v) => !v) }}
          />
          {showBought ? (
            <Card>
              {bought.map((item) => (
                <ListRow
                  key={item.id}
                  icon="check-circle"
                  iconColor={colors.income}
                  title={item.name}
                  subtitle={[
                    PRIORITY_META[item.priority].label,
                    item.boughtAt ? formatDate(new Date(item.boughtAt), calendar) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  value={formatMoney(item.price)}
                  onPress={() => setEditing(item)}
                  onLongPress={() => void markBought(item, false)}
                />
              ))}
            </Card>
          ) : null}
        </>
      ) : null}

      <PlannedItemSheet item={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function PlannedItemCard(props: {
  item: PlannedItem;
  covered: number;
  calendar: CalendarKind;
  onPress: () => void;
  onBought: () => void;
}) {
  const colors = useTheme();
  const { item } = props;
  const remaining = Math.max(0, item.price - item.saved);
  const short = remaining - props.covered;
  const due = parseDateInput(item.neededBy ?? '');
  const overdue = !!due && daysUntil(due) < 0;
  const color = priorityColor(item.priority, colors);
  return (
    <Card onPress={props.onPress} style={{ gap: spacing.sm }}>
      <View style={ui.rowCenter}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={{ color: overdue ? colors.expense : colors.textSecondary, fontSize: 12 }} numberOfLines={1}>
            {[due ? dueLabel(due, props.calendar) : 'No date', item.note].filter(Boolean).join(' · ')}
          </Text>
        </View>
        <AmountText value={item.price} style={{ fontWeight: '700' }} />
      </View>
      <ProgressBar progress={item.price > 0 ? (item.saved + props.covered) / item.price : 1} color={short > 0 ? color : colors.income} />
      <View style={[ui.rowCenter, { justifyContent: 'space-between' }]}>
        <Text style={{ color: short > 0 ? colors.expense : colors.income, fontSize: 12, fontWeight: '600' }}>
          {short > 0 ? `Short ${formatMoney(short)}` : 'Covered'}
          {item.saved > 0 ? <Text style={{ color: colors.textSecondary, fontWeight: '400' }}>{` · ${formatMoney(item.saved)} saved`}</Text> : null}
        </Text>
        <Button title="Bought" icon="check" compact variant="ghost" onPress={props.onBought} />
      </View>
    </Card>
  );
}

function PlannedItemSheet(props: { item: PlannedItem | 'new' | null; onClose: () => void }) {
  const colors = useTheme();
  const editing = props.item && props.item !== 'new' ? props.item : null;
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [saved, setSaved] = useState('');
  const [priority, setPriority] = useState<PlanPriority>('need');
  const [neededBy, setNeededBy] = useState<Date | null>(null);
  const [note, setNote] = useState('');
  const [bought, setBought] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!props.item) return;
    setName(editing?.name ?? '');
    setPrice(amountText(editing?.price ?? 0));
    setSaved(amountText(editing?.saved ?? 0));
    setPriority(editing?.priority ?? 'need');
    setNeededBy(parseDateInput(editing?.neededBy ?? ''));
    setNote(editing?.note ?? '');
    setBought(editing?.bought ?? false);
  }, [props.item, editing]);

  const priceValue = parseAmountInput(price);
  const savedValue = parseAmountInput(saved) ?? 0;
  const priceError = price.trim() && (priceValue === null || priceValue < 0) ? 'Enter a price' : null;

  const save = async () => {
    if (priceValue === null || priceValue < 0) {
      showError('Price needed', new Error('Enter how much it costs.'));
      return;
    }
    setBusy(true);
    try {
      const draft = {
        name,
        price: priceValue,
        saved: Math.min(savedValue, priceValue),
        priority,
        neededBy: neededBy ? toDateInput(neededBy) : null,
        note,
        bought,
        boughtAt: editing?.bought ? editing.boughtAt : null,
      };
      if (editing) await plannedItemRepository.update(editing.id, draft);
      else await plannedItemRepository.create(draft);
      notifyDataChanged();
      props.onClose();
    } catch (error) {
      showError('Could not save item', error);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing || !(await confirm(`Delete ${editing.name}?`, 'It is removed from your plan.', 'Delete', true))) return;
    await plannedItemRepository.remove(editing.id);
    notifyDataChanged();
    props.onClose();
  };

  return (
    <Sheet visible={!!props.item} onClose={props.onClose} title={editing ? 'Edit planned item' : 'Plan a purchase'}>
      <View style={{ gap: spacing.md }}>
        <TextField label="What" value={name} onChangeText={setName} placeholder="e.g. School fees, new phone" autoCapitalize="sentences" />
        <TextField label="Price (ETB)" value={price} onChangeText={setPrice} keyboardType="decimal-pad" placeholder="0" error={priceError} />
        <View style={{ gap: spacing.xs }}>
          <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600' }}>How important</Text>
          <View style={ui.rowWrap}>
            {PLAN_PRIORITIES.map((p) => (
              <Chip
                key={p}
                label={PRIORITY_META[p].label}
                selected={priority === p}
                color={priorityColor(p, colors)}
                onPress={() => setPriority(p)}
              />
            ))}
          </View>
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>{PRIORITY_META[priority].hint}</Text>
        </View>
        <DateField label="Needed by (optional)" value={neededBy} onChange={setNeededBy} placeholder="No date" clearable />
        <TextField
          label="Already saved for it (optional)"
          value={saved}
          onChangeText={setSaved}
          keyboardType="decimal-pad"
          placeholder="0"
        />
        <TextField label="Note (optional)" value={note} onChangeText={setNote} placeholder="Where to buy, model, …" />
        {editing ? <ToggleRow title="Bought" icon="check-circle" value={bought} onValueChange={setBought} /> : null}
        <Button title="Save" onPress={() => void save()} loading={busy} disabled={!name.trim()} />
        {editing ? <Button title="Delete" variant="danger" icon="delete" onPress={() => void remove()} /> : null}
      </View>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------------------------
// Income: expected income, assets, ways to earn
// ---------------------------------------------------------------------------------------------

type IncomeTab = 'expected' | 'assets' | 'earn';

function incomeInput(source: IncomeSource) {
  return {
    amount: source.amount,
    frequency: source.frequency,
    start: parseDateInput(source.startDate) ?? new Date(),
    end: parseDateInput(source.endDate ?? ''),
  };
}

export function IncomeView(props: { addRequest: number }) {
  const [tab, setTab] = useState<IncomeTab>('expected');
  const [addRequests, setAddRequests] = useState<Record<IncomeTab, number>>({ expected: 0, assets: 0, earn: 0 });

  useAddRequest(props.addRequest, () => setAddRequests((r) => ({ ...r, [tab]: r[tab] + 1 })));

  return (
    <>
      <View style={ui.rowWrap}>
        {(
          [
            ['expected', 'Expected income', 'event-repeat'],
            ['assets', 'Assets', 'account-balance'],
            ['earn', 'Ways to earn', 'trending-up'],
          ] as const
        ).map(([value, label, icon]) => (
          <Chip key={value} label={label} icon={icon} selected={tab === value} onPress={() => setTab(value)} />
        ))}
      </View>
      {tab === 'expected' ? <ExpectedIncomeView addRequest={addRequests.expected} /> : null}
      {tab === 'assets' ? <AssetsView addRequest={addRequests.assets} /> : null}
      {tab === 'earn' ? <OpportunitiesView addRequest={addRequests.earn} /> : null}
    </>
  );
}

const CERTAINTY_ORDER: IncomeCertainty[] = ['certain', 'likely', 'uncertain'];

function ExpectedIncomeView(props: { addRequest: number }) {
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const sources = useRows(incomeSourceRepository.getAll);
  const [editing, setEditing] = useState<IncomeSource | 'new' | null>(null);

  useAddRequest(props.addRequest, () => setEditing('new'));

  const now = new Date();
  const rows = useMemo(
    () =>
      (sources ?? [])
        .map((source) => ({ source, year: incomeForYear(incomeInput(source), new Date(), calendar) }))
        .sort((a, b) => (a.year.next?.getTime() ?? Infinity) - (b.year.next?.getTime() ?? Infinity) || b.year.total - a.year.total),
    [sources, calendar],
  );
  const totals = useMemo(() => {
    const byCertainty: Record<IncomeCertainty, number> = { certain: 0, likely: 0, uncertain: 0 };
    let total = 0;
    let received = 0;
    let toCome = 0;
    let monthly = 0;
    for (const { source, year } of rows) {
      byCertainty[source.certainty] += year.total;
      total += year.total;
      received += year.received;
      toCome += year.toCome;
      if (year.next || year.toCome > 0) monthly += monthlyEquivalent(source);
    }
    return { byCertainty, total, received, toCome, monthly };
  }, [rows]);

  if (sources === null) return <Text style={{ color: colors.textSecondary }}>Loading…</Text>;
  if (sources.length === 0) {
    return (
      <>
        <EmptyState
          icon="event-repeat"
          title="No expected income"
          message="Add your salary, rent you collect or a payment you are waiting for. Recurring income is projected over the year."
          action={{ label: 'Add income', onPress: () => setEditing('new') }}
        />
        <IncomeSourceSheet source={editing} onClose={() => setEditing(null)} />
      </>
    );
  }

  const yearStart = rows[0]?.year.yearStart ?? now;
  const yearEndInclusive = new Date((rows[0]?.year.yearEnd ?? now).getTime() - 86_400_000);
  const elapsed = Math.min(1, Math.max(0, (now.getTime() - yearStart.getTime()) / (yearEndInclusive.getTime() - yearStart.getTime() + 86_400_000)));

  return (
    <>
      <Card style={{ gap: spacing.sm }}>
        <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
          Year {yearLabel(now, calendar)} · {formatDate(yearStart, calendar)} – {formatDate(yearEndInclusive, calendar)}
        </Text>
        <View style={{ gap: 2 }}>
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>Expected this year</Text>
          <AmountText value={totals.total} color={colors.income} style={{ fontSize: 22, fontWeight: '700' }} />
        </View>
        <ProgressBar progress={totals.total > 0 ? totals.received / totals.total : elapsed} color={colors.income} />
        <SummaryLine label="Already due" value={totals.received} />
        <SummaryLine label="Still to come" value={totals.toCome} bold />
        {totals.monthly > 0 ? <SummaryLine label="Regular income per month" value={totals.monthly} hint="Recurring sources averaged to a month" /> : null}
        {CERTAINTY_ORDER.filter((c) => totals.byCertainty[c] > 0).length > 1
          ? CERTAINTY_ORDER.map((c) =>
              totals.byCertainty[c] > 0 ? (
                <SummaryLine key={c} label={INCOME_CERTAINTIES.find((x) => x.value === c)!.label} value={totals.byCertainty[c]} />
              ) : null,
            )
          : null}
      </Card>

      <SectionTitle title="Sources" />
      {rows.map(({ source, year }) => {
        const freq = INCOME_FREQUENCIES.find((f) => f.value === source.frequency)!.label;
        const ended = !year.next && year.toCome === 0;
        return (
          <Card key={source.id} onPress={() => setEditing(source)} style={{ gap: spacing.xs, opacity: ended && year.total === 0 ? 0.6 : 1 }}>
            <View style={ui.rowCenter}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }} numberOfLines={1}>
                  {source.name}
                </Text>
                <Text style={{ color: colors.textSecondary, fontSize: 12 }} numberOfLines={1}>
                  {formatMoney(source.amount)} · {freq}
                </Text>
              </View>
              {source.certainty !== 'certain' ? (
                <Pill
                  label={INCOME_CERTAINTIES.find((c) => c.value === source.certainty)!.label}
                  color={source.certainty === 'likely' ? colors.info : colors.warning}
                />
              ) : null}
            </View>
            <View style={[ui.rowCenter, { justifyContent: 'space-between' }]}>
              <Text style={{ color: colors.textMuted, fontSize: 12 }}>
                {year.next ? `Next ${formatDate(year.next, calendar)}` : 'No more payments'}
              </Text>
              <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                This year {formatMoney(year.total)}
                {year.count > 1 ? ` (${year.count}×)` : ''}
              </Text>
            </View>
          </Card>
        );
      })}
      <Button title="Add income" variant="secondary" icon="add" onPress={() => setEditing('new')} />
      <IncomeSourceSheet source={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function IncomeSourceSheet(props: { source: IncomeSource | 'new' | null; onClose: () => void }) {
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const editing = props.source && props.source !== 'new' ? props.source : null;
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [frequency, setFrequency] = useState<IncomeFrequency>('monthly');
  const [start, setStart] = useState<Date | null>(new Date());
  const [end, setEnd] = useState<Date | null>(null);
  const [certainty, setCertainty] = useState<IncomeCertainty>('certain');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!props.source) return;
    setName(editing?.name ?? '');
    setAmount(amountText(editing?.amount ?? 0));
    setFrequency(editing?.frequency ?? 'monthly');
    setStart(parseDateInput(editing?.startDate ?? '') ?? new Date());
    setEnd(parseDateInput(editing?.endDate ?? ''));
    setCertainty(editing?.certainty ?? 'certain');
    setNote(editing?.note ?? '');
  }, [props.source, editing]);

  const value = parseAmountInput(amount);
  const preview = useMemo(() => {
    if (value === null || value <= 0 || !start) return null;
    return incomeForYear({ amount: value, frequency, start, end: frequency === 'once' ? null : end }, new Date(), calendar);
  }, [value, frequency, start, end, calendar]);

  const save = async () => {
    if (value === null || value <= 0 || !start) {
      showError('Amount needed', new Error('Enter the amount and the date.'));
      return;
    }
    if (end && end.getTime() < start.getTime()) {
      showError('Check the dates', new Error('The end date is before the first payment.'));
      return;
    }
    setBusy(true);
    try {
      const draft = {
        name,
        amount: value,
        frequency,
        startDate: toDateInput(start),
        endDate: end ? toDateInput(end) : null,
        certainty,
        note,
      };
      if (editing) await incomeSourceRepository.update(editing.id, draft);
      else await incomeSourceRepository.create(draft);
      notifyDataChanged();
      props.onClose();
    } catch (error) {
      showError('Could not save income', error);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing || !(await confirm(`Delete ${editing.name}?`, 'It is removed from your expected income.', 'Delete', true))) return;
    await incomeSourceRepository.remove(editing.id);
    notifyDataChanged();
    props.onClose();
  };

  return (
    <Sheet visible={!!props.source} onClose={props.onClose} title={editing ? 'Edit income' : 'Expected income'}>
      <View style={{ gap: spacing.md }}>
        <TextField label="Name" value={name} onChangeText={setName} placeholder="e.g. Salary, Rent from shop" autoCapitalize="sentences" />
        <TextField label="Amount each time (ETB)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0" />
        <View style={{ gap: spacing.xs }}>
          <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600' }}>How often</Text>
          <View style={ui.rowWrap}>
            {INCOME_FREQUENCIES.map((f) => (
              <Chip key={f.value} label={f.label} selected={frequency === f.value} onPress={() => setFrequency(f.value)} />
            ))}
          </View>
          {frequency === 'monthly' && calendar === 'ethiopian' ? (
            <Text style={{ color: colors.textMuted, fontSize: 12 }}>Paid in each of the 12 thirty-day months; Pagume is skipped.</Text>
          ) : null}
        </View>
        <DateField label={frequency === 'once' ? 'Expected on' : 'First payment'} value={start} onChange={setStart} />
        {frequency !== 'once' ? (
          <DateField label="Last payment (optional)" value={end} onChange={setEnd} placeholder="Keeps going" clearable />
        ) : null}
        <View style={{ gap: spacing.xs }}>
          <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600' }}>How sure</Text>
          <View style={ui.rowWrap}>
            {INCOME_CERTAINTIES.map((c) => (
              <Chip key={c.value} label={c.label} selected={certainty === c.value} onPress={() => setCertainty(c.value)} />
            ))}
          </View>
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>"Maybe" income is not counted against planned spending.</Text>
        </View>
        <TextField label="Note (optional)" value={note} onChangeText={setNote} />
        {preview ? (
          <Text style={{ color: colors.textSecondary }}>
            {formatMoney(preview.total)} in {yearLabel(new Date(), calendar)} ({preview.count} payment{preview.count === 1 ? '' : 's'})
            {preview.next ? ` · next ${formatDate(preview.next, calendar)}` : ''}
          </Text>
        ) : null}
        <Button title="Save" onPress={() => void save()} loading={busy} disabled={!name.trim()} />
        {editing ? <Button title="Delete" variant="danger" icon="delete" onPress={() => void remove()} /> : null}
      </View>
    </Sheet>
  );
}

function liquidityColor(liquidity: Liquidity, colors: Colors): string {
  if (liquidity === 'cash' || liquidity === 'days') return colors.income;
  if (liquidity === 'weeks') return colors.info;
  if (liquidity === 'months') return colors.warning;
  return colors.expense;
}

function AssetsView(props: { addRequest: number }) {
  const colors = useTheme();
  const assets = useRows(assetRepository.getAll);
  const [editing, setEditing] = useState<Asset | 'new' | null>(null);

  useAddRequest(props.addRequest, () => setEditing('new'));

  const summary = useMemo(() => summarizeAssets(assets ?? []), [assets]);

  if (assets === null) return <Text style={{ color: colors.textSecondary }}>Loading…</Text>;
  return (
    <>
      {assets.length === 0 ? (
        <EmptyState
          icon="account-balance"
          title="No assets"
          message="Add things you own that are worth money (gold, a car, equipment, money someone holds for you) and how quickly they could be sold."
          action={{ label: 'Add asset', onPress: () => setEditing('new') }}
        />
      ) : (
        <>
          <Card style={{ gap: spacing.sm }}>
            <View style={{ gap: 2 }}>
              <Text style={{ color: colors.textMuted, fontSize: 12 }}>Estimated worth</Text>
              <AmountText value={summary.worth} style={{ fontSize: 22, fontWeight: '700' }} />
            </View>
            <SummaryLine label="If you had to sell soon" value={summary.quickSale} bold hint="Worth after a discount for selling quickly" />
            <SummaryLine label="Within about a week" value={summary.withinWeek} color={colors.income} hint="Cash and things that sell in days" />
          </Card>
          <SectionTitle title="Assets" />
          <Card>
            {assets.map((asset) => {
              const meta = LIQUIDITY_OPTIONS.find((l) => l.value === asset.liquidity)!;
              return (
                <ListRow
                  key={asset.id}
                  icon="account-balance"
                  iconColor={liquidityColor(asset.liquidity, colors)}
                  title={asset.name}
                  subtitle={`Sells in: ${meta.label.toLowerCase()} · quick sale ${formatMoney(quickSaleValue(asset.value, asset.liquidity))}`}
                  value={formatMoney(asset.value)}
                  onPress={() => setEditing(asset)}
                />
              );
            })}
          </Card>
          <Button title="Add asset" variant="secondary" icon="add" onPress={() => setEditing('new')} />
        </>
      )}
      <AssetSheet asset={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function AssetSheet(props: { asset: Asset | 'new' | null; onClose: () => void }) {
  const colors = useTheme();
  const editing = props.asset && props.asset !== 'new' ? props.asset : null;
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [liquidity, setLiquidity] = useState<Liquidity>('weeks');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!props.asset) return;
    setName(editing?.name ?? '');
    setValue(amountText(editing?.value ?? 0));
    setLiquidity(editing?.liquidity ?? 'weeks');
    setNote(editing?.note ?? '');
  }, [props.asset, editing]);

  const parsed = parseAmountInput(value);

  const save = async () => {
    if (parsed === null || parsed < 0) {
      showError('Value needed', new Error('Enter about how much it is worth.'));
      return;
    }
    setBusy(true);
    try {
      const draft = { name, value: parsed, liquidity, note };
      if (editing) await assetRepository.update(editing.id, draft);
      else await assetRepository.create(draft);
      notifyDataChanged();
      props.onClose();
    } catch (error) {
      showError('Could not save asset', error);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing || !(await confirm(`Delete ${editing.name}?`, 'It is removed from your assets.', 'Delete', true))) return;
    await assetRepository.remove(editing.id);
    notifyDataChanged();
    props.onClose();
  };

  const meta = LIQUIDITY_OPTIONS.find((l) => l.value === liquidity)!;
  return (
    <Sheet visible={!!props.asset} onClose={props.onClose} title={editing ? 'Edit asset' : 'Add asset'}>
      <View style={{ gap: spacing.md }}>
        <TextField label="Name" value={name} onChangeText={setName} placeholder="e.g. Gold necklace, Car" autoCapitalize="sentences" />
        <TextField label="Estimated worth (ETB)" value={value} onChangeText={setValue} keyboardType="decimal-pad" placeholder="0" />
        <View style={{ gap: spacing.xs }}>
          <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600' }}>How fast could you turn it into money?</Text>
          <View style={ui.rowWrap}>
            {LIQUIDITY_OPTIONS.map((l) => (
              <Chip
                key={l.value}
                label={l.label}
                selected={liquidity === l.value}
                color={liquidityColor(l.value, colors)}
                onPress={() => setLiquidity(l.value)}
              />
            ))}
          </View>
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>
            {meta.hint}. A quick sale is counted at {Math.round(LIQUIDITY_FACTOR[liquidity] * 100)}% of the worth
            {parsed && parsed > 0 ? ` (${formatMoney(quickSaleValue(parsed, liquidity))})` : ''}.
          </Text>
        </View>
        <TextField label="Note (optional)" value={note} onChangeText={setNote} />
        <Button title="Save" onPress={() => void save()} loading={busy} disabled={!name.trim()} />
        {editing ? <Button title="Delete" variant="danger" icon="delete" onPress={() => void remove()} /> : null}
      </View>
    </Sheet>
  );
}

const STRAIN_LABELS: Record<Strain, string> = { 1: 'Easy', 2: 'Light', 3: 'Moderate', 4: 'Hard', 5: 'Draining' };
const CHANCE_PRESETS = [10, 25, 50, 75, 90, 100];

const VERDICT_META: Record<OpportunityVerdict, { label: string; tone: 'income' | 'info' | 'warning' | 'expense' }> = {
  great: { label: 'Great', tone: 'income' },
  good: { label: 'Worth it', tone: 'info' },
  fair: { label: 'Fair', tone: 'warning' },
  poor: { label: 'Poor', tone: 'expense' },
};

function OpportunitiesView(props: { addRequest: number }) {
  const colors = useTheme();
  const calendar = useSettings((s) => s.calendar);
  const opportunities = useRows(opportunityRepository.getAll);
  const sources = useRows(incomeSourceRepository.getAll);
  const [editing, setEditing] = useState<MoneyOpportunity | 'new' | null>(null);
  const [explain, setExplain] = useState(false);

  useAddRequest(props.addRequest, () => setEditing('new'));

  const yearlyIncome = useMemo(
    () =>
      (sources ?? [])
        .filter((s) => s.certainty !== 'uncertain' && s.frequency !== 'once')
        .reduce((sum, s) => sum + monthlyEquivalent(s) * 12, 0),
    [sources],
  );
  const active = useMemo(() => (opportunities ?? []).filter((o) => !o.done), [opportunities]);
  const benchmark = useMemo(() => benchmarkHourlyRate(yearlyIncome, active), [yearlyIncome, active]);
  const scored = useMemo(
    () => active.map((o) => ({ o, score: scoreOpportunity(o, benchmark) })).sort((a, b) => b.score.perEffortHour - a.score.perEffortHour),
    [active, benchmark],
  );
  const done = (opportunities ?? []).filter((o) => o.done);

  if (opportunities === null) return <Text style={{ color: colors.textSecondary }}>Loading…</Text>;
  return (
    <>
      <Card style={{ gap: spacing.sm }}>
        <View style={[ui.rowCenter, { justifyContent: 'space-between' }]}>
          <Text style={{ color: colors.text, fontWeight: '700', flex: 1 }}>Effort vs reward</Text>
          <Button title={explain ? 'Hide' : 'How it works'} compact variant="ghost" onPress={() => setExplain((v) => !v)} />
        </View>
        <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
          Ranked by expected money per effort-hour.
          {benchmark
            ? ` Your yardstick is ${formatMoney(benchmark)} an hour${yearlyIncome > 0 ? ' (your regular income over 2,080 working hours a year)' : ' (the middle of your ideas, until you add regular income)'}.`
            : ''}
        </Text>
        {explain ? (
          <View style={{ gap: spacing.xs }}>
            <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
              • <Text style={{ fontWeight: '700' }}>Expected money</Text> = reward × chance it works out. 10,000 ETB at a 50% chance is
              worth 5,000 ETB.
            </Text>
            <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
              • <Text style={{ fontWeight: '700' }}>Effort</Text> is measured in hours (all of them: travel, preparing, waiting, follow-up),
              then weighted by how hard those hours are: Easy ×1, Light ×1.25, Moderate ×1.5, Hard ×1.75, Draining ×2. Ten draining hours
              count as twenty easy ones.
            </Text>
            <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
              • <Text style={{ fontWeight: '700' }}>Score</Text> = expected money ÷ effort-hours. Compared with what an ordinary hour of
              yours earns: twice as good or more is Great, at least as good is Worth it, half as good is Fair, below that is Poor.
            </Text>
            <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
              • <Text style={{ fontWeight: '700' }}>Quick win</Text>: a day's work or less with a 70%+ chance. Good to do first.
            </Text>
          </View>
        ) : null}
      </Card>

      {scored.length === 0 ? (
        <EmptyState
          icon="trending-up"
          title="No ideas yet"
          message="Add ways you could make money: selling something, extra work, a side job. Each gets a reward, the hours it takes, how hard it is and the chance it works."
          action={{ label: 'Add an idea', onPress: () => setEditing('new') }}
        />
      ) : (
        <>
          {scored.map(({ o, score }) => (
            <OpportunityCard key={o.id} opportunity={o} score={score} onPress={() => setEditing(o)} />
          ))}
          <Button title="Add an idea" variant="secondary" icon="add" onPress={() => setEditing('new')} />
        </>
      )}

      {done.length > 0 ? (
        <>
          <SectionTitle title={`Done (${done.length})`} />
          <Card>
            {done.map((o) => (
              <ListRow
                key={o.id}
                icon="check-circle"
                iconColor={colors.income}
                title={o.name}
                subtitle={o.updatedAt ? formatDate(new Date(o.updatedAt), calendar) : null}
                value={formatMoney(o.reward)}
                onPress={() => setEditing(o)}
              />
            ))}
          </Card>
        </>
      ) : null}
      <OpportunitySheet opportunity={editing} benchmark={benchmark} onClose={() => setEditing(null)} />
    </>
  );
}

function OpportunityCard(props: { opportunity: MoneyOpportunity; score: OpportunityScore; onPress: () => void }) {
  const colors = useTheme();
  const { opportunity: o, score } = props;
  const verdict = score.verdict ? VERDICT_META[score.verdict] : null;
  return (
    <Card onPress={props.onPress} style={{ gap: spacing.xs }}>
      <View style={ui.rowCenter}>
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', flex: 1 }} numberOfLines={1}>
          {o.name}
        </Text>
        <View style={[ui.rowCenter, { gap: spacing.xs }]}>
          {score.quickWin ? <Pill label="Quick win" color={colors.primary} /> : null}
          {verdict ? <Pill label={verdict.label} color={colors[verdict.tone]} /> : null}
        </View>
      </View>
      <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
        {formatMoney(o.reward)} at {formatNumber(o.chance, 0)}% · {formatNumber(o.hours, o.hours % 1 ? 1 : 0)} h ·{' '}
        {STRAIN_LABELS[o.strain]}
      </Text>
      <View style={[ui.rowCenter, { justifyContent: 'space-between' }]}>
        <Text style={{ color: colors.textMuted, fontSize: 12 }}>Expected {formatMoney(score.expected)}</Text>
        <View style={[ui.rowCenter, { gap: 4 }]}>
          <Icon name="speed" size={16} color={colors.textSecondary} />
          <Text style={{ color: colors.text, fontWeight: '700' }}>{formatMoney(score.perEffortHour)}/h</Text>
        </View>
      </View>
    </Card>
  );
}

function OpportunitySheet(props: { opportunity: MoneyOpportunity | 'new' | null; benchmark: number | null; onClose: () => void }) {
  const colors = useTheme();
  const editing = props.opportunity && props.opportunity !== 'new' ? props.opportunity : null;
  const [name, setName] = useState('');
  const [reward, setReward] = useState('');
  const [hours, setHours] = useState('');
  const [strain, setStrain] = useState<Strain>(3);
  const [chance, setChance] = useState('50');
  const [note, setNote] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!props.opportunity) return;
    setName(editing?.name ?? '');
    setReward(amountText(editing?.reward ?? 0));
    setHours(editing ? String(editing.hours) : '');
    setStrain(editing?.strain ?? 3);
    setChance(String(editing?.chance ?? 50));
    setNote(editing?.note ?? '');
    setDone(editing?.done ?? false);
  }, [props.opportunity, editing]);

  const rewardValue = parseAmountInput(reward);
  const hoursValue = parseAmountInput(hours);
  const chanceValue = parseAmountInput(chance);
  const valid =
    !!name.trim() &&
    rewardValue !== null &&
    rewardValue >= 0 &&
    hoursValue !== null &&
    hoursValue > 0 &&
    chanceValue !== null &&
    chanceValue >= 0 &&
    chanceValue <= 100;
  const preview = valid
    ? scoreOpportunity({ reward: rewardValue!, hours: hoursValue!, strain, chance: chanceValue! }, props.benchmark)
    : null;

  const save = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      const draft = { name, reward: rewardValue!, hours: hoursValue!, strain, chance: chanceValue!, note, done };
      if (editing) await opportunityRepository.update(editing.id, draft);
      else await opportunityRepository.create(draft);
      notifyDataChanged();
      props.onClose();
    } catch (error) {
      showError('Could not save', error);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing || !(await confirm(`Delete ${editing.name}?`, 'It is removed from your ideas.', 'Delete', true))) return;
    await opportunityRepository.remove(editing.id);
    notifyDataChanged();
    props.onClose();
  };

  return (
    <Sheet visible={!!props.opportunity} onClose={props.onClose} title={editing ? 'Edit idea' : 'A way to make money'}>
      <View style={{ gap: spacing.md }}>
        <TextField label="Idea" value={name} onChangeText={setName} placeholder="e.g. Sell old laptop, weekend tutoring" autoCapitalize="sentences" />
        <TextField label="Reward if it works (ETB)" value={reward} onChangeText={setReward} keyboardType="decimal-pad" placeholder="0" />
        <TextField
          label="Hours it takes, all in"
          value={hours}
          onChangeText={setHours}
          keyboardType="decimal-pad"
          placeholder="e.g. 6"
        />
        <View style={{ gap: spacing.xs }}>
          <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600' }}>How hard are those hours?</Text>
          <View style={ui.rowWrap}>
            {([1, 2, 3, 4, 5] as Strain[]).map((s) => (
              <Chip key={s} label={STRAIN_LABELS[s]} selected={strain === s} onPress={() => setStrain(s)} />
            ))}
          </View>
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>
            Each hour counts as {strainMultiplier(strain)} effort-hours. Think about stress, physical effort, risk and what you give up.
          </Text>
        </View>
        <View style={{ gap: spacing.xs }}>
          <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600' }}>Chance it pays off (%)</Text>
          <View style={ui.rowWrap}>
            {CHANCE_PRESETS.map((c) => (
              <Chip key={c} label={`${c}%`} selected={chanceValue === c} onPress={() => setChance(String(c))} />
            ))}
          </View>
          <TextField value={chance} onChangeText={setChance} keyboardType="decimal-pad" placeholder="50" />
        </View>
        <TextField label="Note (optional)" value={note} onChangeText={setNote} />
        {editing ? <ToggleRow title="Done" icon="check-circle" value={done} onValueChange={setDone} /> : null}
        {preview ? (
          <Card style={{ gap: 2 }}>
            <Text style={{ color: colors.textSecondary }}>
              Expected {formatMoney(preview.expected)} for {formatNumber(preview.effortHours, 1)} effort-hours
            </Text>
            <Text style={{ color: colors.text, fontWeight: '700' }}>
              {formatMoney(preview.perEffortHour)} per effort-hour
              {preview.verdict ? ` · ${VERDICT_META[preview.verdict].label}` : ''}
            </Text>
          </Card>
        ) : null}
        <Button title="Save" onPress={() => void save()} loading={busy} disabled={!valid} />
        {editing ? <Button title="Delete" variant="danger" icon="delete" onPress={() => void remove()} /> : null}
      </View>
    </Sheet>
  );
}
