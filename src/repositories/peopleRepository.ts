import { getDb } from '../db/database';
import {
  personAccountFromDb,
  personFromDb,
  personTransactionLinkFromDb,
  type Person,
  type PersonAccount,
  type PersonAccountKind,
  type PersonTransactionLink,
  type PersonType,
} from '../models/person';
import { buildPeopleIndex, normalizePersonIdentifier, type PeopleIndex } from '../utils/personMatching';
import { profileRepository } from './profileRepository';

function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

export interface PersonInput {
  name: string;
  phone?: string | null;
  note?: string | null;
  type?: PersonType | null;
  telegram?: string | null;
  email?: string | null;
  address?: string | null;
}

function cleanTelegram(value: string | null | undefined): string | null {
  const handle = (value ?? '').trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');
  return handle ? handle : null;
}

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed ? trimmed : null;
}

export const peopleRepository = {
  /** People of the active profile, plus any that are not tied to a profile. */
  async getPeople(): Promise<Person[]> {
    const db = await getDb();
    const profileId = await profileRepository.getActiveProfileId();
    const rows =
      profileId !== null
        ? await db.getAllAsync<Record<string, unknown>>(
            'SELECT * FROM people WHERE profileId = ? OR profileId IS NULL ORDER BY name COLLATE NOCASE',
            [profileId],
          )
        : await db.getAllAsync<Record<string, unknown>>('SELECT * FROM people ORDER BY name COLLATE NOCASE');
    return rows.map(personFromDb);
  },

  async getAllPeople(): Promise<Person[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM people ORDER BY id');
    return rows.map(personFromDb);
  },

  async getPerson(id: number): Promise<Person | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<Record<string, unknown>>('SELECT * FROM people WHERE id = ? LIMIT 1', [id]);
    return row ? personFromDb(row) : null;
  },

  async createPerson(input: PersonInput): Promise<number> {
    const name = cleanName(input.name);
    if (!name) throw new Error('Enter a name.');
    const db = await getDb();
    const profileId = await profileRepository.getActiveProfileId();
    const now = new Date().toISOString();
    const result = await db.runAsync(
      `INSERT INTO people (name, phone, note, type, telegram, email, address, profileId, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        emptyToNull(input.phone),
        emptyToNull(input.note),
        input.type ?? 'friend',
        cleanTelegram(input.telegram),
        emptyToNull(input.email),
        emptyToNull(input.address),
        profileId,
        now,
        now,
      ],
    );
    const id = Number(result.lastInsertRowId);
    const phone = emptyToNull(input.phone);
    if (phone) await peopleRepository.addAccount({ personId: id, bankId: null, identifier: phone, kind: 'phone' });
    return id;
  },

  async updatePerson(id: number, input: PersonInput): Promise<void> {
    const name = cleanName(input.name);
    if (!name) throw new Error('Enter a name.');
    const db = await getDb();
    const previous = await peopleRepository.getPerson(id);
    const oldPhone = normalizePersonIdentifier(previous?.phone, 'phone');
    if (oldPhone && oldPhone !== normalizePersonIdentifier(input.phone, 'phone')) {
      // The old number was added automatically from the phone field, so it goes with it.
      await db.runAsync(
        "DELETE FROM person_accounts WHERE personId = ? AND kind = 'phone' AND bankId IS NULL AND normalizedIdentifier = ?",
        [id, oldPhone],
      );
    }
    await db.runAsync(
      'UPDATE people SET name = ?, phone = ?, note = ?, type = ?, telegram = ?, email = ?, address = ?, updatedAt = ? WHERE id = ?',
      [
        name,
        emptyToNull(input.phone),
        emptyToNull(input.note),
        input.type ?? previous?.type ?? 'friend',
        input.telegram === undefined ? previous?.telegram ?? null : cleanTelegram(input.telegram),
        input.email === undefined ? previous?.email ?? null : emptyToNull(input.email),
        input.address === undefined ? previous?.address ?? null : emptyToNull(input.address),
        new Date().toISOString(),
        id,
      ],
    );
    const phone = emptyToNull(input.phone);
    if (phone) await peopleRepository.addAccount({ personId: id, bankId: null, identifier: phone, kind: 'phone' });
  },

  /** Deletes the person with their aliases, manual links and group memberships. Loans keep their free-text name. */
  async deletePerson(id: number): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM person_accounts WHERE personId = ?', [id]);
      await db.runAsync('DELETE FROM person_transaction_links WHERE personId = ?', [id]);
      await db.runAsync('DELETE FROM people_group_members WHERE personId = ?', [id]);
      await db.runAsync('DELETE FROM people WHERE id = ?', [id]);
    });
  },

  async getAccounts(personId?: number): Promise<PersonAccount[]> {
    const db = await getDb();
    const rows =
      personId === undefined
        ? await db.getAllAsync<Record<string, unknown>>('SELECT * FROM person_accounts ORDER BY id')
        : await db.getAllAsync<Record<string, unknown>>('SELECT * FROM person_accounts WHERE personId = ? ORDER BY id', [
            personId,
          ]);
    return rows.map(personAccountFromDb);
  },

  /**
   * Adds a name/account/phone alias. An identical alias (same bank, kind and value) is moved to this person
   * instead of duplicated, so one bank counterparty never maps to two people.
   */
  async addAccount(input: {
    personId: number;
    bankId: number | null;
    identifier: string;
    kind: PersonAccountKind;
  }): Promise<void> {
    const identifier = input.identifier.trim();
    const normalized = normalizePersonIdentifier(identifier, input.kind);
    if (!normalized) throw new Error(input.kind === 'name' ? 'Enter a name.' : 'Enter a number.');
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      await db.runAsync(
        `DELETE FROM person_accounts
         WHERE kind = ? AND normalizedIdentifier = ? AND COALESCE(bankId, -1) = COALESCE(?, -1)`,
        [input.kind, normalized, input.bankId],
      );
      await db.runAsync(
        'INSERT INTO person_accounts (personId, bankId, identifier, normalizedIdentifier, kind, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
        [input.personId, input.bankId, identifier, normalized, input.kind, new Date().toISOString()],
      );
    });
  },

  async removeAccount(id: number): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM person_accounts WHERE id = ?', [id]);
  },

  async getLinks(): Promise<PersonTransactionLink[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM person_transaction_links');
    return rows.map(personTransactionLinkFromDb);
  },

  /** Pins a transaction to a person, or to nobody when personId is null. */
  async setTransactionPerson(reference: string, personId: number | null): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      'INSERT OR REPLACE INTO person_transaction_links (transactionReference, personId, createdAt) VALUES (?, ?, ?)',
      [reference, personId, new Date().toISOString()],
    );
  },

  /** Removes the manual pin so automatic matching applies again. */
  async clearTransactionLink(reference: string): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM person_transaction_links WHERE transactionReference = ?', [reference]);
  },

  async loadIndex(): Promise<PeopleIndex> {
    const [people, accounts, links] = await Promise.all([
      peopleRepository.getPeople(),
      peopleRepository.getAccounts(),
      peopleRepository.getLinks(),
    ]);
    return buildPeopleIndex(people, accounts, links);
  },

  async clearAll(): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM person_transaction_links');
      await db.runAsync('DELETE FROM person_accounts');
      await db.runAsync('DELETE FROM people_group_members');
      await db.runAsync('DELETE FROM people');
    });
  },
};
