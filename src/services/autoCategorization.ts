import { getDb } from '../db/database';
import { categoryFromDb, isManagedCategory, normalizeFlow, type CategoryFlow } from '../models/category';
import type { AutoCategoryPromptDismissal, AutoCategoryRule } from '../models/misc';
import { PrefKeys, prefs } from './prefs';

export interface AutoCategorizationSelection {
  primaryCategoryId: number;
  categoryIds: number[];
}

function displayCounterparty(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function ruleFromDb(row: Record<string, any>): AutoCategoryRule {
  return {
    id: row.id ?? null,
    counterparty: String(row.counterparty ?? ''),
    normalizedCounterparty: String(row.normalizedCounterparty ?? ''),
    flow: normalizeFlow(row.flow),
    categoryId: Number(row.categoryId),
    isPrimary: row.isPrimary === 1,
    createdAt: String(row.createdAt ?? ''),
  };
}

function dismissalFromDb(row: Record<string, any>): AutoCategoryPromptDismissal {
  return {
    id: row.id ?? null,
    counterparty: String(row.counterparty ?? ''),
    normalizedCounterparty: String(row.normalizedCounterparty ?? ''),
    flow: normalizeFlow(row.flow),
    createdAt: String(row.createdAt ?? ''),
  };
}

function sortRules(rules: AutoCategoryRule[]): AutoCategoryRule[] {
  return rules.sort((a, b) => {
    const cp = a.counterparty.toLowerCase().localeCompare(b.counterparty.toLowerCase());
    if (cp !== 0) return cp;
    if (a.flow !== b.flow) return a.flow.localeCompare(b.flow);
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return a.categoryId - b.categoryId;
  });
}

async function managedCategoryIds(): Promise<Set<number>> {
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM categories');
  const ids = new Set<number>();
  for (const row of rows) {
    const category = categoryFromDb(row);
    if (category.id != null && isManagedCategory(category)) ids.add(category.id);
  }
  return ids;
}

async function legacyCategoryFor(receiver?: string | null, creditor?: string | null): Promise<number | null> {
  const db = await getDb();
  const lookup = async (accountNumber: string, accountType: string) => {
    const row = await db.getFirstAsync<{ categoryId: number }>(
      'SELECT categoryId FROM receiver_category_mappings WHERE accountNumber = ? AND accountType = ? LIMIT 1',
      [accountNumber, accountType],
    );
    return row?.categoryId ?? null;
  };
  if (receiver) {
    const id = await lookup(receiver, 'receiver');
    if (id !== null) return id;
  }
  if (creditor) {
    const id = await lookup(creditor, 'creditor');
    if (id !== null) return id;
  }
  return null;
}

export const autoCategorization = {
  isEnabled(): Promise<boolean> {
    return prefs.getBool(PrefKeys.autoCategorizationEnabled, true);
  },

  setEnabled(value: boolean): Promise<void> {
    return prefs.setBool(PrefKeys.autoCategorizationEnabled, value);
  },

  isPromptEnabled(): Promise<boolean> {
    return prefs.getBool(PrefKeys.autoCategorizationPromptEnabled, true);
  },

  setPromptEnabled(value: boolean): Promise<void> {
    return prefs.setBool(PrefKeys.autoCategorizationPromptEnabled, value);
  },

  normalizeCounterparty(value: string): string {
    return value.trim().replace(/\s+/g, ' ').toLowerCase();
  },

  flowForTransactionType(type: string | null | undefined): CategoryFlow {
    return (type ?? '').trim().toUpperCase() === 'CREDIT' ? 'income' : 'expense';
  },

  resolvePrimaryCounterparty(params: {
    type: string | null | undefined;
    receiver?: string | null;
    creditor?: string | null;
  }): string | null {
    const norm = (value?: string | null) => {
      const trimmed = value?.trim();
      return trimmed ? trimmed.replace(/\s+/g, ' ') : null;
    };
    const receiver = norm(params.receiver);
    const creditor = norm(params.creditor);
    if ((params.type ?? '').trim().toUpperCase() === 'CREDIT') return creditor ?? receiver;
    return receiver ?? creditor;
  },

  async getRules(flow?: string): Promise<AutoCategoryRule[]> {
    const db = await getDb();
    const rows = flow
      ? await db.getAllAsync<Record<string, unknown>>('SELECT * FROM auto_category_rules WHERE flow = ?', [normalizeFlow(flow)])
      : await db.getAllAsync<Record<string, unknown>>('SELECT * FROM auto_category_rules');
    const managed = await managedCategoryIds();
    return sortRules(rows.map(ruleFromDb).filter((r) => !managed.has(r.categoryId)));
  },

  async getRulesForCounterparty(counterparty: string, flow: string): Promise<AutoCategoryRule[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM auto_category_rules WHERE normalizedCounterparty = ? AND flow = ? ORDER BY isPrimary DESC, id ASC',
      [this.normalizeCounterparty(counterparty), normalizeFlow(flow)],
    );
    const managed = await managedCategoryIds();
    return sortRules(rows.map(ruleFromDb).filter((r) => !managed.has(r.categoryId)));
  },

  async getRuleForCounterparty(counterparty: string, flow: string): Promise<AutoCategoryRule | null> {
    const rules = await this.getRulesForCounterparty(counterparty, flow);
    return rules.find((r) => r.isPrimary) ?? rules[0] ?? null;
  },

  async upsertRule(counterparty: string, flow: string, categoryId: number): Promise<void> {
    await this.replaceRules({ counterparty, flow, categoryIds: [categoryId], primaryCategoryId: categoryId });
  },

  async replaceRules(params: {
    counterparty: string;
    flow: string;
    categoryIds: Iterable<number>;
    primaryCategoryId?: number | null;
  }): Promise<void> {
    const db = await getDb();
    const normalized = this.normalizeCounterparty(params.counterparty);
    const display = displayCounterparty(params.counterparty);
    const flow = normalizeFlow(params.flow);
    const managed = await managedCategoryIds();

    const ids: number[] = [];
    for (const id of params.categoryIds) {
      if (id <= 0 || ids.includes(id) || managed.has(id)) continue;
      ids.push(id);
    }
    const primary =
      ids.length === 0
        ? null
        : params.primaryCategoryId != null && ids.includes(params.primaryCategoryId)
          ? params.primaryCategoryId
          : ids[0];

    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM auto_category_rules WHERE normalizedCounterparty = ? AND flow = ?', [normalized, flow]);
      const createdAt = new Date().toISOString();
      for (const id of ids) {
        await db.runAsync(
          `INSERT OR REPLACE INTO auto_category_rules (counterparty, normalizedCounterparty, flow, categoryId, isPrimary, createdAt)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [display, normalized, flow, id, id === primary ? 1 : 0, createdAt],
        );
      }
    });
  },

  async deleteRulesForCounterparty(counterparty: string, flow: string): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM auto_category_rules WHERE normalizedCounterparty = ? AND flow = ?', [
      this.normalizeCounterparty(counterparty),
      normalizeFlow(flow),
    ]);
  },

  async deleteRule(id: number): Promise<void> {
    const db = await getDb();
    const row = await db.getFirstAsync<Record<string, unknown>>('SELECT * FROM auto_category_rules WHERE id = ?', [id]);
    if (!row) return;
    const rule = ruleFromDb(row);
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM auto_category_rules WHERE id = ?', [id]);
      if (!rule.isPrimary) return;
      const remaining = await db.getFirstAsync<{ id: number }>(
        'SELECT id FROM auto_category_rules WHERE normalizedCounterparty = ? AND flow = ? ORDER BY id ASC LIMIT 1',
        [rule.normalizedCounterparty, rule.flow],
      );
      if (remaining) await db.runAsync('UPDATE auto_category_rules SET isPrimary = 1 WHERE id = ?', [remaining.id]);
    });
  },

  async dismissPrompt(counterparty: string, flow: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `INSERT OR REPLACE INTO auto_category_prompt_dismissals (counterparty, normalizedCounterparty, flow, createdAt)
       VALUES (?, ?, ?, ?)`,
      [displayCounterparty(counterparty), this.normalizeCounterparty(counterparty), normalizeFlow(flow), new Date().toISOString()],
    );
  },

  async isPromptDismissed(counterparty: string, flow: string): Promise<boolean> {
    const db = await getDb();
    const row = await db.getFirstAsync(
      'SELECT id FROM auto_category_prompt_dismissals WHERE normalizedCounterparty = ? AND flow = ? LIMIT 1',
      [this.normalizeCounterparty(counterparty), normalizeFlow(flow)],
    );
    return row !== null;
  },

  async getDismissals(flow?: string): Promise<AutoCategoryPromptDismissal[]> {
    const db = await getDb();
    const rows = flow
      ? await db.getAllAsync<Record<string, unknown>>(
          'SELECT * FROM auto_category_prompt_dismissals WHERE flow = ? ORDER BY counterparty COLLATE NOCASE ASC, id ASC',
          [normalizeFlow(flow)],
        )
      : await db.getAllAsync<Record<string, unknown>>(
          'SELECT * FROM auto_category_prompt_dismissals ORDER BY counterparty COLLATE NOCASE ASC, id ASC',
        );
    return rows.map(dismissalFromDb);
  },

  async clearPromptDismissal(counterparty: string, flow: string): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM auto_category_prompt_dismissals WHERE normalizedCounterparty = ? AND flow = ?', [
      this.normalizeCounterparty(counterparty),
      normalizeFlow(flow),
    ]);
  },

  async clearPromptDismissalById(id: number): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM auto_category_prompt_dismissals WHERE id = ?', [id]);
  },

  async clearAll(): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM auto_category_rules');
      await db.runAsync('DELETE FROM auto_category_prompt_dismissals');
      // Keep the legacy fallback in sync with the current rule store.
      await db.runAsync('DELETE FROM receiver_category_mappings');
    });
  },

  async deleteRulesForCategory(categoryId: number): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM auto_category_rules WHERE categoryId = ?', [categoryId]);
  },

  async getCategorySelectionForTransaction(params: {
    type: string | null | undefined;
    receiver?: string | null;
    creditor?: string | null;
  }): Promise<AutoCategorizationSelection | null> {
    if (!(await this.isEnabled())) return null;
    const flow = this.flowForTransactionType(params.type);
    const counterparty = this.resolvePrimaryCounterparty(params);
    if (counterparty) {
      const rules = await this.getRulesForCounterparty(counterparty, flow);
      const ids: number[] = [];
      let primary: number | null = null;
      for (const rule of rules) {
        if (rule.categoryId <= 0 || ids.includes(rule.categoryId)) continue;
        ids.push(rule.categoryId);
        if (primary === null && rule.isPrimary) primary = rule.categoryId;
      }
      if (ids.length > 0) return { primaryCategoryId: primary ?? ids[0], categoryIds: ids };
    }

    const fallback = await legacyCategoryFor(params.receiver, params.creditor);
    if (fallback === null || fallback <= 0) return null;
    if ((await managedCategoryIds()).has(fallback)) return null;
    return { primaryCategoryId: fallback, categoryIds: [fallback] };
  },
};
