import React, { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import type { Person } from '../models/person';
import { isCredit, type Transaction } from '../models/transaction';
import { bankById } from '../repositories/bankRepository';
import { peopleRepository } from '../repositories/peopleRepository';
import { notifyDataChanged, useData } from '../store/dataStore';
import { useTheme } from '../store/settingsStore';
import { spacing } from '../theme/colors';
import { initials, titleCase } from '../utils/format';
import { counterpartyRaw, normalizePersonName, type PeopleIndex } from '../utils/personMatching';
import { showError } from './dialogs';
import { Button, Divider, Icon, ListRow, Sheet, TextField, ToggleRow } from './ui';

export function PersonAvatar(props: { name: string; size?: number }) {
  const colors = useTheme();
  const size = props.size ?? 40;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colors.primarySoft,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: colors.primary, fontWeight: '700', fontSize: size * 0.38 }}>{initials(props.name)}</Text>
    </View>
  );
}

/** Creates or edits a person. A new person can also get a bank-scoped name alias (e.g. from a suggestion). */
export function PersonFormSheet(props: {
  visible: boolean;
  onClose: () => void;
  person?: Person | null;
  initialName?: string;
  aliasSeed?: { name: string; bankId: number | null } | null;
  onSaved?: (personId: number) => void;
}) {
  const colors = useTheme();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!props.visible) return;
    setName(props.person?.name ?? props.initialName ?? '');
    setPhone(props.person?.phone ?? '');
    setNote(props.person?.note ?? '');
  }, [props.visible, props.person, props.initialName]);

  const save = async () => {
    setSaving(true);
    try {
      let id: number;
      if (props.person) {
        await peopleRepository.updatePerson(props.person.id, { name, phone, note });
        id = props.person.id;
      } else {
        id = await peopleRepository.createPerson({ name, phone, note });
        const seed = props.aliasSeed;
        if (seed && normalizePersonName(seed.name)) {
          await peopleRepository.addAccount({ personId: id, bankId: seed.bankId, identifier: seed.name, kind: 'name' });
        }
      }
      notifyDataChanged();
      props.onSaved?.(id);
    } catch (error) {
      showError('Could not save person', error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet visible={props.visible} onClose={props.onClose} title={props.person ? 'Edit person' : 'New person'}>
      <View style={{ gap: spacing.md }}>
        <TextField label="Name" value={name} onChangeText={setName} placeholder="Full name" autoCapitalize="words" />
        <TextField
          label="Phone (optional)"
          value={phone}
          onChangeText={setPhone}
          placeholder="09…"
          keyboardType="phone-pad"
        />
        <Text style={{ color: colors.textMuted, fontSize: 12 }}>
          The phone number is also used to match telebirr and bank messages that show it.
        </Text>
        <TextField label="Note (optional)" value={note} onChangeText={setNote} multiline />
        <Button title={props.person ? 'Save' : 'Add person'} onPress={() => void save()} loading={saving} />
      </View>
    </Sheet>
  );
}

function sharedTokens(a: string, b: Set<string>): number {
  return a.split(' ').filter((t) => t.length >= 2 && b.has(t)).length;
}

/** Assigns one transaction to a person, optionally remembering the counterparty name for that bank. */
export function PersonPickerSheet(props: {
  visible: boolean;
  onClose: () => void;
  tx: Transaction;
  index: PeopleIndex | null;
  currentPersonId: number | null;
  onOpenPerson?: (personId: number) => void;
}) {
  const colors = useTheme();
  const banksWithCash = useData((s) => s.banksWithCash);
  const [query, setQuery] = useState('');
  const [remember, setRemember] = useState(true);
  const [saving, setSaving] = useState(false);
  const counterparty = counterpartyRaw(props.tx);
  const hasCounterparty = !!normalizePersonName(counterparty);
  const bank = bankById(banksWithCash, props.tx.bankId);

  useEffect(() => {
    if (!props.visible) return;
    setQuery('');
    setRemember(true);
  }, [props.visible]);

  const people = useMemo(() => {
    const all = props.index?.people ?? [];
    const key = normalizePersonName(query);
    if (key) return all.filter((p) => normalizePersonName(p.name).includes(key) || (p.phone ?? '').includes(query.trim()));
    // People whose name looks like the counterparty first.
    const tokens = new Set(normalizePersonName(counterparty).split(' '));
    return [...all].sort((a, b) => sharedTokens(normalizePersonName(b.name), tokens) - sharedTokens(normalizePersonName(a.name), tokens));
  }, [props.index, query, counterparty]);
  const exact = people.some((p) => normalizePersonName(p.name) === normalizePersonName(query));

  const run = async (work: () => Promise<void>) => {
    if (saving) return;
    setSaving(true);
    try {
      await work();
      notifyDataChanged();
      props.onClose();
    } catch (error) {
      showError('Could not link person', error);
    } finally {
      setSaving(false);
    }
  };

  const assign = async (personId: number) => {
    if (remember && hasCounterparty) {
      await peopleRepository.addAccount({ personId, bankId: props.tx.bankId ?? null, identifier: counterparty, kind: 'name' });
    }
    await peopleRepository.setTransactionPerson(props.tx.reference, personId);
  };

  return (
    <Sheet visible={props.visible} onClose={props.onClose} title="Who is this?">
      <View style={{ gap: spacing.md }}>
        {hasCounterparty ? (
          <Text style={{ color: colors.textSecondary }}>
            {isCredit(props.tx) ? 'From' : 'To'} {titleCase(counterparty)}
            {bank ? ` · ${bank.shortName}` : ''}
          </Text>
        ) : null}
        <TextField value={query} onChangeText={setQuery} placeholder="Search or add a person" autoCapitalize="words" />
        {hasCounterparty ? (
          <ToggleRow
            title="Remember this name"
            subtitle={`Future ${bank?.shortName ?? ''} transactions with "${titleCase(counterparty)}" go to the same person`}
            value={remember}
            onValueChange={setRemember}
          />
        ) : null}
        <View>
          {query.trim() && !exact ? (
            <ListRow
              icon="person-add"
              title={`Add "${query.trim()}"`}
              subtitle="Create a new person"
              disabled={saving}
              onPress={() =>
                void run(async () => {
                  const id = await peopleRepository.createPerson({ name: query });
                  await assign(id);
                })
              }
            />
          ) : null}
          {people.map((p) => (
            <ListRow
              key={p.id}
              left={<PersonAvatar name={p.name} size={36} />}
              title={p.name}
              subtitle={p.phone ?? null}
              disabled={saving}
              right={p.id === props.currentPersonId ? <Icon name="check" color={colors.primary} /> : undefined}
              onPress={() => void run(() => assign(p.id))}
            />
          ))}
          {people.length === 0 && !query.trim() ? (
            <Text style={{ color: colors.textMuted }}>No people yet. Type a name to add one.</Text>
          ) : null}
        </View>
        <Divider />
        {props.currentPersonId !== null && props.onOpenPerson ? (
          <ListRow
            icon="person"
            title={`Open ${props.index?.byId.get(props.currentPersonId)?.name ?? 'person'}`}
            subtitle="See everything with them"
            chevron
            onPress={() => props.onOpenPerson?.(props.currentPersonId!)}
          />
        ) : null}
        <ListRow
          icon="auto-fix-high"
          title="Match automatically"
          subtitle="Use the names and numbers saved for people"
          disabled={saving}
          onPress={() => void run(() => peopleRepository.clearTransactionLink(props.tx.reference))}
        />
        <ListRow
          icon="person-off"
          title="Not linked to anyone"
          subtitle="Keep this transaction out of People"
          disabled={saving}
          onPress={() => void run(() => peopleRepository.setTransactionPerson(props.tx.reference, null))}
        />
      </View>
    </Sheet>
  );
}
