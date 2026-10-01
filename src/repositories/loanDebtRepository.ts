import type { SQLiteDatabase } from 'expo-sqlite';
import { getDb } from '../db/database';
import {
  loanDebtEntryFromDb,
  loanDebtRepaymentFromDb,
  normalizeLoanDebtPersonName,
  type LoanDebtDirection,
  type LoanDebtEntry,
  type LoanDebtRepayment,
  type LoanDebtStatus,
} from '../models/loanDebt';

export interface LoanDebtRepaymentAllocation {
  loanDebtTransactionReference: string;
  appliedAmount: number;
}

export interface LoanDebtReturnReminderCandidate {
  transactionReference: string;
  personName: string;
  direction: LoanDebtDirection;
  returnDate: Date;
  amount: number | null;
}

/** Notification helpers are loaded lazily to avoid an import cycle with the notification service. */
async function notifications() {
  return (await import('../services/notifications')).notificationService;
}

function normalizeReturnDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function repaymentDirectionForTransactionType(type: string | null | undefined): LoanDebtDirection {
  return type?.trim().toUpperCase() === 'CREDIT' ? 'lent' : 'borrowed';
}

function originalAmountForEntry(entry: LoanDebtEntry, transactionAmount: unknown): number {
  if (entry.principalAmount != null && Number.isFinite(entry.principalAmount)) return Math.abs(entry.principalAmount);
  return Math.abs(Number(transactionAmount ?? 0) || 0);
}

function remainingFrom(original: number | null, repaid: number): number | null {
  if (original === null) return null;
  return original - repaid <= 0.005 ? 0 : original - repaid;
}

async function amountForEntry(db: SQLiteDatabase, reference: string, principalAmount?: number | null): Promise<number | null> {
  if (principalAmount != null && Number.isFinite(principalAmount)) return Math.abs(principalAmount);
  const row = await db.getFirstAsync<{ amount: number | null }>(
    'SELECT amount FROM transactions WHERE reference = ? LIMIT 1',
    [reference],
  );
  if (!row || row.amount == null) return null;
  return Math.abs(Number(row.amount));
}

async function totalApplied(db: SQLiteDatabase, loanDebtReference: string, excludingRepaymentReference?: string): Promise<number> {
  const row = excludingRepaymentReference
    ? await db.getFirstAsync<{ total: number }>(
        `SELECT COALESCE(SUM(appliedAmount), 0) AS total FROM loan_debt_repayments
         WHERE loanDebtTransactionReference = ? AND repaymentTransactionReference <> ?`,
        [loanDebtReference, excludingRepaymentReference],
      )
    : await db.getFirstAsync<{ total: number }>(
        'SELECT COALESCE(SUM(appliedAmount), 0) AS total FROM loan_debt_repayments WHERE loanDebtTransactionReference = ?',
        [loanDebtReference],
      );
  return Number(row?.total ?? 0);
}

async function getEntryRow(db: SQLiteDatabase, reference: string): Promise<LoanDebtEntry | null> {
  const row = await db.getFirstAsync<Record<string, unknown>>(
    'SELECT * FROM loan_debt_entries WHERE transactionReference = ? LIMIT 1',
    [reference],
  );
  return row ? loanDebtEntryFromDb(row) : null;
}

async function cancelReturnReminder(reference: string): Promise<void> {
  try {
    await (await notifications()).cancelLoanDebtReturnReminder(reference);
  } catch (error) {
    if (__DEV__) console.warn('debug: Failed to cancel loan/debt reminder', error);
  }
}

async function syncReturnReminder(params: {
  transactionReference: string;
  personName: string;
  direction: LoanDebtDirection;
  status: LoanDebtStatus;
  returnDate: Date | null;
  amount: number | null;
}): Promise<void> {
  const reference = params.transactionReference.trim();
  const name = normalizeLoanDebtPersonName(params.personName);
  if (!reference) return;
  if (params.status !== 'active' || !name || params.returnDate === null) {
    await cancelReturnReminder(reference);
    return;
  }
  try {
    await (await notifications()).scheduleLoanDebtReturnReminder({
      transactionReference: reference,
      personName: name,
      direction: params.direction,
      returnDate: params.returnDate,
      amount: params.amount,
    });
  } catch (error) {
    if (__DEV__) console.warn('debug: Failed to schedule loan/debt reminder', error);
  }
}

async function syncReturnReminderForStoredEntry(db: SQLiteDatabase, reference: string): Promise<void> {
  const normalized = reference.trim();
  if (!normalized) return;
  const entry = await getEntryRow(db, normalized);
  if (!entry) {
    await cancelReturnReminder(normalized);
    return;
  }
  const original = await amountForEntry(db, normalized, entry.principalAmount);
  const repaid = await totalApplied(db, normalized);
  const remaining = remainingFrom(original, repaid);
  const effectiveStatus: LoanDebtStatus = entry.status === 'active' && remaining === 0 ? 'settled' : entry.status;
  await syncReturnReminder({
    transactionReference: normalized,
    personName: entry.personName,
    direction: entry.direction,
    status: effectiveStatus,
    returnDate: normalizeReturnDate(entry.returnDate),
    amount: remaining !== null && remaining > 0 ? remaining : original,
  });
}

async function requireTransactionExists(db: SQLiteDatabase, reference: string, role: string): Promise<void> {
  const row = await db.getFirstAsync('SELECT reference FROM transactions WHERE reference = ? LIMIT 1', [reference]);
  if (!row) throw new Error(`${role} transaction does not exist.`);
}

async function validateRepaymentAllocations(
  db: SQLiteDatabase,
  repaymentReference: string,
  allocations: LoanDebtRepaymentAllocation[],
  allowResolvedTargets: boolean,
): Promise<void> {
  if (allocations.length === 0) return;
  const repayment = await db.getFirstAsync<{ type: string | null }>(
    'SELECT type FROM transactions WHERE reference = ? LIMIT 1',
    [repaymentReference],
  );
  if (!repayment) throw new Error('Repayment transaction does not exist.');
  const repaymentDirection = repaymentDirectionForTransactionType(repayment.type);
  const existingRows = await db.getAllAsync<{ r: string | null }>(
    'SELECT loanDebtTransactionReference AS r FROM loan_debt_repayments WHERE repaymentTransactionReference = ?',
    [repaymentReference],
  );
  const existingTargets = new Set(existingRows.map((row) => row.r?.trim() ?? '').filter(Boolean));

  for (const allocation of allocations) {
    const loanDebtReference = allocation.loanDebtTransactionReference.trim();
    if (loanDebtReference === repaymentReference) throw new Error('A repayment cannot be applied to itself.');
    const entry = await getEntryRow(db, loanDebtReference);
    if (!entry) throw new Error('Loan or debt entry does not exist.');
    if (!entry.personName.trim()) throw new Error('Loan or debt entry needs a person.');
    if (entry.direction !== repaymentDirection) throw new Error('Repayment direction does not match loan or debt.');
    if (entry.status !== 'active' && !allowResolvedTargets && !existingTargets.has(loanDebtReference)) {
      throw new Error('Loan or debt entry is not active.');
    }
    const loanTx = await db.getFirstAsync<{ amount: number | null }>(
      'SELECT amount FROM transactions WHERE reference = ? LIMIT 1',
      [loanDebtReference],
    );
    if (!loanTx) throw new Error('Loan or debt transaction does not exist.');
    const original = originalAmountForEntry(entry, loanTx.amount);
    const alreadyApplied = await totalApplied(db, loanDebtReference, repaymentReference);
    if (allocation.appliedAmount - (original - alreadyApplied) > 0.005) {
      throw new Error('Repayment exceeds the remaining balance.');
    }
  }
}

async function loanReferencesForRepayment(db: SQLiteDatabase, repaymentReference: string): Promise<string[]> {
  const rows = await db.getAllAsync<{ r: string | null }>(
    'SELECT loanDebtTransactionReference AS r FROM loan_debt_repayments WHERE repaymentTransactionReference = ?',
    [repaymentReference],
  );
  return rows.map((row) => row.r?.trim() ?? '').filter(Boolean);
}

async function deleteSurplusAndIncomingRepayments(db: SQLiteDatabase, reference: string): Promise<void> {
  await db.runAsync(
    "DELETE FROM loan_debt_entries WHERE transactionReference = ? AND (source = 'repayment_surplus' OR principalAmount IS NOT NULL)",
    [reference],
  );
  await db.runAsync('DELETE FROM loan_debt_repayments WHERE loanDebtTransactionReference = ?', [reference]);
}

export const loanDebtRepository = {
  async getEntries(): Promise<LoanDebtEntry[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM loan_debt_entries ORDER BY updatedAt DESC, id DESC');
    return rows.map(loanDebtEntryFromDb);
  },

  async getRepayments(): Promise<LoanDebtRepayment[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM loan_debt_repayments ORDER BY updatedAt DESC, id DESC',
    );
    return rows.map(loanDebtRepaymentFromDb);
  },

  async getRepaymentForTransaction(repaymentReference: string): Promise<LoanDebtRepayment | null> {
    const reference = repaymentReference.trim();
    if (!reference) return null;
    const db = await getDb();
    const row = await db.getFirstAsync<Record<string, unknown>>(
      'SELECT * FROM loan_debt_repayments WHERE repaymentTransactionReference = ? LIMIT 1',
      [reference],
    );
    return row ? loanDebtRepaymentFromDb(row) : null;
  },

  async getRepaymentsForTransaction(repaymentReference: string): Promise<LoanDebtRepayment[]> {
    const reference = repaymentReference.trim();
    if (!reference) return [];
    const db = await getDb();
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM loan_debt_repayments WHERE repaymentTransactionReference = ? ORDER BY id ASC',
      [reference],
    );
    return rows.map(loanDebtRepaymentFromDb);
  },

  async getEntryForTransaction(reference: string): Promise<LoanDebtEntry | null> {
    const normalized = reference.trim();
    if (!normalized) return null;
    return getEntryRow(await getDb(), normalized);
  },

  async getKnownPeople(): Promise<string[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<{ personName: string | null }>(
      `SELECT personName, MAX(updatedAt) AS lastUpdated
       FROM loan_debt_entries
       WHERE TRIM(personName) <> ''
       GROUP BY LOWER(TRIM(personName))
       ORDER BY lastUpdated DESC, personName COLLATE NOCASE ASC`,
    );
    return rows.map((row) => row.personName?.trim() ?? '').filter(Boolean);
  },

  async upsertTransactionPerson(params: {
    transactionReference: string;
    personName: string;
    direction: LoanDebtDirection;
    principalAmount?: number | null;
    returnDate?: Date | null;
    replaceReturnDate?: boolean;
  }): Promise<void> {
    const reference = params.transactionReference.trim();
    const name = normalizeLoanDebtPersonName(params.personName);
    if (!reference || !name) return;
    const db = await getDb();
    const existing = await getEntryRow(db, reference);
    const nowIso = new Date().toISOString();
    const existingIsSurplus = existing?.source === 'repayment_surplus';
    const principal =
      params.principalAmount != null && Number.isFinite(params.principalAmount)
        ? Math.abs(params.principalAmount)
        : existingIsSurplus
          ? existing?.principalAmount ?? null
          : null;
    const effectiveReturnDate = params.replaceReturnDate
      ? normalizeReturnDate(params.returnDate)
      : normalizeReturnDate(existing?.returnDate);
    const values = [
      name,
      params.direction,
      'active',
      principal,
      existingIsSurplus ? 'repayment_surplus' : 'transaction',
      effectiveReturnDate?.toISOString() ?? null,
      existing?.createdAt ?? nowIso,
      nowIso,
    ];
    if (!existing) {
      await db.runAsync(
        `INSERT INTO loan_debt_entries (personName, direction, status, principalAmount, source, returnDate, resolvedAt, createdAt, updatedAt, transactionReference)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        [...values, reference],
      );
    } else {
      await db.runAsync(
        `UPDATE loan_debt_entries SET personName = ?, direction = ?, status = ?, principalAmount = ?, source = ?, returnDate = ?,
           resolvedAt = NULL, createdAt = ?, updatedAt = ? WHERE transactionReference = ?`,
        [...values, reference],
      );
    }
    await syncReturnReminderForStoredEntry(db, reference);
  },

  async updateEntryStatus(params: { transactionReference: string; status: LoanDebtStatus }): Promise<void> {
    const reference = params.transactionReference.trim();
    if (!reference) return;
    const db = await getDb();
    const nowIso = new Date().toISOString();
    await db.runAsync('UPDATE loan_debt_entries SET status = ?, resolvedAt = ?, updatedAt = ? WHERE transactionReference = ?', [
      params.status,
      params.status === 'active' ? null : nowIso,
      nowIso,
      reference,
    ]);
    await syncReturnReminderForStoredEntry(db, reference);
  },

  linkRepayment(params: {
    repaymentTransactionReference: string;
    loanDebtTransactionReference: string;
    appliedAmount: number;
  }): Promise<void> {
    return this.saveRepaymentFlow({
      repaymentTransactionReference: params.repaymentTransactionReference,
      allocations: [
        { loanDebtTransactionReference: params.loanDebtTransactionReference, appliedAmount: params.appliedAmount },
      ],
    });
  },

  /**
   * Replaces all allocations made by a repayment transaction. Any amount left over can
   * become a new loan/debt entry (a "repayment surplus") owned by the repayment itself.
   */
  async saveRepaymentFlow(params: {
    repaymentTransactionReference: string;
    allocations: LoanDebtRepaymentAllocation[];
    surplusPersonName?: string | null;
    surplusDirection?: LoanDebtDirection | null;
    surplusPrincipalAmount?: number | null;
    allowResolvedTargets?: boolean;
  }): Promise<void> {
    const repaymentReference = params.repaymentTransactionReference.trim();
    if (!repaymentReference) return;

    const allocations: LoanDebtRepaymentAllocation[] = [];
    const seen = new Set<string>();
    for (const allocation of params.allocations) {
      const reference = allocation.loanDebtTransactionReference.trim();
      const amount = Number.isFinite(allocation.appliedAmount) ? Math.abs(allocation.appliedAmount) : 0;
      if (!reference || amount <= 0 || seen.has(reference)) continue;
      seen.add(reference);
      allocations.push({ loanDebtTransactionReference: reference, appliedAmount: amount });
    }

    const surplusName = normalizeLoanDebtPersonName(params.surplusPersonName ?? '');
    const surplusAmount =
      params.surplusPrincipalAmount != null && Number.isFinite(params.surplusPrincipalAmount)
        ? Math.abs(params.surplusPrincipalAmount)
        : 0;
    const surplusDirection = params.surplusDirection ?? null;
    const shouldSaveSurplus = !!surplusName && surplusDirection !== null && surplusAmount > 0;

    const db = await getDb();
    const nowIso = new Date().toISOString();
    const affected = new Set<string>([
      ...(await loanReferencesForRepayment(db, repaymentReference)),
      ...allocations.map((a) => a.loanDebtTransactionReference),
      repaymentReference,
    ]);

    await db.withTransactionAsync(async () => {
      if (allocations.length > 0 || shouldSaveSurplus) {
        await requireTransactionExists(db, repaymentReference, 'Repayment');
      }
      await validateRepaymentAllocations(db, repaymentReference, allocations, params.allowResolvedTargets ?? false);

      await db.runAsync('DELETE FROM loan_debt_repayments WHERE repaymentTransactionReference = ?', [repaymentReference]);
      for (const allocation of allocations) {
        await db.runAsync(
          `INSERT OR REPLACE INTO loan_debt_repayments
             (repaymentTransactionReference, loanDebtTransactionReference, appliedAmount, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?)`,
          [repaymentReference, allocation.loanDebtTransactionReference, allocation.appliedAmount, nowIso, nowIso],
        );
      }

      if (shouldSaveSurplus) {
        const existing = await getEntryRow(db, repaymentReference);
        const values = [surplusName, surplusDirection, 'active', surplusAmount, 'repayment_surplus', existing?.createdAt ?? nowIso, nowIso];
        if (!existing) {
          await db.runAsync(
            `INSERT INTO loan_debt_entries (personName, direction, status, principalAmount, source, resolvedAt, createdAt, updatedAt, transactionReference)
             VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
            [...values, repaymentReference],
          );
        } else {
          await db.runAsync(
            `UPDATE loan_debt_entries SET personName = ?, direction = ?, status = ?, principalAmount = ?, source = ?,
               resolvedAt = NULL, createdAt = ?, updatedAt = ? WHERE transactionReference = ?`,
            [...values, repaymentReference],
          );
        }
      } else {
        await deleteSurplusAndIncomingRepayments(db, repaymentReference);
      }
    });

    for (const reference of affected) await syncReturnReminderForStoredEntry(db, reference);
  },

  async deleteRepaymentForTransaction(repaymentReference: string): Promise<void> {
    const reference = repaymentReference.trim();
    if (!reference) return;
    const db = await getDb();
    const affected = new Set<string>([...(await loanReferencesForRepayment(db, reference)), reference]);
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM loan_debt_repayments WHERE repaymentTransactionReference = ?', [reference]);
      await deleteSurplusAndIncomingRepayments(db, reference);
    });
    for (const ref of affected) await syncReturnReminderForStoredEntry(db, ref);
  },

  async deleteEntryForTransaction(reference: string): Promise<void> {
    const normalized = reference.trim();
    if (!normalized) return;
    const db = await getDb();
    await db.runAsync('DELETE FROM loan_debt_entries WHERE transactionReference = ?', [normalized]);
    await cancelReturnReminder(normalized);
  },

  async clearAll(): Promise<void> {
    const db = await getDb();
    const rows = await db.getAllAsync<{ r: string | null }>('SELECT transactionReference AS r FROM loan_debt_entries');
    const references = new Set(rows.map((row) => row.r?.trim() ?? '').filter(Boolean));
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM loan_debt_repayments');
      await db.runAsync('DELETE FROM loan_debt_entries');
    });
    // The stored data is already gone; notification cleanup is best-effort.
    for (const reference of references) await cancelReturnReminder(reference);
  },

  async syncReturnReminders(): Promise<void> {
    const db = await getDb();
    const rows = await db.getAllAsync<{ r: string | null }>('SELECT transactionReference AS r FROM loan_debt_entries');
    for (const row of rows) {
      const reference = row.r?.trim();
      if (reference) await syncReturnReminderForStoredEntry(db, reference);
    }
  },

  async getActiveFutureReturnReminderCandidates(): Promise<LoanDebtReturnReminderCandidate[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Record<string, unknown>>(
      `SELECT * FROM loan_debt_entries WHERE status = 'active' AND returnDate IS NOT NULL
       ORDER BY returnDate ASC, updatedAt DESC, id DESC`,
    );
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const candidates: LoanDebtReturnReminderCandidate[] = [];
    for (const row of rows) {
      const entry = loanDebtEntryFromDb(row);
      const reference = entry.transactionReference.trim();
      const name = normalizeLoanDebtPersonName(entry.personName);
      const returnDate = normalizeReturnDate(entry.returnDate);
      if (!reference || !name || !returnDate || returnDate.getTime() < today.getTime()) continue;
      const original = await amountForEntry(db, reference, entry.principalAmount);
      const remaining = remainingFrom(original, await totalApplied(db, reference));
      if (remaining === 0) continue;
      candidates.push({
        transactionReference: reference,
        personName: name,
        direction: entry.direction,
        returnDate,
        amount: remaining !== null && remaining > 0 ? remaining : original,
      });
    }
    return candidates;
  },

  async showActiveFutureReturnReminderTestNotifications(): Promise<number> {
    const candidates = await this.getActiveFutureReturnReminderCandidates();
    const service = await notifications();
    let shown = 0;
    for (const candidate of candidates) {
      const ok = await service.showLoanDebtReturnReminderNow({
        transactionReference: candidate.transactionReference,
        personName: candidate.personName,
        direction: candidate.direction,
        amount: candidate.amount,
        useTestId: true,
        ignoreEnabledCheck: true,
      });
      if (ok) shown++;
    }
    return shown;
  },

  /** Remaining amount owed on an entry (principal or transaction amount minus repayments). */
  async getRemainingAmount(reference: string): Promise<number | null> {
    const normalized = reference.trim();
    if (!normalized) return null;
    const db = await getDb();
    const entry = await getEntryRow(db, normalized);
    if (!entry) return null;
    const original = await amountForEntry(db, normalized, entry.principalAmount);
    return remainingFrom(original, await totalApplied(db, normalized));
  },
};
