import { getDb } from '../db/database';
import { categoryFromDb, type Category, type CategoryFlow } from '../models/category';
import { decodeCategoryIds } from '../models/transaction';
import { autoCategorization } from '../services/autoCategorization';

export const categoryRepository = {
  async getCategories(): Promise<Category[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM categories ORDER BY flow ASC, uncategorized ASC, essential DESC, name COLLATE NOCASE ASC',
    );
    return rows.map(categoryFromDb);
  },

  async createCategory(params: {
    name: string;
    essential: boolean;
    uncategorized?: boolean;
    iconKey?: string | null;
    colorKey?: string | null;
    description?: string | null;
    flow?: CategoryFlow;
    recurring?: boolean;
  }): Promise<Category> {
    const db = await getDb();
    const name = params.name.trim();
    const category: Category = {
      name,
      essential: params.essential,
      uncategorized: params.uncategorized ?? false,
      iconKey: params.iconKey ?? null,
      colorKey: params.colorKey ?? null,
      description: params.description ?? null,
      flow: params.flow ?? 'expense',
      recurring: params.recurring ?? false,
      builtIn: false,
      builtInKey: null,
    };
    const result = await db.runAsync(
      `INSERT INTO categories (name, essential, uncategorized, iconKey, colorKey, description, flow, recurring, builtIn, builtInKey)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
      [
        name,
        category.essential ? 1 : 0,
        category.uncategorized ? 1 : 0,
        category.iconKey ?? null,
        category.colorKey ?? null,
        category.description ?? null,
        category.flow,
        category.recurring ? 1 : 0,
      ],
    );
    return { ...category, id: result.lastInsertRowId };
  },

  async updateCategory(category: Category): Promise<void> {
    if (category.id == null) return;
    const db = await getDb();
    await db.runAsync(
      `UPDATE categories SET name = ?, essential = ?, uncategorized = ?, iconKey = ?, colorKey = ?, description = ?,
         flow = ?, recurring = ?, builtIn = ?, builtInKey = ? WHERE id = ?`,
      [
        category.name.trim(),
        category.essential ? 1 : 0,
        category.uncategorized ? 1 : 0,
        category.iconKey ?? null,
        category.colorKey ?? null,
        category.description ?? null,
        category.flow,
        category.recurring ? 1 : 0,
        category.builtIn ? 1 : 0,
        category.builtInKey ?? null,
        category.id,
      ],
    );
  },

  /** Deletes a user category and strips it from every transaction and rule. */
  async deleteCategory(category: Category): Promise<void> {
    if (category.id == null) return;
    if (category.builtIn) throw new Error('Built-in categories cannot be deleted');
    const id = category.id;
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      const rows = await db.getAllAsync<{ id: number; categoryId: number | null; categoryIds: string | null }>(
        'SELECT id, categoryId, categoryIds FROM transactions WHERE categoryId = ? OR categoryIds IS NOT NULL',
        [id],
      );
      for (const row of rows) {
        const selected = decodeCategoryIds(row.categoryIds) ?? [];
        if (row.categoryId != null && row.categoryId > 0 && !selected.includes(row.categoryId)) {
          selected.unshift(row.categoryId);
        }
        if (!selected.includes(id)) continue;
        const remaining = [...new Set(selected.filter((v) => v !== id))];
        await db.runAsync('UPDATE transactions SET categoryId = ?, categoryIds = ? WHERE id = ?', [
          remaining[0] ?? null,
          remaining.length === 0 ? null : JSON.stringify(remaining),
          row.id,
        ]);
      }
      const budgets = await db.getAllAsync<{ id: number; type: string; categoryId: number | null; categoryIds: string | null }>(
        'SELECT id, type, categoryId, categoryIds FROM budgets WHERE categoryId = ? OR categoryIds IS NOT NULL',
        [id],
      );
      for (const budget of budgets) {
        const selected = decodeCategoryIds(budget.categoryIds) ?? [];
        if (budget.categoryId != null && !selected.includes(budget.categoryId)) selected.unshift(budget.categoryId);
        if (!selected.includes(id)) continue;
        const remaining = selected.filter((v) => v !== id);
        // A category budget that loses all of its categories would silently become an "all expenses" budget.
        const deactivate = budget.type === 'category' && remaining.length === 0;
        await db.runAsync(
          `UPDATE budgets SET categoryId = ?, categoryIds = ?${deactivate ? ', isActive = 0' : ''}, updatedAt = ? WHERE id = ?`,
          [remaining[0] ?? null, remaining.length === 0 ? null : JSON.stringify(remaining), new Date().toISOString(), budget.id],
        );
      }
      await db.runAsync('DELETE FROM categories WHERE id = ?', [id]);
      await db.runAsync('DELETE FROM receiver_category_mappings WHERE categoryId = ?', [id]);
    });
    await autoCategorization.deleteRulesForCategory(id);
  },
};
