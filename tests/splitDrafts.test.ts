import { describe, expect, test } from 'bun:test';
import type { TransactionSplit } from '../src/models/split';
import {
  allocatedAmount,
  entriesFromSplits,
  entriesToDrafts,
  equalEntries,
  groupEntries,
  newEntry,
  validateEntries,
} from '../src/utils/splitDrafts';

describe('split editor entries', () => {
  test('"Me" parts save as expenses, people parts as loans that keep their category', () => {
    const drafts = entriesToDrafts([
      { ...newEntry(60, null, 3), note: 'mine' },
      newEntry(40, 7, 3),
    ]);
    expect(drafts).toEqual([
      { id: undefined, amount: 60, kind: 'expense', categoryId: 3, personId: null, note: 'mine' },
      { id: undefined, amount: 40, kind: 'loan', categoryId: 3, personId: 7, note: '' },
    ]);
  });

  test('saved splits load back as entries', () => {
    const base = { parentReference: 'P', note: null, createdAt: '2026-03-01T00:00:00.000Z' };
    const splits: TransactionSplit[] = [
      { ...base, id: 1, amount: 25.5, kind: 'expense', categoryId: 2, personId: null },
      { ...base, id: 2, amount: 10, kind: 'loan', categoryId: 2, personId: 9 },
    ];
    const entries = entriesFromSplits(splits);
    expect(entries.map((e) => [e.id, e.amount, e.categoryId, e.personId])).toEqual([
      [1, '25.5', 2, null],
      [2, '10', 2, 9],
    ]);
    expect(allocatedAmount(entries)).toBe(35.5);
  });

  test('number of splits keeps existing rows and adds "Me" rows', () => {
    const first = newEntry(100, 4, 1);
    const rows = equalEntries(100, 3, [first]);
    expect(rows.map((r) => r.amount)).toEqual(['33.34', '33.33', '33.33']);
    expect(rows[0]).toMatchObject({ key: first.key, personId: 4, categoryId: 1 });
    expect(rows[1].personId).toBeNull();
    expect(equalEntries(100, 2, rows).map((r) => r.key)).toEqual([rows[0].key, rows[1].key]);
  });

  test('a group fills one row for me and one per member', () => {
    const mine = newEntry(100, null, 5);
    const rows = groupEntries(90, [11, 12, 11], [mine]);
    expect(rows.map((r) => [r.personId, r.amount])).toEqual([
      [null, '30'],
      [11, '30'],
      [12, '30'],
    ]);
    expect(rows[0].key).toBe(mine.key);
    // Members take my category until changed.
    expect(rows[1].categoryId).toBe(5);
    expect(groupEntries(90, [11, 12], [], false).map((r) => r.personId)).toEqual([11, 12]);
  });

  test('validation', () => {
    expect(validateEntries(100, [])).toBe('Add at least one part.');
    expect(validateEntries(100, [newEntry(60), newEntry(50)])).toBe('The parts add up to more than the transaction.');
    // The same person can have parts in different categories.
    expect(validateEntries(100, [newEntry(10, 3, 1), newEntry(10, 3, 2)])).toBeNull();
    expect(validateEntries(100, [{ ...newEntry(), amount: '' }])).toBe('Every part needs a positive amount.');
    expect(validateEntries(100, [newEntry(60), newEntry(40, 2)])).toBeNull();
  });
});
