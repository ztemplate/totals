import * as SQLite from 'expo-sqlite';
import { BUILT_IN_CATEGORIES } from '../models/category';
import { BUNDLED_BANKS } from '../data/banks';

export const DB_NAME = 'totals.db';
export const SCHEMA_VERSION = 36;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  essential INTEGER NOT NULL DEFAULT 0,
  uncategorized INTEGER NOT NULL DEFAULT 0,
  iconKey TEXT,
  colorKey TEXT,
  description TEXT,
  flow TEXT NOT NULL DEFAULT 'expense',
  recurring INTEGER NOT NULL DEFAULT 0,
  builtIn INTEGER NOT NULL DEFAULT 0,
  builtInKey TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_name_flow ON categories(name COLLATE NOCASE, flow);
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_builtInKey ON categories(builtInKey) WHERE builtInKey IS NOT NULL;

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  amount REAL NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  creditor TEXT,
  receiver TEXT,
  note TEXT,
  time TEXT,
  status TEXT,
  currentBalance TEXT,
  serviceCharge REAL,
  vat REAL,
  bankId INTEGER,
  type TEXT,
  transactionLink TEXT,
  accountNumber TEXT,
  ownerAccountNumber TEXT,
  categoryId INTEGER,
  categoryIds TEXT,
  year INTEGER,
  month INTEGER,
  day INTEGER,
  week INTEGER,
  profileId INTEGER,
  sourceType TEXT,
  sourceMessageId TEXT,
  sourceFingerprint TEXT,
  sourceSubscriptionId INTEGER,
  ownerAssignmentSource TEXT
);

CREATE TABLE IF NOT EXISTS failed_parses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL,
  body TEXT NOT NULL,
  reason TEXT NOT NULL,
  timestamp TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sms_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bankId INTEGER NOT NULL,
  senderId TEXT NOT NULL,
  regex TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT,
  refRequired INTEGER,
  hasAccount INTEGER
);

CREATE TABLE IF NOT EXISTS banks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  shortName TEXT NOT NULL,
  codes TEXT NOT NULL,
  image TEXT NOT NULL,
  maskPattern INTEGER,
  uniformMasking INTEGER,
  simBased INTEGER,
  colors TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  accountNumber TEXT NOT NULL,
  bank INTEGER NOT NULL,
  balance REAL NOT NULL DEFAULT 0,
  accountHolderName TEXT NOT NULL,
  settledBalance REAL,
  pendingCredit REAL,
  profileId INTEGER,
  smsSubscriptionId INTEGER,
  includeInTotals INTEGER NOT NULL DEFAULT 1,
  isDormant INTEGER NOT NULL DEFAULT 0,
  isDefault INTEGER NOT NULL DEFAULT 0,
  UNIQUE(accountNumber, bank)
);

CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT
);

CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  categoryId INTEGER,
  categoryIds TEXT,
  startDate TEXT NOT NULL,
  endDate TEXT,
  rollover INTEGER NOT NULL DEFAULT 0,
  alertThreshold REAL NOT NULL DEFAULT 80.0,
  isActive INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL,
  updatedAt TEXT,
  timeFrame TEXT,
  calendar TEXT NOT NULL DEFAULT 'gregorian'
);

CREATE TABLE IF NOT EXISTS receiver_category_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  accountNumber TEXT NOT NULL,
  categoryId INTEGER NOT NULL,
  accountType TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  UNIQUE(accountNumber, accountType)
);
CREATE INDEX IF NOT EXISTS idx_receiver_mappings_accountNumber ON receiver_category_mappings(accountNumber);
CREATE INDEX IF NOT EXISTS idx_receiver_mappings_categoryId ON receiver_category_mappings(categoryId);

CREATE TABLE IF NOT EXISTS auto_category_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  counterparty TEXT NOT NULL,
  normalizedCounterparty TEXT NOT NULL,
  flow TEXT NOT NULL,
  categoryId INTEGER NOT NULL,
  isPrimary INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  UNIQUE(normalizedCounterparty, flow, categoryId)
);
CREATE INDEX IF NOT EXISTS idx_auto_category_rules_flow ON auto_category_rules(flow);
CREATE INDEX IF NOT EXISTS idx_auto_category_rules_categoryId ON auto_category_rules(categoryId);
CREATE INDEX IF NOT EXISTS idx_auto_category_rules_counterparty_flow ON auto_category_rules(normalizedCounterparty, flow);

CREATE TABLE IF NOT EXISTS auto_category_prompt_dismissals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  counterparty TEXT NOT NULL,
  normalizedCounterparty TEXT NOT NULL,
  flow TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  UNIQUE(normalizedCounterparty, flow)
);
CREATE INDEX IF NOT EXISTS idx_auto_category_prompt_dismissals_flow ON auto_category_prompt_dismissals(flow);

CREATE TABLE IF NOT EXISTS user_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  accountNumber TEXT NOT NULL,
  bankId INTEGER NOT NULL,
  accountHolderName TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  UNIQUE(accountNumber, bankId)
);

CREATE INDEX IF NOT EXISTS idx_transactions_reference ON transactions(reference);
CREATE INDEX IF NOT EXISTS idx_transactions_bankId ON transactions(bankId);
CREATE INDEX IF NOT EXISTS idx_transactions_time ON transactions(time);
CREATE INDEX IF NOT EXISTS idx_transactions_categoryId ON transactions(categoryId);
CREATE INDEX IF NOT EXISTS idx_transactions_year_month ON transactions(year, month);
CREATE INDEX IF NOT EXISTS idx_transactions_year_month_day ON transactions(year, month, day);
CREATE INDEX IF NOT EXISTS idx_transactions_bank_year_month ON transactions(bankId, year, month);
CREATE INDEX IF NOT EXISTS idx_failed_parses_timestamp ON failed_parses(timestamp);
CREATE INDEX IF NOT EXISTS idx_sms_patterns_bankId ON sms_patterns(bankId);
CREATE INDEX IF NOT EXISTS idx_accounts_bank ON accounts(bank);
CREATE INDEX IF NOT EXISTS idx_accounts_accountNumber ON accounts(accountNumber);
CREATE INDEX IF NOT EXISTS idx_budgets_type ON budgets(type);
CREATE INDEX IF NOT EXISTS idx_budgets_categoryId ON budgets(categoryId);
CREATE INDEX IF NOT EXISTS idx_budgets_isActive ON budgets(isActive);
CREATE INDEX IF NOT EXISTS idx_budgets_calendar ON budgets(calendar);
CREATE INDEX IF NOT EXISTS idx_budgets_startDate ON budgets(startDate);
CREATE INDEX IF NOT EXISTS idx_accounts_profileId ON accounts(profileId);
CREATE INDEX IF NOT EXISTS idx_transactions_profileId ON transactions(profileId);
CREATE INDEX IF NOT EXISTS idx_transactions_sourceMessageId ON transactions(sourceType, sourceMessageId);
CREATE INDEX IF NOT EXISTS idx_transactions_sourceFingerprint ON transactions(sourceType, sourceFingerprint);
CREATE INDEX IF NOT EXISTS idx_transactions_ownerAccount ON transactions(profileId, bankId, ownerAccountNumber, time);
CREATE INDEX IF NOT EXISTS idx_transactions_sourceSubscriptionId ON transactions(sourceType, sourceSubscriptionId);
CREATE INDEX IF NOT EXISTS idx_accounts_smsSubscriptionId ON accounts(bank, smsSubscriptionId);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_one_default_per_bank ON accounts(bank, COALESCE(profileId, -1)) WHERE isDefault = 1;
CREATE INDEX IF NOT EXISTS idx_user_accounts_bankId ON user_accounts(bankId);
CREATE INDEX IF NOT EXISTS idx_user_accounts_accountNumber ON user_accounts(accountNumber);

CREATE TABLE IF NOT EXISTS loan_debt_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transactionReference TEXT NOT NULL UNIQUE,
  personName TEXT NOT NULL,
  direction TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  principalAmount REAL,
  source TEXT NOT NULL DEFAULT 'transaction',
  returnDate TEXT,
  resolvedAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loan_debt_entries_personName ON loan_debt_entries(personName COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_loan_debt_entries_direction ON loan_debt_entries(direction);
CREATE INDEX IF NOT EXISTS idx_loan_debt_entries_status ON loan_debt_entries(status);
CREATE INDEX IF NOT EXISTS idx_loan_debt_entries_returnDate ON loan_debt_entries(returnDate);

CREATE TABLE IF NOT EXISTS loan_debt_repayments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repaymentTransactionReference TEXT NOT NULL,
  loanDebtTransactionReference TEXT NOT NULL,
  appliedAmount REAL NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(repaymentTransactionReference, loanDebtTransactionReference)
);
CREATE INDEX IF NOT EXISTS idx_loan_debt_repayments_loan ON loan_debt_repayments(loanDebtTransactionReference);
CREATE INDEX IF NOT EXISTS idx_loan_debt_repayments_repayment ON loan_debt_repayments(repaymentTransactionReference);

CREATE TABLE IF NOT EXISTS reimbursement_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reimbursementTransactionReference TEXT NOT NULL,
  expenseTransactionReference TEXT NOT NULL,
  appliedAmount REAL NOT NULL CHECK(appliedAmount > 0),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reimbursement_allocations_reimbursement ON reimbursement_allocations(reimbursementTransactionReference);
CREATE INDEX IF NOT EXISTS idx_reimbursement_allocations_expense ON reimbursement_allocations(expenseTransactionReference);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reimbursement_allocations_pair ON reimbursement_allocations(reimbursementTransactionReference, expenseTransactionReference);
CREATE TRIGGER IF NOT EXISTS trg_reimbursement_allocations_tx_delete
AFTER DELETE ON transactions
BEGIN
  DELETE FROM reimbursement_allocations
  WHERE reimbursementTransactionReference = OLD.reference
     OR expenseTransactionReference = OLD.reference;
END;

CREATE TABLE IF NOT EXISTS transaction_source_sms (
  transactionReference TEXT PRIMARY KEY NOT NULL,
  body TEXT NOT NULL,
  senderAddress TEXT,
  receivedAt TEXT,
  messageId TEXT
);
CREATE TRIGGER IF NOT EXISTS trg_transaction_source_sms_tx_delete
AFTER DELETE ON transactions
BEGIN
  DELETE FROM transaction_source_sms WHERE transactionReference = OLD.reference;
END;

CREATE TABLE IF NOT EXISTS shared_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  members TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT
);

CREATE TABLE IF NOT EXISTS shared_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  groupId INTEGER NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  paidBy TEXT NOT NULL,
  splits TEXT NOT NULL,
  transactionReference TEXT,
  date TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  settled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_shared_expenses_groupId ON shared_expenses(groupId);

CREATE TABLE IF NOT EXISTS shared_settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  groupId INTEGER NOT NULL,
  fromMember TEXT NOT NULL,
  toMember TEXT NOT NULL,
  amount REAL NOT NULL,
  date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shared_settlements_groupId ON shared_settlements(groupId);

CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  note TEXT,
  type TEXT,
  telegram TEXT,
  profileId INTEGER,
  createdAt TEXT NOT NULL,
  updatedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_people_profileId ON people(profileId);

CREATE TABLE IF NOT EXISTS person_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  personId INTEGER NOT NULL,
  bankId INTEGER,
  identifier TEXT NOT NULL,
  normalizedIdentifier TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'name',
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_person_accounts_personId ON person_accounts(personId);
CREATE INDEX IF NOT EXISTS idx_person_accounts_identifier ON person_accounts(normalizedIdentifier);

CREATE TABLE IF NOT EXISTS person_transaction_links (
  transactionReference TEXT PRIMARY KEY NOT NULL,
  personId INTEGER,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_person_transaction_links_personId ON person_transaction_links(personId);
CREATE TRIGGER IF NOT EXISTS trg_person_transaction_links_tx_delete
AFTER DELETE ON transactions
BEGIN
  DELETE FROM person_transaction_links WHERE transactionReference = OLD.reference;
END;

CREATE TABLE IF NOT EXISTS transaction_splits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parentReference TEXT NOT NULL,
  amount REAL NOT NULL,
  kind TEXT NOT NULL DEFAULT 'expense',
  categoryId INTEGER,
  personId INTEGER,
  note TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_transaction_splits_parent ON transaction_splits(parentReference);
CREATE TRIGGER IF NOT EXISTS trg_transaction_splits_tx_delete
AFTER DELETE ON transactions
BEGIN
  DELETE FROM loan_debt_entries WHERE substr(transactionReference, 1, length(OLD.reference) + 7) = OLD.reference || '#split-';
  DELETE FROM transaction_splits WHERE parentReference = OLD.reference;
END;

CREATE TABLE IF NOT EXISTS cash_spend_links (
  cashReference TEXT PRIMARY KEY NOT NULL,
  withdrawalReference TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cash_spend_links_withdrawal ON cash_spend_links(withdrawalReference);
CREATE TRIGGER IF NOT EXISTS trg_cash_spend_links_tx_delete
AFTER DELETE ON transactions
BEGIN
  DELETE FROM cash_spend_links WHERE cashReference = OLD.reference OR withdrawalReference = OLD.reference;
END;

CREATE TABLE IF NOT EXISTS people_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  profileId INTEGER,
  createdAt TEXT NOT NULL,
  updatedAt TEXT
);
CREATE TABLE IF NOT EXISTS people_group_members (
  groupId INTEGER NOT NULL,
  personId INTEGER NOT NULL,
  PRIMARY KEY (groupId, personId)
);
`;

/** Columns added after a table was first created. CREATE TABLE IF NOT EXISTS won't add them to old installs. */
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: 'people', column: 'type', definition: 'TEXT' },
  { table: 'people', column: 'telegram', definition: 'TEXT' },
  { table: 'people', column: 'email', definition: 'TEXT' },
  { table: 'people', column: 'address', definition: 'TEXT' },
];

async function addMissingColumns(db: SQLite.SQLiteDatabase): Promise<void> {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const columns = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
    if (!columns.some((c) => c.name === column)) {
      await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = open().catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

async function open(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  await db.execAsync('PRAGMA journal_mode = WAL;');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const version = row?.user_version ?? 0;
  if (version < SCHEMA_VERSION) {
    await db.withTransactionAsync(async () => {
      await db.execAsync(SCHEMA);
      await addMissingColumns(db);
      await seedBuiltInCategories(db);
      await seedBanks(db);
      await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }
  return db;
}

async function seedBuiltInCategories(db: SQLite.SQLiteDatabase): Promise<void> {
  for (const c of BUILT_IN_CATEGORIES) {
    await db.runAsync(
      `INSERT OR IGNORE INTO categories (name, essential, uncategorized, iconKey, colorKey, description, flow, recurring, builtIn, builtInKey)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 1, ?)`,
      [c.name, c.essential ? 1 : 0, c.uncategorized ? 1 : 0, c.iconKey ?? null, c.description ?? null, c.flow, c.recurring ? 1 : 0, c.builtInKey],
    );
    await db.runAsync(
      `UPDATE categories
       SET iconKey = COALESCE(NULLIF(iconKey, ''), ?),
           description = COALESCE(NULLIF(description, ''), ?),
           builtIn = 1,
           uncategorized = ?
       WHERE builtInKey = ?`,
      [c.iconKey ?? null, c.description ?? null, c.uncategorized ? 1 : 0, c.builtInKey],
    );
  }
}

export async function seedBanks(db: SQLite.SQLiteDatabase): Promise<void> {
  for (const bank of BUNDLED_BANKS) {
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
}

/** Wipes all user data and reseeds defaults. */
export async function resetDatabase(): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const table of [
      'transactions',
      'failed_parses',
      'accounts',
      'budgets',
      'receiver_category_mappings',
      'auto_category_rules',
      'auto_category_prompt_dismissals',
      'user_accounts',
      'loan_debt_entries',
      'loan_debt_repayments',
      'reimbursement_allocations',
      'transaction_source_sms',
      'shared_groups',
      'shared_expenses',
      'shared_settlements',
      'people',
      'person_accounts',
      'person_transaction_links',
      'transaction_splits',
      'cash_spend_links',
      'people_groups',
      'people_group_members',
    ]) {
      await db.runAsync(`DELETE FROM ${table}`);
    }
    await db.runAsync('DELETE FROM categories WHERE builtIn = 0');
    await seedBuiltInCategories(db);
  });
}

export type SqlValue = string | number | null;

export function boolToInt(value: boolean | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}
