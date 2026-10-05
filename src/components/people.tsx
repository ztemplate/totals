import React, { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import type { PeopleGroup } from '../models/peopleGroup';
import { PERSON_TYPES, personTypeMeta, type Person, type PersonType } from '../models/person';
import { isCredit, type Transaction } from '../models/transaction';
import { bankById } from '../repositories/bankRepository';
import { peopleGroupRepository } from '../repositories/peopleGroupRepository';
import { peopleRepository } from '../repositories/peopleRepository';
import { notifyDataChanged, useData } from '../store/dataStore';
import { useTheme } from '../store/settingsStore';
import { spacing } from '../theme/colors';
import { initials, titleCase } from '../utils/format';
import { counterpartyRaw, normalizePersonName, type PeopleIndex } from '../utils/personMatching';
import { confirm, showError } from './dialogs';
import { Button, Chip, Divider, Icon, ListRow, Sheet, TextField, ToggleRow, styles as ui } from './ui';

/** Initials for friends and family; the type's icon for shops, restaurants and other places. */
export function PersonAvatar(props: { name: string; size?: number; type?: PersonType | null }) {
  const colors = useTheme();
  const size = props.size ?? 40;
  const type = props.type ?? 'friend';
  const showIcon = type !== 'friend' && type !== 'family';
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
      {showIcon ? (
        <Icon name={personTypeMeta(type).icon} size={size * 0.5} color={colors.primary} />
      ) : (
        <Text style={{ color: colors.primary, fontWeight: '700', fontSize: size * 0.38 }}>{initials(props.name)}</Text>
      )}
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
  const [type, setType] = useState<PersonType>('friend');
  const [telegram, setTelegram] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!props.visible) return;
    setName(props.person?.name ?? props.initialName ?? '');
    setPhone(props.person?.phone ?? '');
    setNote(props.person?.note ?? '');
    setType(props.person?.type ?? 'friend');
    setTelegram(props.person?.telegram ?? '');
    setEmail(props.person?.email ?? '');
    setAddress(props.person?.address ?? '');
  }, [props.visible, props.person, props.initialName]);

  const save = async () => {
    setSaving(true);
    try {
      let id: number;
      if (props.person) {
        await peopleRepository.updatePerson(props.person.id, { name, phone, note, type, telegram, email, address });
        id = props.person.id;
      } else {
        id = await peopleRepository.createPerson({ name, phone, note, type, telegram, email, address });
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
        <TextField label="Name" value={name} onChangeText={setName} placeholder="Full name or place" autoCapitalize="words" />
        <View style={ui.rowWrap}>
          {PERSON_TYPES.map((t) => (
            <Chip key={t.value} label={t.label} icon={t.icon} selected={type === t.value} onPress={() => setType(t.value)} />
          ))}
        </View>
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
        <TextField
          label="Telegram (optional)"
          value={telegram}
          onChangeText={setTelegram}
          placeholder="@username"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TextField
          label="Email (optional)"
          value={email}
          onChangeText={setEmail}
          placeholder="name@example.com"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TextField label="Address (optional)" value={address} onChangeText={setAddress} placeholder="City, area, building…" />
        <TextField label="Note (optional)" value={note} onChangeText={setNote} multiline />
        {props.person ? null : (
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>
            More phone numbers and bank account numbers can be added on their page under Details.
          </Text>
        )}
        <Button title={props.person ? 'Save' : 'Add person'} onPress={() => void save()} loading={saving} />
      </View>
    </Sheet>
  );
}

/**
 * Inline people search with one-tap creation, for use inside sheets where another modal would stack awkwardly.
 * With allowMe, "Me" (null) is the first choice; with multi, several people can be toggled.
 */
export function PersonChooser(props: {
  people: Person[];
  selectedId?: number | null;
  multi?: ReadonlySet<number>;
  allowMe?: boolean;
  onSelect: (id: number | null) => void;
  onCreatePerson?: (name: string) => Promise<number | null>;
}) {
  const colors = useTheme();
  const [query, setQuery] = useState('');
  const key = normalizePersonName(query);
  const isSelected = (id: number) => (props.multi ? props.multi.has(id) : props.selectedId === id);
  const matches = props.people
    .filter((p) => !key || normalizePersonName(p.name).includes(key) || (p.phone ?? '').includes(query.trim()))
    .sort((a, b) => Number(isSelected(b.id)) - Number(isSelected(a.id)))
    .slice(0, key ? 20 : 12);
  const exact = props.people.some((p) => normalizePersonName(p.name) === key);
  const create = props.onCreatePerson;
  return (
    <View style={{ gap: spacing.sm }}>
      <TextField value={query} onChangeText={setQuery} placeholder={create ? 'Search or add a person' : 'Search people'} autoCapitalize="words" />
      <View style={ui.rowWrap}>
        {props.allowMe && !key ? (
          <Chip label="Me" icon="person-outline" selected={props.selectedId == null} onPress={() => props.onSelect(null)} />
        ) : null}
        {matches.map((p) => (
          <Chip key={p.id} label={p.name} icon="person" selected={isSelected(p.id)} onPress={() => props.onSelect(p.id)} />
        ))}
        {create && key && !exact ? (
          <Chip
            label={`Add "${query.trim()}"`}
            icon="person-add-alt"
            onPress={() => {
              void create(query.trim()).then((id) => {
                if (id == null) return;
                props.onSelect(id);
                setQuery('');
              });
            }}
          />
        ) : null}
      </View>
      {props.people.length === 0 && !key ? (
        <Text style={{ color: colors.textMuted, fontSize: 12 }}>
          {create ? 'No people yet. Type a name to add one.' : 'No people yet.'}
        </Text>
      ) : null}
    </View>
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
              left={<PersonAvatar name={p.name} type={p.type} size={36} />}
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

/** Create or edit a group of people, used to fill a bill split in one tap. */
export function GroupFormSheet(props: {
  visible: boolean;
  onClose: () => void;
  people: Person[];
  group?: PeopleGroup | null;
  onSaved?: () => void;
}) {
  const colors = useTheme();
  const [name, setName] = useState('');
  const [members, setMembers] = useState<Set<number>>(new Set());
  const [people, setPeople] = useState<Person[]>(props.people);
  const [saving, setSaving] = useState(false);
  const editing = props.group ?? null;

  useEffect(() => {
    if (!props.visible) return;
    setName(editing?.name ?? '');
    setMembers(new Set(editing?.memberIds ?? []));
    setPeople(props.people);
  }, [props.visible, editing, props.people]);

  const toggle = (id: number | null) => {
    if (id == null) return;
    setMembers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const createPerson = async (personName: string): Promise<number | null> => {
    try {
      const id = await peopleRepository.createPerson({ name: personName });
      setPeople(await peopleRepository.getPeople());
      notifyDataChanged();
      return id;
    } catch (error) {
      showError('Could not add person', error);
      return null;
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      if (editing) await peopleGroupRepository.updateGroup(editing.id, name, [...members]);
      else await peopleGroupRepository.createGroup(name, [...members]);
      notifyDataChanged();
      props.onSaved?.();
      props.onClose();
    } catch (error) {
      showError('Could not save group', error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!editing) return;
    const ok = await confirm(`Delete ${editing.name}?`, 'The people in it are kept.', 'Delete', true);
    if (!ok) return;
    try {
      await peopleGroupRepository.deleteGroup(editing.id);
      notifyDataChanged();
      props.onSaved?.();
      props.onClose();
    } catch (error) {
      showError('Could not delete group', error);
    }
  };

  const selected = people.filter((p) => members.has(p.id));
  return (
    <Sheet visible={props.visible} onClose={props.onClose} title={editing ? 'Edit group' : 'New group'}>
      <View style={{ gap: spacing.md }}>
        <TextField label="Name" value={name} onChangeText={setName} placeholder="e.g. Flatmates" autoCapitalize="words" />
        <Text style={{ color: colors.textSecondary, fontWeight: '600' }}>
          Members{selected.length > 0 ? ` (${selected.length})` : ''}
        </Text>
        {selected.length > 0 ? (
          <View style={ui.rowWrap}>
            {selected.map((p) => (
              <Chip key={p.id} label={p.name} icon="close" selected onPress={() => toggle(p.id)} />
            ))}
          </View>
        ) : (
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>Tap people below to add them. When splitting with the group you can include yourself or not.</Text>
        )}
        <PersonChooser people={people} multi={members} onSelect={toggle} onCreatePerson={createPerson} />
        <Button title="Save group" icon="check" onPress={() => void save()} loading={saving} disabled={!name.trim()} />
        {editing ? <Button title="Delete group" variant="ghost" icon="delete-outline" onPress={() => void remove()} /> : null}
      </View>
    </Sheet>
  );
}
