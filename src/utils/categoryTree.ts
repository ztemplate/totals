import type { Category, CategoryFlow } from '../models/category';
import type { TransactionSplit } from '../models/split';
import type { Transaction } from '../models/transaction';
import { categoryAllocations } from './transactionSplits';
import { transactionDebitOutflow, transactionIncomeAmount, transactionNetExpenseAmount } from './transactionAmounts';

/**
 * Categories form a forest through `parentId`: top-level ("major") categories and their subcategories.
 * Everything here is defensive about bad data: a parent that is missing, has the other flow, or would
 * close a cycle is ignored and the category is treated as top level, so nothing is ever lost or looped.
 */

export type CategoryWithId = Category & { id: number };

export interface CategoryNode {
  category: CategoryWithId;
  depth: number;
  children: CategoryNode[];
}

export const CATEGORY_PATH_SEPARATOR = ' › ';

function withIds(categories: readonly Category[]): CategoryWithId[] {
  return categories.filter((c): c is CategoryWithId => c.id != null);
}

/** Category id -> the parent id actually used (null = top level). */
export function effectiveParentMap(categories: readonly Category[]): Map<number, number | null> {
  const byId = new Map(withIds(categories).map((c) => [c.id, c]));
  const raw = new Map<number, number | null>();
  for (const c of byId.values()) {
    const p = c.parentId ?? null;
    const parent = p != null ? byId.get(p) : undefined;
    raw.set(c.id, parent && parent.id !== c.id && parent.flow === c.flow ? parent.id : null);
  }
  const out = new Map<number, number | null>();
  for (const id of raw.keys()) {
    // Walk up; if we come back to ourselves the link closes a cycle and is dropped.
    const seen = new Set<number>();
    let cur = raw.get(id) ?? null;
    let cycle = false;
    while (cur != null) {
      if (cur === id) {
        cycle = true;
        break;
      }
      if (seen.has(cur)) break; // a cycle further up that does not include us
      seen.add(cur);
      cur = raw.get(cur) ?? null;
    }
    out.set(id, cycle ? null : raw.get(id) ?? null);
  }
  return out;
}

/** Builds the tree, keeping the input order among siblings. Optionally limited to one flow. */
export function buildCategoryTree(categories: readonly Category[], flow?: CategoryFlow): CategoryNode[] {
  const list = withIds(categories).filter((c) => flow == null || c.flow === flow);
  const parents = effectiveParentMap(list);
  const childrenOf = new Map<number | null, CategoryWithId[]>();
  for (const c of list) {
    const p = parents.get(c.id) ?? null;
    const siblings = childrenOf.get(p) ?? [];
    siblings.push(c);
    childrenOf.set(p, siblings);
  }
  const build = (category: CategoryWithId, depth: number): CategoryNode => ({
    category,
    depth,
    children: (childrenOf.get(category.id) ?? []).map((child) => build(child, depth + 1)),
  });
  return (childrenOf.get(null) ?? []).map((c) => build(c, 0));
}

/** Depth-first list of nodes; children of ids in `collapsed` are skipped. */
export function flattenTree(nodes: readonly CategoryNode[], collapsed?: ReadonlySet<number>): CategoryNode[] {
  const out: CategoryNode[] = [];
  const walk = (list: readonly CategoryNode[]) => {
    for (const node of list) {
      out.push(node);
      if (!collapsed?.has(node.category.id)) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** Every category below `id` (children, grandchildren, ...), not including `id` itself. */
export function descendantIds(categories: readonly Category[], id: number): Set<number> {
  const parents = effectiveParentMap(categories);
  const childrenOf = new Map<number, number[]>();
  for (const [child, parent] of parents) {
    if (parent == null) continue;
    const list = childrenOf.get(parent) ?? [];
    list.push(child);
    childrenOf.set(parent, list);
  }
  const out = new Set<number>();
  const stack = [...(childrenOf.get(id) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (out.has(next) || next === id) continue;
    out.add(next);
    stack.push(...(childrenOf.get(next) ?? []));
  }
  return out;
}

/** The given ids plus all of their descendants. */
export function expandWithDescendants(categories: readonly Category[], ids: Iterable<number>): Set<number> {
  const out = new Set<number>();
  for (const id of ids) {
    out.add(id);
    for (const d of descendantIds(categories, id)) out.add(d);
  }
  return out;
}

/** Parent, grandparent, ... of `id`, nearest first. */
export function ancestorIds(categories: readonly Category[], id: number): number[] {
  const parents = effectiveParentMap(categories);
  const out: number[] = [];
  let cur = parents.get(id) ?? null;
  while (cur != null && !out.includes(cur) && cur !== id) {
    out.push(cur);
    cur = parents.get(cur) ?? null;
  }
  return out;
}

/** Why `parentId` can't be the parent of `child`, or null when it can (null parent = top level). */
export function parentError(categories: readonly Category[], child: Category, parentId: number | null | undefined): string | null {
  if (parentId == null) return null;
  if (child.id != null && parentId === child.id) return 'A category cannot be its own parent.';
  const parent = categories.find((c) => c.id === parentId);
  if (!parent) return 'The parent category no longer exists.';
  if (parent.flow !== child.flow) return `The parent must also be an ${child.flow} category.`;
  if (child.id != null && descendantIds(categories, child.id).has(parentId)) {
    return 'A category cannot be moved under one of its own subcategories.';
  }
  return null;
}

/** Categories that can be chosen as the parent of `category`, in tree order. */
export function parentOptions(categories: readonly Category[], category: Category): CategoryNode[] {
  return flattenTree(buildCategoryTree(categories, category.flow)).filter(
    (node) => parentError(categories, category, node.category.id) === null,
  );
}

/** "Food › Coffee" for a subcategory, just the name for a top-level one. */
export function categoryPath(categories: readonly Category[], category: Category): string {
  if (category.id == null) return category.name;
  const byId = new Map(withIds(categories).map((c) => [c.id, c]));
  const names = ancestorIds(categories, category.id)
    .map((id) => byId.get(id)?.name)
    .filter((n): n is string => !!n)
    .reverse();
  return [...names, category.name].join(CATEGORY_PATH_SEPARATOR);
}

export interface CategoryPickerItem {
  category: CategoryWithId;
  /** Full path, e.g. "Food › Coffee". */
  label: string;
  depth: number;
}

/**
 * Categories for a picker in tree order (each parent followed by its subcategories), labelled with
 * their path. `include` filters after ordering, so hidden parents don't hide their children.
 */
export function categoryPickerItems(
  categories: readonly Category[],
  include: (category: CategoryWithId) => boolean = () => true,
): CategoryPickerItem[] {
  const labels = new Map<number, string>();
  const out: CategoryPickerItem[] = [];
  const walk = (nodes: readonly CategoryNode[], prefix: string) => {
    for (const node of nodes) {
      const label = prefix ? `${prefix}${CATEGORY_PATH_SEPARATOR}${node.category.name}` : node.category.name;
      labels.set(node.category.id, label);
      if (include(node.category)) out.push({ category: node.category, label, depth: node.depth });
      walk(node.children, label);
    }
  };
  walk(buildCategoryTree(categories), '');
  return out;
}

// ------------------------------------------------------------------ totals

export interface CategoryTotalNode {
  category: CategoryWithId;
  depth: number;
  /** Amount in this category itself. */
  own: number;
  /** Own amount plus every descendant's. */
  total: number;
  children: CategoryTotalNode[];
}

/** Adds descendants' totals into each category. `own` maps category id (null = uncategorized) to its amount. */
export function rollUpTotals(
  tree: readonly CategoryNode[],
  own: ReadonlyMap<number | null, number>,
): CategoryTotalNode[] {
  const roll = (node: CategoryNode): CategoryTotalNode => {
    const children = node.children.map(roll);
    const mine = own.get(node.category.id) ?? 0;
    return {
      category: node.category,
      depth: node.depth,
      own: mine,
      total: mine + children.reduce((sum, c) => sum + c.total, 0),
      children,
    };
  };
  return tree.map(roll);
}

/** Totals sorted by total (largest first) at every level, dropping branches with nothing in them. */
export function nonZeroByTotal(nodes: readonly CategoryTotalNode[], epsilon = 0.005): CategoryTotalNode[] {
  return nodes
    .filter((n) => Math.abs(n.total) > epsilon)
    .map((n) => ({ ...n, children: nonZeroByTotal(n.children, epsilon) }))
    .sort((a, b) => b.total - a.total);
}

export interface OwnCategoryTotalsInput {
  transactions: Iterable<Transaction>;
  flow: CategoryFlow;
  splitsByParent?: ReadonlyMap<string, TransactionSplit[]>;
  isSelfTransfer?: (tx: Transaction) => boolean;
  /** Expense reference -> amount reimbursed by linked credits. */
  reimbursedByExpense?: ReadonlyMap<string, number>;
  /** Credits that aren't income (e.g. reimbursements). */
  excludeFromIncome?: (tx: Transaction) => boolean;
}

/**
 * Amount per category (null = uncategorized), using the same rules as the Money totals: net of
 * reimbursements, self transfers only count their fees, and split parts for other people are loans,
 * not your spending or income. Each transaction counts once, under its primary category.
 */
export function ownCategoryTotals(input: OwnCategoryTotalsInput): Map<number | null, number> {
  const out = new Map<number | null, number>();
  const add = (id: number | null, value: number) => {
    if (!Number.isFinite(value) || value === 0) return;
    out.set(id, (out.get(id) ?? 0) + value);
  };
  for (const tx of input.transactions) {
    const isSelfTransfer = input.isSelfTransfer?.(tx) ?? false;
    const splits = input.splitsByParent?.get(tx.reference);
    if (input.flow === 'expense') {
      if (tx.type !== 'DEBIT') continue;
      const gross = transactionDebitOutflow(tx);
      const net = transactionNetExpenseAmount(tx, {
        isSelfTransfer,
        reimbursedAmount: input.reimbursedByExpense?.get(tx.reference.trim()) ?? 0,
      });
      if (gross <= 0 || net <= 0) continue;
      for (const part of categoryAllocations(tx, splits, gross)) add(part.categoryId, (part.amount * net) / gross);
    } else {
      const amount = transactionIncomeAmount(tx, {
        isSelfTransfer,
        excludeFromIncome: input.excludeFromIncome?.(tx) ?? false,
      });
      if (amount <= 0) continue;
      for (const part of categoryAllocations(tx, splits, amount)) add(part.categoryId, part.amount);
    }
  }
  return out;
}
