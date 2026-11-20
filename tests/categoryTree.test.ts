import { describe, expect, test } from 'bun:test';
import { categoryFromDb, categoryToDb, type Category } from '../src/models/category';
import type { TransactionSplit } from '../src/models/split';
import { makeTransaction, type Transaction } from '../src/models/transaction';
import {
  ancestorIds,
  buildCategoryTree,
  categoryPath,
  categoryPickerItems,
  descendantIds,
  expandWithDescendants,
  flattenTree,
  nonZeroByTotal,
  ownCategoryTotals,
  parentError,
  parentOptions,
  rollUpTotals,
} from '../src/utils/categoryTree';
import { amountInCategories } from '../src/utils/transactionSplits';

function cat(id: number, name: string, parentId: number | null = null, flow: 'expense' | 'income' = 'expense'): Category {
  return {
    id,
    name,
    essential: false,
    uncategorized: false,
    flow,
    recurring: false,
    builtIn: false,
    builtInKey: null,
    parentId,
  };
}

// Food (1) > Groceries (2), Eating out (3) > Coffee (4); Transport (5); Salary (10, income)
const CATS: Category[] = [
  cat(1, 'Food'),
  cat(2, 'Groceries', 1),
  cat(3, 'Eating out', 1),
  cat(4, 'Coffee', 3),
  cat(5, 'Transport'),
  cat(10, 'Salary', null, 'income'),
  cat(11, 'Bonus', 10, 'income'),
];

function tx(input: Partial<Transaction> & { reference: string }): Transaction {
  return makeTransaction({ amount: 100, type: 'DEBIT', bankId: 1, time: '2026-03-01T10:00:00.000Z', ...input });
}

function split(input: Partial<TransactionSplit> & Pick<TransactionSplit, 'amount' | 'parentReference'>): TransactionSplit {
  return { id: 1, kind: 'expense', categoryId: null, personId: null, note: null, createdAt: '2026-03-01T10:00:00.000Z', ...input };
}

describe('category tree', () => {
  test('builds parents with nested children, per flow', () => {
    const tree = buildCategoryTree(CATS, 'expense');
    expect(tree.map((n) => n.category.name)).toEqual(['Food', 'Transport']);
    expect(tree[0].children.map((n) => n.category.name)).toEqual(['Groceries', 'Eating out']);
    expect(tree[0].children[1].children[0].category.name).toBe('Coffee');
    expect(tree[0].children[1].children[0].depth).toBe(2);
    expect(flattenTree(tree).map((n) => n.category.id)).toEqual([1, 2, 3, 4, 5]);
    expect(flattenTree(tree, new Set([1])).map((n) => n.category.id)).toEqual([1, 5]);
  });

  test('bad parents fall back to top level: missing, other flow, self, cycles', () => {
    const bad = [cat(1, 'A', 99), cat(2, 'B', 10), cat(3, 'C', 3), cat(4, 'D', 5), cat(5, 'E', 4), cat(6, 'F', 4), cat(10, 'Inc', null, 'income')];
    const tree = buildCategoryTree(bad, 'expense');
    const all = flattenTree(tree).map((n) => n.category.id).sort((a, b) => a - b);
    expect(all).toEqual([1, 2, 3, 4, 5, 6]); // nothing lost
    expect(tree.map((n) => n.category.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(descendantIds(bad, 4)).toEqual(new Set([6]));
    expect(ancestorIds(bad, 4)).toEqual([]);
  });

  test('descendants and ancestors', () => {
    expect(descendantIds(CATS, 1)).toEqual(new Set([2, 3, 4]));
    expect(descendantIds(CATS, 3)).toEqual(new Set([4]));
    expect(descendantIds(CATS, 5)).toEqual(new Set());
    expect(expandWithDescendants(CATS, [3, 5])).toEqual(new Set([3, 4, 5]));
    expect(ancestorIds(CATS, 4)).toEqual([3, 1]);
    expect(categoryPath(CATS, CATS[3])).toBe('Food › Eating out › Coffee');
  });

  test('parent validation prevents cycles and flow mixing', () => {
    expect(parentError(CATS, CATS[0], null)).toBeNull();
    expect(parentError(CATS, CATS[0], 1)).not.toBeNull(); // itself
    expect(parentError(CATS, CATS[0], 4)).not.toBeNull(); // its own grandchild
    expect(parentError(CATS, CATS[4], 10)).not.toBeNull(); // income parent for expense
    expect(parentError(CATS, CATS[4], 404)).not.toBeNull();
    expect(parentError(CATS, CATS[4], 3)).toBeNull();
    expect(parentError(CATS, { ...cat(0, 'New'), id: null }, 1)).toBeNull();
    expect(parentOptions(CATS, CATS[2]).map((n) => n.category.id)).toEqual([1, 2, 5]);
  });

  test('picker items are in tree order with path labels', () => {
    const items = categoryPickerItems(CATS, (c) => c.flow === 'expense' && c.id !== 3);
    expect(items.map((i) => i.label)).toEqual(['Food', 'Food › Groceries', 'Food › Eating out › Coffee', 'Transport']);
  });

  test('parentId survives the db round trip', () => {
    expect(categoryFromDb(categoryToDb(CATS[1])).parentId).toBe(1);
    expect(categoryFromDb({ name: 'X', parentId: null }).parentId).toBeNull();
    expect(categoryFromDb({ name: 'X' }).parentId).toBeNull();
  });
});

describe('category totals', () => {
  test('roll up own and descendant totals', () => {
    const own = new Map<number | null, number>([
      [1, 10],
      [2, 50],
      [4, 5],
      [5, 20],
      [null, 7],
    ]);
    const rolled = rollUpTotals(buildCategoryTree(CATS, 'expense'), own);
    const food = rolled[0];
    expect(food.own).toBe(10);
    expect(food.total).toBe(65);
    expect(food.children.map((c) => [c.category.name, c.total])).toEqual([
      ['Groceries', 50],
      ['Eating out', 5],
    ]);
    expect(food.children[1].own).toBe(0);
    expect(rolled[1].total).toBe(20);
    const sorted = nonZeroByTotal(rolled);
    expect(sorted.map((n) => n.category.name)).toEqual(['Food', 'Transport']);
    expect(sorted[0].children.map((n) => n.category.name)).toEqual(['Groceries', 'Eating out']);
    expect(sorted[0].children[1].children.map((n) => n.category.name)).toEqual(['Coffee']);
  });

  test('own totals honour splits, loans, reimbursements and self transfers', () => {
    const transactions = [
      tx({ reference: 'A', amount: 100, categoryId: 2 }),
      tx({ reference: 'B', amount: 100, categoryId: 3, serviceCharge: 2 }),
      tx({ reference: 'C', amount: 40, categoryId: 4 }),
      tx({ reference: 'D', amount: 30 }),
      tx({ reference: 'SELF', amount: 500, categoryId: 5, serviceCharge: 1 }),
      tx({ reference: 'IN', amount: 1000, type: 'CREDIT', categoryId: 10 }),
    ];
    const splitsByParent = new Map<string, TransactionSplit[]>([
      [
        'A',
        [
          split({ parentReference: 'A', amount: 30, categoryId: 4 }), // my coffee
          split({ parentReference: 'A', amount: 20, kind: 'loan', personId: 7 }), // a friend's part
        ],
      ],
    ]);
    const own = ownCategoryTotals({
      transactions,
      flow: 'expense',
      splitsByParent,
      isSelfTransfer: (t) => t.reference === 'SELF',
      reimbursedByExpense: new Map([['C', 10]]),
    });
    expect(own.get(2)).toBeCloseTo(50);
    expect(own.get(4)).toBeCloseTo(30 + 30);
    expect(own.get(3)).toBeCloseTo(102);
    expect(own.get(null)).toBeCloseTo(30);
    expect(own.get(5)).toBeCloseTo(1); // only the fee of a self transfer
    expect(own.has(10)).toBe(false);

    const rolled = rollUpTotals(buildCategoryTree(CATS, 'expense'), own);
    expect(rolled[0].total).toBeCloseTo(50 + 60 + 102);

    // A budget on Food counts the same as the roll-up (before reimbursement).
    const food = expandWithDescendants(CATS, [1]);
    const budgetTotal = transactions
      .filter((t) => t.reference !== 'SELF' && t.type === 'DEBIT')
      .reduce((sum, t) => sum + amountInCategories(t, splitsByParent.get(t.reference), food, Math.abs(t.amount) + (t.serviceCharge ?? 0)), 0);
    expect(budgetTotal).toBeCloseTo(50 + 30 + 102 + 40);

    const income = ownCategoryTotals({ transactions, flow: 'income' });
    expect(income.get(10)).toBe(1000);
    expect(income.size).toBe(1);
  });
});
