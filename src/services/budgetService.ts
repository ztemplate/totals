import {
  budgetIncludesCategory,
  budgetIsEffectiveOn,
  budgetSelectedCategoryIds,
  getCurrentPeriodEnd,
  getCurrentPeriodStart,
  type Budget,
  type BudgetStatus,
} from '../models/budget';
import type { Category } from '../models/category';
import type { TransactionSplit } from '../models/split';
import type { Transaction } from '../models/transaction';
import { budgetRepository } from '../repositories/budgetRepository';
import { categoryRepository } from '../repositories/categoryRepository';
import { reimbursementRepository } from '../repositories/reimbursementRepository';
import { splitRepository } from '../repositories/splitRepository';
import { transactionRepository } from '../repositories/transactionRepository';
import { ancestorIds, expandWithDescendants } from '../utils/categoryTree';
import { amountInCategories, groupSplitsByParent } from '../utils/transactionSplits';
import { expenseAmountAfterReimbursement, transactionDebitOutflow } from '../utils/transactionAmounts';

interface BudgetStatusRequest {
  index: number;
  budget: Budget;
  periodStart: Date;
  periodEnd: Date;
}

/**
 * Net spending, optionally limited to categories. A split transaction only counts the parts in those
 * categories, and a reimbursement reduces each part in proportion to its share of the transaction.
 */
function sumNetSpending(
  transactions: Iterable<Transaction>,
  reimbursedByReference: Map<string, number>,
  categoryIds: ReadonlySet<number> | null,
  splitsByParent: Map<string, TransactionSplit[]>,
): number {
  let sum = 0;
  for (const tx of transactions) {
    const gross = transactionDebitOutflow(tx);
    const reimbursed = reimbursedByReference.get(tx.reference.trim()) ?? 0;
    const net = expenseAmountAfterReimbursement(gross, reimbursed);
    if (categoryIds === null) {
      sum += net;
      continue;
    }
    const inCategories = amountInCategories(tx, splitsByParent.get(tx.reference), categoryIds, gross);
    sum += gross > 0 ? (inCategories * net) / gross : 0;
  }
  return sum;
}

/**
 * The categories a budget counts: the chosen ones plus all of their subcategories, so a budget on a
 * major category tracks everything grouped under it. null = all expenses.
 */
async function budgetCategorySet(ids: Iterable<number>, categories?: Category[]): Promise<Set<number> | null> {
  const selected = [...ids].filter((id) => id > 0);
  if (selected.length === 0) return null;
  return expandWithDescendants(categories ?? (await categoryRepository.getCategories()), selected);
}

async function loadSplitsByParent(): Promise<Map<string, TransactionSplit[]>> {
  return groupSplitsByParent(await splitRepository.getAll());
}

function buildStatus(request: BudgetStatusRequest, spent: number): BudgetStatus {
  const { budget } = request;
  const percentageUsed = budget.amount > 0 ? (spent / budget.amount) * 100 : 0;
  return {
    budget,
    spent,
    remaining: budget.amount - spent,
    percentageUsed,
    isExceeded: spent > budget.amount,
    isApproachingLimit: percentageUsed >= budget.alertThreshold,
    periodStart: request.periodStart,
    periodEnd: request.periodEnd,
  };
}

async function getStatusesForBudgets(budgets: Budget[]): Promise<BudgetStatus[]> {
  if (budgets.length === 0) return [];

  // Budgets sharing a period share one transaction query.
  const requestsByPeriod = new Map<string, BudgetStatusRequest[]>();
  budgets.forEach((budget, index) => {
    const periodStart = getCurrentPeriodStart(budget);
    const periodEnd = getCurrentPeriodEnd(budget);
    const key = `${periodStart.getTime()}:${periodEnd.getTime()}`;
    const list = requestsByPeriod.get(key) ?? [];
    list.push({ index, budget, periodStart, periodEnd });
    requestsByPeriod.set(key, list);
  });

  const statuses = new Array<BudgetStatus>(budgets.length);
  const splitsByParent = await loadSplitsByParent();
  const categories = await categoryRepository.getCategories();
  for (const requests of requestsByPeriod.values()) {
    const { periodStart, periodEnd } = requests[0];
    const transactions = await transactionRepository.getTransactionsByDateRange(periodStart, periodEnd, { type: 'DEBIT' });
    const reimbursed = await reimbursementRepository.getAppliedTotalsForExpenses(transactions.map((t) => t.reference));
    for (const request of requests) {
      const categoryIds = await budgetCategorySet(budgetSelectedCategoryIds(request.budget), categories);
      const spent = sumNetSpending(transactions, reimbursed, categoryIds, splitsByParent);
      statuses[request.index] = buildStatus(request, spent);
    }
  }
  return statuses;
}

function getStatusesForCurrentBudgets(budgets: Budget[]): Promise<BudgetStatus[]> {
  const now = new Date();
  return getStatusesForBudgets(budgets.filter((b) => budgetIsEffectiveOn(b, now)));
}

export const budgetService = {
  /** Net expense spending for a period, optionally limited to categories (and their subcategories). */
  async calculateSpending(params: {
    startDate: Date;
    endDate: Date;
    categoryId?: number | null;
    categoryIds?: number[] | null;
  }): Promise<number> {
    const transactions = await transactionRepository.getTransactionsByDateRange(params.startDate, params.endDate, {
      type: 'DEBIT',
    });
    const ids = new Set<number>((params.categoryIds ?? []).filter((id) => id > 0));
    if (params.categoryId != null && params.categoryId > 0) ids.add(params.categoryId);
    const reimbursed = await reimbursementRepository.getAppliedTotalsForExpenses(transactions.map((t) => t.reference));
    return sumNetSpending(transactions, reimbursed, await budgetCategorySet(ids), await loadSplitsByParent());
  },

  async getBudgetStatus(budget: Budget): Promise<BudgetStatus> {
    return (await getStatusesForBudgets([budget]))[0];
  },

  async getAllBudgetStatuses(calendar?: string | null): Promise<BudgetStatus[]> {
    return getStatusesForCurrentBudgets(await budgetRepository.getActiveBudgets(calendar));
  },

  async getBudgetStatusesByType(type: string, calendar?: string | null): Promise<BudgetStatus[]> {
    return getStatusesForCurrentBudgets(await budgetRepository.getBudgetsByType(type, calendar));
  },

  async getCategoryBudgetStatuses(calendar?: string | null): Promise<BudgetStatus[]> {
    return getStatusesForCurrentBudgets(await budgetRepository.getCategoryBudgets(calendar));
  },

  /** Effective budgets that count spending in this category: on it or on any of its parent categories. */
  async getBudgetsByCategory(categoryId: number, calendar?: string | null): Promise<Budget[]> {
    const now = new Date();
    const ids = [categoryId, ...ancestorIds(await categoryRepository.getCategories(), categoryId)];
    return (await budgetRepository.getActiveBudgets(calendar)).filter(
      (b) => budgetIncludesCategory(b, ids) && budgetIsEffectiveOn(b, now),
    );
  },

  async getCurrentBudgetStatus(budget: Budget): Promise<BudgetStatus | null> {
    if (!budgetIsEffectiveOn(budget, new Date())) return null;
    return this.getBudgetStatus(budget);
  },

  async handleBudgetRollover(budget: Budget): Promise<void> {
    if (!budget.rollover) return;
    if (Date.now() <= getCurrentPeriodEnd(budget).getTime()) return;
    const status = await this.getBudgetStatus(budget);
    if (status.remaining <= 0) return;
    const now = new Date().toISOString();
    await budgetRepository.insertBudget({
      ...budget,
      id: null,
      amount: budget.amount + status.remaining,
      startDate: getCurrentPeriodStart(budget).toISOString(),
      createdAt: now,
    });
  },
};
