import {
  budgetIsEffectiveOn,
  budgetSelectedCategoryIds,
  getCurrentPeriodEnd,
  getCurrentPeriodStart,
  type Budget,
  type BudgetStatus,
} from '../models/budget';
import { selectedCategoryIds, type Transaction } from '../models/transaction';
import { budgetRepository } from '../repositories/budgetRepository';
import { reimbursementRepository } from '../repositories/reimbursementRepository';
import { transactionRepository } from '../repositories/transactionRepository';
import { expenseAmountAfterReimbursement, transactionDebitOutflow } from '../utils/transactionAmounts';

interface BudgetStatusRequest {
  index: number;
  budget: Budget;
  periodStart: Date;
  periodEnd: Date;
}

function sumNetSpending(transactions: Iterable<Transaction>, reimbursedByReference: Map<string, number>): number {
  let sum = 0;
  for (const tx of transactions) {
    const gross = transactionDebitOutflow(tx);
    const reimbursed = reimbursedByReference.get(tx.reference.trim()) ?? 0;
    sum += expenseAmountAfterReimbursement(gross, reimbursed);
  }
  return sum;
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
  for (const requests of requestsByPeriod.values()) {
    const { periodStart, periodEnd } = requests[0];
    const transactions = await transactionRepository.getTransactionsByDateRange(periodStart, periodEnd, { type: 'DEBIT' });
    const reimbursed = await reimbursementRepository.getAppliedTotalsForExpenses(transactions.map((t) => t.reference));
    for (const request of requests) {
      const categoryIds = new Set(budgetSelectedCategoryIds(request.budget));
      const applicable =
        categoryIds.size === 0
          ? transactions
          : transactions.filter((tx) => selectedCategoryIds(tx).some((id) => categoryIds.has(id)));
      statuses[request.index] = buildStatus(request, sumNetSpending(applicable, reimbursed));
    }
  }
  return statuses;
}

function getStatusesForCurrentBudgets(budgets: Budget[]): Promise<BudgetStatus[]> {
  const now = new Date();
  return getStatusesForBudgets(budgets.filter((b) => budgetIsEffectiveOn(b, now)));
}

export const budgetService = {
  /** Net expense spending for a period, optionally limited to categories. */
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
    const filtered =
      ids.size === 0 ? transactions : transactions.filter((tx) => selectedCategoryIds(tx).some((id) => ids.has(id)));
    const reimbursed = await reimbursementRepository.getAppliedTotalsForExpenses(filtered.map((t) => t.reference));
    return sumNetSpending(filtered, reimbursed);
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

  async getBudgetsByCategory(categoryId: number, calendar?: string | null): Promise<Budget[]> {
    const now = new Date();
    return (await budgetRepository.getBudgetsByCategory(categoryId, calendar)).filter((b) => budgetIsEffectiveOn(b, now));
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
