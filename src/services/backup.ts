import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { getDb, type SqlValue } from '../db/database';
import { accountFromJson, accountToJson, type Account } from '../models/account';
import { bankFromJson } from '../models/bank';
import { budgetFromDb, budgetSelectedCategoryIds, budgetToDb, type Budget } from '../models/budget';
import { categoryFromDb, isManagedCategory, normalizeFlow, type Category } from '../models/category';
import { loanDebtEntryFromDb, loanDebtRepaymentFromDb, type LoanDebtEntry } from '../models/loanDebt';
import { personAccountKindFromStorage, personTypeFromStorage } from '../models/person';
import { splitFromDb, splitLoanReference, SPLIT_LOAN_SEPARATOR } from '../models/split';
import { smsPatternFromJson } from '../models/smsPattern';
import { selectedCategoryIds, transactionFromJson, transactionToJson, type Transaction } from '../models/transaction';
import { accountRepository } from '../repositories/accountRepository';
import { bankRepository } from '../repositories/bankRepository';
import { budgetRepository } from '../repositories/budgetRepository';
import { cashLinkRepository } from '../repositories/cashLinkRepository';
import { categoryRepository } from '../repositories/categoryRepository';
import { failedParseRepository } from '../repositories/failedParseRepository';
import { loanDebtRepository, type LoanDebtRepaymentAllocation } from '../repositories/loanDebtRepository';
import { peopleGroupRepository } from '../repositories/peopleGroupRepository';
import { peopleRepository } from '../repositories/peopleRepository';
import { reimbursementRepository, type ReimbursementAllocationDraft } from '../repositories/reimbursementRepository';
import { sourceSmsRepository } from '../repositories/sourceSmsRepository';
import { splitRepository } from '../repositories/splitRepository';
import { transactionRepository } from '../repositories/transactionRepository';
import { userAccountRepository } from '../repositories/userAccountRepository';
import { autoCategorization } from './autoCategorization';
import { dataChanged } from './dataChanged';
import { smsConfigService } from './smsConfigService';

/**
 * v11 matches DataExportImportService.currentSchemaVersion in the Flutter app. v12 adds transaction
 * splits, cash-to-withdrawal links and person type/telegram; v13 adds people groups and person
 * email/address. Older readers ignore the extra keys.
 */
export const BACKUP_SCHEMA_VERSION = 13;
const MINIMUM_SCHEMA_VERSION = 1;

type Json = Record<string, any>;

export interface ImportSummary {
  accounts: number;
  transactions: number;
  budgets: number;
  categories: number;
}

function asList(data: Json, key: string, aliases: string[] = []): Json[] {
  for (const k of [key, ...aliases]) {
    const value = data[k];
    if (Array.isArray(value)) return value.filter((v) => v && typeof v === 'object') as Json[];
  }
  return [];
}

function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function asBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
  return fallback;
}

function categoryToJson(category: Category): Json {
  return {
    id: category.id ?? null,
    name: category.name,
    essential: category.essential,
    uncategorized: category.uncategorized,
    iconKey: category.iconKey ?? null,
    colorKey: category.colorKey ?? null,
    description: category.description ?? null,
    flow: category.flow,
    recurring: category.recurring,
    builtIn: category.builtIn,
    builtInKey: category.builtInKey ?? null,
  };
}

function budgetToJson(budget: Budget): Json {
  const ids = budgetSelectedCategoryIds(budget);
  return {
    ...budgetToDb(budget),
    id: budget.id ?? null,
    categoryIds: ids.length === 0 ? null : ids,
    rollover: budget.rollover,
    isActive: budget.isActive,
  };
}

function categoryKey(name: string, flow: string): string {
  return `${name.trim().toLowerCase()}|${normalizeFlow(flow)}`;
}

function budgetKey(budget: Budget): string {
  const ids = [...budgetSelectedCategoryIds(budget)].sort((a, b) => a - b);
  return [
    budget.name.trim().toLowerCase(),
    budget.type,
    budget.amount.toFixed(2),
    ids.join(','),
    budget.startDate,
    budget.endDate ?? '',
    budget.rollover ? '1' : '0',
    budget.alertThreshold.toFixed(2),
    budget.isActive ? '1' : '0',
    budget.timeFrame ?? '',
    budget.calendar,
  ].join('|');
}

async function existingTransactionReferences(): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ reference: string }>('SELECT reference FROM transactions');
  return new Set(rows.map((r) => r.reference));
}

export async function buildExportJson(): Promise<string> {
  const db = await getDb();
  const [accounts, banks, budgets, categories, userAccounts, transactions, failedParses, rules, dismissals] =
    await Promise.all([
      accountRepository.getAccounts(),
      bankRepository.getBanks(),
      budgetRepository.getAllBudgets(),
      categoryRepository.getCategories(),
      userAccountRepository.getUserAccounts(),
      transactionRepository.getTransactions(),
      failedParseRepository.getAll(),
      autoCategorization.getRules(),
      autoCategorization.getDismissals(),
    ]);
  const loanDebtEntries = (await db.getAllAsync<Json>('SELECT * FROM loan_debt_entries')).map(loanDebtEntryFromDb);
  const loanDebtRepayments = (await db.getAllAsync<Json>('SELECT * FROM loan_debt_repayments')).map(loanDebtRepaymentFromDb);
  const reimbursements = await reimbursementRepository.getAllocations();
  const sourceSms = await sourceSmsRepository.getForTransactionReferences(transactions.map((t) => t.reference));
  const [people, personAccounts, personTransactionLinks, transactionSplits, cashSpendLinks, peopleGroups] = await Promise.all([
    peopleRepository.getAllPeople(),
    peopleRepository.getAccounts(),
    peopleRepository.getLinks(),
    splitRepository.getAll(),
    cashLinkRepository.getAll(),
    peopleGroupRepository.getAllGroups(),
  ]);

  return JSON.stringify({
    schemaVersion: BACKUP_SCHEMA_VERSION,
    version: '1.0',
    exportDate: new Date().toISOString(),
    accounts: accounts.map(accountToJson),
    banks: banks.map((b) => ({ ...b })),
    budgets: budgets.map(budgetToJson),
    categories: categories.map(categoryToJson),
    userAccounts,
    transactions: transactions.map(transactionToJson),
    transactionSourceSms: sourceSms,
    failedParses,
    autoCategoryRules: rules,
    autoCategoryPromptDismissals: dismissals,
    loanDebtEntries,
    loanDebtRepayments,
    reimbursementAllocations: reimbursements,
    people,
    personAccounts,
    personTransactionLinks,
    peopleGroups: peopleGroups.map((g) => ({ id: g.id, name: g.name, memberIds: g.memberIds, createdAt: g.createdAt })),
    transactionSplits,
    cashSpendLinks,
  });
}

/** Writes a backup into the cache directory and opens the share sheet. */
export async function exportAndShareBackup(): Promise<string> {
  const json = await buildExportJson();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = new File(Paths.cache, `totals_backup_${stamp}.json`);
  if (file.exists) file.delete();
  file.create();
  file.write(json);
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: 'Export Totals backup' });
  }
  return file.uri;
}

/** Lets the user choose a backup file. Returns null when cancelled. */
export async function pickAndImportBackup(): Promise<ImportSummary | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['application/json', 'text/plain', '*/*'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled || result.assets.length === 0) return null;
  const text = await new File(result.assets[0].uri).text();
  return importBackupJson(text);
}

function parsePayload(jsonData: string): Json {
  let decoded: unknown;
  try {
    decoded = JSON.parse(jsonData);
  } catch {
    throw new Error('The selected file is not valid JSON.');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('Backup data must be a JSON object.');
  }
  const data = decoded as Json;
  const schemaVersion = asInt(data.schemaVersion) ?? asInt(data.schema_version) ?? MINIMUM_SCHEMA_VERSION;
  if (schemaVersion < MINIMUM_SCHEMA_VERSION) throw new Error(`Unsupported backup schema version: ${schemaVersion}`);
  if (schemaVersion > BACKUP_SCHEMA_VERSION) {
    throw new Error(
      `Backup schema v${schemaVersion} is newer than supported v${BACKUP_SCHEMA_VERSION}. Update the app and try again.`,
    );
  }
  return data;
}

async function importBanks(data: Json): Promise<void> {
  const raw = asList(data, 'banks');
  if (raw.length === 0) return;
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const json of raw) {
      const bank = bankFromJson(json);
      if (!Number.isFinite(bank.id) || !bank.name) continue;
      await db.runAsync(
        `INSERT OR REPLACE INTO banks (id, name, shortName, codes, image, maskPattern, uniformMasking, simBased, colors)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          bank.id,
          bank.name,
          bank.shortName,
          JSON.stringify(bank.codes),
          bank.image,
          bank.maskPattern ?? null,
          bank.uniformMasking == null ? null : bank.uniformMasking ? 1 : 0,
          bank.simBased == null ? null : bank.simBased ? 1 : 0,
          JSON.stringify(bank.colors ?? []),
        ],
      );
    }
  });
  bankRepository.invalidate();
}

/** Merges categories by builtInKey or name+flow; returns exported id -> local id. */
async function importCategories(data: Json): Promise<{ idMap: Map<number, number>; inserted: number }> {
  const idMap = new Map<number, number>();
  let inserted = 0;
  const raw = asList(data, 'categories');
  if (raw.length === 0) return { idMap, inserted };

  const db = await getDb();
  const byBuiltInKey = new Map<string, number>();
  const byNameFlow = new Map<string, number>();
  for (const category of await categoryRepository.getCategories()) {
    if (category.id == null) continue;
    if (category.builtInKey?.trim()) byBuiltInKey.set(category.builtInKey.trim(), category.id);
    byNameFlow.set(categoryKey(category.name, category.flow), category.id);
  }

  for (const json of raw) {
    const category = categoryFromDb(json);
    const exportId = asInt(json.id);
    const name = category.name.trim();
    if (!name) continue;
    const builtInKey = category.builtInKey?.trim() || null;
    const key = categoryKey(name, category.flow);

    let localId = (builtInKey ? byBuiltInKey.get(builtInKey) : undefined) ?? byNameFlow.get(key);
    if (localId === undefined) {
      const result = await db.runAsync(
        `INSERT OR IGNORE INTO categories (name, essential, uncategorized, iconKey, colorKey, description, flow, recurring, builtIn, builtInKey)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          name,
          category.essential ? 1 : 0,
          category.uncategorized ? 1 : 0,
          category.iconKey ?? null,
          category.colorKey ?? null,
          category.description ?? null,
          category.flow,
          category.recurring ? 1 : 0,
          builtInKey ? 1 : category.builtIn ? 1 : 0,
          builtInKey,
        ],
      );
      if (result.changes > 0) {
        localId = result.lastInsertRowId;
        inserted++;
      } else {
        const match = await db.getFirstAsync<{ id: number }>(
          'SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND flow = ? LIMIT 1',
          [name, category.flow],
        );
        localId = match?.id;
      }
      if (localId !== undefined) {
        if (builtInKey) byBuiltInKey.set(builtInKey, localId);
        byNameFlow.set(key, localId);
      }
    }
    if (exportId !== null && localId !== undefined) idMap.set(exportId, localId);
  }
  return { idMap, inserted };
}

async function importAccounts(data: Json): Promise<number> {
  const raw = asList(data, 'accounts');
  if (raw.length === 0) return 0;
  const db = await getDb();
  const rows = await db.getAllAsync<{ accountNumber: string; bank: number }>('SELECT accountNumber, bank FROM accounts');
  const existing = new Set(rows.map((r) => `${r.bank}|${r.accountNumber.trim()}`));
  const accounts: Account[] = [];
  for (const json of raw) {
    const account = accountFromJson(json);
    const accountNumber = account.accountNumber.trim();
    if (!accountNumber || !Number.isFinite(account.bank)) continue;
    const key = `${account.bank}|${accountNumber}`;
    // Local balances win for accounts that already exist.
    if (existing.has(key)) continue;
    existing.add(key);
    // Profiles are device-local, so imported accounts join the active profile.
    accounts.push({ ...account, id: null, accountNumber, profileId: null, smsSubscriptionId: null });
  }
  await accountRepository.saveAllAccounts(accounts);
  return accounts.length;
}

async function importUserAccounts(data: Json): Promise<void> {
  const raw = asList(data, 'userAccounts', ['user_accounts']);
  if (raw.length === 0) return;
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const json of raw) {
      const accountNumber = String(json.accountNumber ?? '').trim();
      const bankId = asInt(json.bankId);
      if (!accountNumber || bankId === null) continue;
      await db.runAsync(
        'INSERT OR IGNORE INTO user_accounts (accountNumber, bankId, accountHolderName, createdAt) VALUES (?, ?, ?, ?)',
        [accountNumber, bankId, String(json.accountHolderName ?? ''), String(json.createdAt ?? new Date().toISOString())],
      );
    }
  });
}

function remapIds(ids: number[], idMap: Map<number, number>, canMap: boolean): number[] {
  const out: number[] = [];
  for (const id of ids) {
    const mapped = idMap.get(id);
    if (mapped !== undefined) out.push(mapped);
    else if (!canMap) out.push(id);
  }
  return [...new Set(out)];
}

async function importTransactions(data: Json, idMap: Map<number, number>, canMap: boolean): Promise<number> {
  const raw = asList(data, 'transactions');
  if (raw.length === 0) return 0;
  const db = await getDb();
  const references = await existingTransactionReferences();
  const sourceRows = await db.getAllAsync<{ sourceType: string | null; sourceMessageId: string | null; sourceFingerprint: string | null }>(
    'SELECT sourceType, sourceMessageId, sourceFingerprint FROM transactions',
  );
  const messageIds = new Set(sourceRows.filter((r) => r.sourceMessageId).map((r) => `${r.sourceType}|${r.sourceMessageId}`));
  const fingerprints = new Set(
    sourceRows.filter((r) => r.sourceFingerprint).map((r) => `${r.sourceType}|${r.sourceFingerprint}`),
  );

  const transactions: Transaction[] = [];
  for (const json of raw) {
    let tx = transactionFromJson(json);
    const reference = tx.reference.trim();
    if (!reference || references.has(reference)) continue;
    const messageKey = tx.sourceMessageId ? `${tx.sourceType}|${tx.sourceMessageId}` : null;
    const fingerprintKey = tx.sourceFingerprint ? `${tx.sourceType}|${tx.sourceFingerprint}` : null;
    if ((messageKey && messageIds.has(messageKey)) || (fingerprintKey && fingerprints.has(fingerprintKey))) continue;

    const sourceIds = selectedCategoryIds(tx);
    if (sourceIds.length > 0) {
      const mapped = remapIds(sourceIds, idMap, canMap);
      const primary = tx.categoryId != null ? (idMap.get(tx.categoryId) ?? (canMap ? null : tx.categoryId)) : null;
      tx =
        mapped.length > 0
          ? { ...tx, categoryId: primary ?? mapped[0], categoryIds: mapped }
          : { ...tx, categoryId: null, categoryIds: null };
    }
    transactions.push({ ...tx, reference, profileId: null });
    references.add(reference);
    if (messageKey) messageIds.add(messageKey);
    if (fingerprintKey) fingerprints.add(fingerprintKey);
  }
  await transactionRepository.saveAllTransactions(transactions, { skipAutoCategorization: true });
  return transactions.length;
}

async function importSourceSms(data: Json): Promise<void> {
  const raw = asList(data, 'transactionSourceSms', ['transaction_source_sms', 'sourceSms', 'source_sms']);
  if (raw.length === 0) return;
  const references = await existingTransactionReferences();
  await sourceSmsRepository.upsertAll(
    raw
      .map((json) => ({
        transactionReference: String(json.transactionReference ?? '').trim(),
        body: String(json.body ?? ''),
        senderAddress: json.senderAddress ?? null,
        receivedAt: json.receivedAt ?? null,
        messageId: json.messageId == null ? null : String(json.messageId),
      }))
      .filter((m) => references.has(m.transactionReference)),
  );
}

async function importReimbursements(data: Json): Promise<void> {
  const raw = asList(data, 'reimbursementAllocations', ['reimbursement_allocations']);
  if (raw.length === 0) return;
  const references = await existingTransactionReferences();
  const byReimbursement = new Map<string, ReimbursementAllocationDraft[]>();
  for (const row of raw) {
    const reimbursement = String(row.reimbursementTransactionReference ?? '').trim();
    const expense = String(row.expenseTransactionReference ?? '').trim();
    const amount = Number(row.appliedAmount);
    if (!reimbursement || !expense || !Number.isFinite(amount) || amount <= 0) continue;
    if (!references.has(reimbursement) || !references.has(expense)) continue;
    const list = byReimbursement.get(reimbursement) ?? [];
    list.push({ expenseTransactionReference: expense, appliedAmount: amount });
    byReimbursement.set(reimbursement, list);
  }
  for (const [reference, allocations] of byReimbursement) {
    try {
      await reimbursementRepository.replaceForReimbursement({ reimbursementTransactionReference: reference, allocations });
    } catch (error) {
      // A stale relationship should not block the rest of the backup.
      if (__DEV__) console.warn('debug: Skipped reimbursement allocation during import', error);
    }
  }
}

async function importBudgets(data: Json, idMap: Map<number, number>, canMap: boolean): Promise<number> {
  const raw = asList(data, 'budgets');
  if (raw.length === 0) return 0;
  const existing = new Set((await budgetRepository.getAllBudgets()).map(budgetKey));
  let inserted = 0;
  for (const json of raw) {
    let budget = budgetFromDb(json);
    const sourceIds = budgetSelectedCategoryIds(budget);
    if (sourceIds.length > 0) {
      const mapped = sourceIds.map((id) => idMap.get(id)).filter((id): id is number => id !== undefined);
      if (mapped.length > 0) {
        const deduped = [...new Set(mapped)].sort((a, b) => a - b);
        budget = { ...budget, categoryId: deduped[0], categoryIds: deduped };
      } else if (canMap) {
        budget = { ...budget, categoryId: null, categoryIds: null };
      }
    }
    const key = budgetKey(budget);
    if (existing.has(key)) continue;
    await budgetRepository.insertBudget({ ...budget, id: null });
    existing.add(key);
    inserted++;
  }
  return inserted;
}

/**
 * Split loan entries are keyed "parent#split-<id>" and split ids change on import. Returns the new
 * reference, the reference itself when it is not a split loan, or null when its split was not imported.
 */
type LoanReferenceMap = (reference: string) => string | null;

async function importLoanDebts(data: Json, mapReference: LoanReferenceMap): Promise<void> {
  const db = await getDb();
  const entriesByReference = new Map<string, LoanDebtEntry>();
  const entriesRaw = asList(data, 'loanDebtEntries', ['loan_debt_entries']);
  if (entriesRaw.length > 0) {
    await db.withTransactionAsync(async () => {
      for (const json of entriesRaw) {
        const entry = loanDebtEntryFromDb(json);
        const reference = mapReference(entry.transactionReference.trim());
        const personName = entry.personName.trim();
        if (!reference || !personName) continue;
        entriesByReference.set(reference, { ...entry, transactionReference: reference });
        await db.runAsync(
          `INSERT OR REPLACE INTO loan_debt_entries
             (transactionReference, personName, direction, status, principalAmount, source, returnDate, resolvedAt, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            reference,
            personName,
            entry.direction,
            entry.status,
            entry.principalAmount ?? null,
            entry.source,
            entry.returnDate ?? null,
            entry.resolvedAt ?? null,
            entry.createdAt,
            entry.updatedAt,
          ],
        );
      }
    });
  }

  const repaymentsRaw = asList(data, 'loanDebtRepayments', ['loan_debt_repayments']);
  const allocationsByRepayment = new Map<string, LoanDebtRepaymentAllocation[]>();
  for (const json of repaymentsRaw) {
    const repayment = loanDebtRepaymentFromDb(json);
    const repaymentReference = repayment.repaymentTransactionReference.trim();
    const loanReference = mapReference(repayment.loanDebtTransactionReference.trim());
    if (!repaymentReference || !loanReference || repayment.appliedAmount <= 0) continue;
    const list = allocationsByRepayment.get(repaymentReference) ?? [];
    list.push({ loanDebtTransactionReference: loanReference, appliedAmount: repayment.appliedAmount });
    allocationsByRepayment.set(repaymentReference, list);
  }
  for (const [reference, allocations] of allocationsByRepayment) {
    const surplus = entriesByReference.get(reference);
    const isSurplus = surplus?.source === 'repayment_surplus' || surplus?.principalAmount != null;
    try {
      await loanDebtRepository.saveRepaymentFlow({
        repaymentTransactionReference: reference,
        allocations,
        surplusPersonName: isSurplus ? surplus?.personName : null,
        surplusDirection: isSurplus ? surplus?.direction : null,
        surplusPrincipalAmount: isSurplus ? surplus?.principalAmount : null,
        allowResolvedTargets: true,
      });
    } catch (error) {
      if (__DEV__) console.warn('debug: Skipped loan repayment during import', error);
    }
  }
  if (entriesRaw.length > 0 || repaymentsRaw.length > 0) {
    try {
      await loanDebtRepository.syncReturnReminders();
    } catch (error) {
      if (__DEV__) console.warn('debug: Failed to sync loan reminders after import', error);
    }
  }
}

/** Merges people by name; aliases and manual links follow the remapped person ids. Returns exported id -> local id. */
async function importPeople(data: Json): Promise<Map<number, number>> {
  const peopleRaw = asList(data, 'people');
  const accountsRaw = asList(data, 'personAccounts', ['person_accounts']);
  const linksRaw = asList(data, 'personTransactionLinks', ['person_transaction_links']);
  const idMap = new Map<number, number>();
  if (peopleRaw.length === 0) return idMap;

  const byName = new Map<string, number>();
  for (const person of await peopleRepository.getPeople()) byName.set(person.name.trim().toLowerCase(), person.id);

  for (const json of peopleRaw) {
    const exportId = asInt(json.id);
    const name = String(json.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name) continue;
    const key = name.toLowerCase();
    let localId = byName.get(key);
    if (localId === undefined) {
      try {
        localId = await peopleRepository.createPerson({
          name,
          phone: json.phone == null ? null : String(json.phone),
          note: json.note == null ? null : String(json.note),
          type: personTypeFromStorage(json.type),
          telegram: json.telegram == null ? null : String(json.telegram),
          email: json.email == null ? null : String(json.email),
          address: json.address == null ? null : String(json.address),
        });
        byName.set(key, localId);
      } catch (error) {
        if (__DEV__) console.warn('debug: Skipped person during import', error);
        continue;
      }
    }
    if (exportId !== null) idMap.set(exportId, localId);
  }

  for (const json of accountsRaw) {
    const personId = idMap.get(asInt(json.personId) ?? -1);
    const identifier = String(json.identifier ?? '').trim();
    if (personId === undefined || !identifier) continue;
    try {
      await peopleRepository.addAccount({
        personId,
        bankId: asInt(json.bankId),
        identifier,
        kind: personAccountKindFromStorage(json.kind),
      });
    } catch (error) {
      if (__DEV__) console.warn('debug: Skipped person alias during import', error);
    }
  }

  const references = await existingTransactionReferences();
  for (const json of linksRaw) {
    const reference = String(json.transactionReference ?? '').trim();
    if (!reference || !references.has(reference)) continue;
    const exportPersonId = asInt(json.personId);
    if (exportPersonId === null) {
      await peopleRepository.setTransactionPerson(reference, null);
      continue;
    }
    const personId = idMap.get(exportPersonId);
    if (personId !== undefined) await peopleRepository.setTransactionPerson(reference, personId);
  }
  return idMap;
}

/** Merges groups by name; a group that exists locally gains the imported members. */
async function importPeopleGroups(data: Json, personIdMap: Map<number, number>): Promise<void> {
  const groupsRaw = asList(data, 'peopleGroups', ['people_groups']);
  if (groupsRaw.length === 0) return;
  const existing = new Map((await peopleGroupRepository.getGroups()).map((g) => [g.name.trim().toLowerCase(), g]));
  for (const json of groupsRaw) {
    const name = String(json.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name) continue;
    const members = (Array.isArray(json.memberIds) ? json.memberIds : [])
      .map((id: unknown) => personIdMap.get(asInt(id) ?? -1))
      .filter((id: number | undefined): id is number => id !== undefined);
    try {
      const local = existing.get(name.toLowerCase());
      if (local) await peopleGroupRepository.updateGroup(local.id, local.name, [...local.memberIds, ...members]);
      else await peopleGroupRepository.createGroup(name, members);
    } catch (error) {
      if (__DEV__) console.warn('debug: Skipped people group during import', error);
    }
  }
}

/**
 * Restores split parts for transactions that have none locally (local splits win). Returns the
 * mapping for the split loan entries, whose references embed the split id.
 */
async function importSplits(
  data: Json,
  categoryIdMap: Map<number, number>,
  canMap: boolean,
  personIdMap: Map<number, number>,
): Promise<LoanReferenceMap> {
  const raw = asList(data, 'transactionSplits', ['transaction_splits']);
  const referenceMap = new Map<string, string | null>();
  const mapReference: LoanReferenceMap = (reference) => {
    if (!reference.includes(SPLIT_LOAN_SEPARATOR)) return reference;
    // Split loans without a matching split row (or from a skipped parent) are dropped.
    return referenceMap.get(reference) ?? null;
  };
  if (raw.length === 0) return (reference) => reference;

  const references = await existingTransactionReferences();
  const hasLocalSplits = new Set((await splitRepository.getAll()).map((s) => s.parentReference));
  for (const json of raw) {
    const split = splitFromDb(json);
    const parent = split.parentReference.trim();
    const oldLoanReference = splitLoanReference(parent, split.id);
    if (!parent || !references.has(parent) || hasLocalSplits.has(parent) || split.amount <= 0) {
      referenceMap.set(oldLoanReference, null);
      continue;
    }
    const categoryId =
      split.categoryId == null ? null : (categoryIdMap.get(split.categoryId) ?? (canMap ? null : split.categoryId));
    const personId = split.personId == null ? null : (personIdMap.get(split.personId) ?? null);
    const id = await splitRepository.insertRaw({ ...split, parentReference: parent, categoryId, personId });
    referenceMap.set(oldLoanReference, splitLoanReference(parent, id));
  }
  return mapReference;
}

async function importCashLinks(data: Json): Promise<void> {
  const raw = asList(data, 'cashSpendLinks', ['cash_spend_links']);
  if (raw.length === 0) return;
  const references = await existingTransactionReferences();
  const linked = new Set((await cashLinkRepository.getAll()).map((l) => l.cashReference));
  for (const json of raw) {
    const cash = String(json.cashReference ?? '').trim();
    const withdrawal = String(json.withdrawalReference ?? '').trim();
    if (!cash || !withdrawal || linked.has(cash) || !references.has(cash) || !references.has(withdrawal)) continue;
    await cashLinkRepository.link(cash, withdrawal);
    linked.add(cash);
  }
}

async function importAutoCategorization(data: Json, idMap: Map<number, number>, canMap: boolean): Promise<void> {
  const db = await getDb();
  const categoriesById = new Map<number, Category>();
  for (const category of await categoryRepository.getCategories()) {
    if (category.id != null) categoriesById.set(category.id, category);
  }
  const resolveCategory = (sourceId: number | null): number | null => {
    if (sourceId === null || sourceId === 0) return null;
    const mapped = idMap.get(sourceId);
    if (mapped === undefined && canMap) return null;
    const resolved = mapped ?? sourceId;
    const category = categoriesById.get(resolved);
    return category && !isManagedCategory(category) ? resolved : null;
  };
  const insertRule = (counterparty: string, flow: string, categoryId: number, isPrimary: boolean, createdAt: string) =>
    db.runAsync(
      `INSERT OR REPLACE INTO auto_category_rules (counterparty, normalizedCounterparty, flow, categoryId, isPrimary, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [counterparty, autoCategorization.normalizeCounterparty(counterparty), normalizeFlow(flow), categoryId, isPrimary ? 1 : 0, createdAt],
    );

  const rules = asList(data, 'autoCategoryRules', ['auto_category_rules']);
  const dismissals = asList(data, 'autoCategoryPromptDismissals', ['auto_category_prompt_dismissals']);
  const mappings = asList(data, 'receiverCategoryMappings', ['receiver_category_mappings']);
  if (rules.length === 0 && dismissals.length === 0 && mappings.length === 0) return;

  await db.withTransactionAsync(async () => {
    for (const rule of rules) {
      const counterparty = String(rule.counterparty ?? '').trim();
      const categoryId = resolveCategory(asInt(rule.categoryId));
      if (!counterparty || categoryId === null) continue;
      await insertRule(counterparty, String(rule.flow ?? ''), categoryId, asBool(rule.isPrimary), String(rule.createdAt ?? new Date().toISOString()));
    }
    for (const dismissal of dismissals) {
      const counterparty = String(dismissal.counterparty ?? '').trim();
      if (!counterparty) continue;
      await db.runAsync(
        `INSERT OR REPLACE INTO auto_category_prompt_dismissals (counterparty, normalizedCounterparty, flow, createdAt)
         VALUES (?, ?, ?, ?)`,
        [
          counterparty,
          autoCategorization.normalizeCounterparty(counterparty),
          normalizeFlow(dismissal.flow),
          String(dismissal.createdAt ?? new Date().toISOString()),
        ],
      );
    }
    // Legacy receiver mappings become flow-aware rules.
    for (const mapping of mappings) {
      const counterparty = String(mapping.accountNumber ?? '').trim();
      const categoryId = resolveCategory(asInt(mapping.categoryId));
      if (!counterparty || categoryId === null) continue;
      const flow = categoriesById.get(categoryId)?.flow ?? 'expense';
      await insertRule(counterparty, flow, categoryId, true, String(mapping.createdAt ?? new Date().toISOString()));
    }
  });
}

async function importFailedParses(data: Json): Promise<void> {
  const raw = asList(data, 'failedParses', ['failed_parses']);
  if (raw.length === 0) return;
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const json of raw) {
      const values: SqlValue[] = [
        String(json.address ?? ''),
        String(json.body ?? ''),
        String(json.reason ?? ''),
        String(json.timestamp ?? new Date().toISOString()),
      ];
      await db.runAsync('INSERT INTO failed_parses (address, body, reason, timestamp) VALUES (?, ?, ?, ?)', values);
    }
  });
}

async function importSmsPatterns(data: Json): Promise<void> {
  const raw = asList(data, 'smsPatterns', ['sms_patterns']);
  if (raw.length === 0) return;
  await smsConfigService.savePatterns(raw.map(smsPatternFromJson));
}

/** Appends a Totals backup (Flutter or React Native) to local data. */
export async function importBackupJson(jsonData: string): Promise<ImportSummary> {
  const data = parsePayload(jsonData);
  const canMap = asList(data, 'categories').length > 0;

  await importBanks(data);
  const { idMap, inserted: categories } = await importCategories(data);
  const accounts = await importAccounts(data);
  await importUserAccounts(data);
  const transactions = await importTransactions(data, idMap, canMap);
  await importSourceSms(data);
  await importReimbursements(data);
  const budgets = await importBudgets(data, idMap, canMap);
  const personIdMap = await importPeople(data);
  await importPeopleGroups(data, personIdMap);
  const mapLoanReference = await importSplits(data, idMap, canMap, personIdMap);
  await importLoanDebts(data, mapLoanReference);
  await importCashLinks(data);
  await importAutoCategorization(data, idMap, canMap);
  await importFailedParses(data);
  await importSmsPatterns(data);

  dataChanged.notify();
  return { accounts, transactions, budgets, categories };
}
