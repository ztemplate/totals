import { create } from 'zustand';
import type { Account } from '../models/account';
import type { Bank } from '../models/bank';
import type { Category } from '../models/category';
import type { Profile } from '../models/misc';
import type { TransactionSplit } from '../models/split';
import type { Transaction } from '../models/transaction';
import { accountRepository } from '../repositories/accountRepository';
import { bankRepository } from '../repositories/bankRepository';
import { cashLinkRepository, type CashSpendLink } from '../repositories/cashLinkRepository';
import { categoryRepository } from '../repositories/categoryRepository';
import { profileRepository } from '../repositories/profileRepository';
import { reimbursementRepository } from '../repositories/reimbursementRepository';
import { splitRepository } from '../repositories/splitRepository';
import { transactionRepository } from '../repositories/transactionRepository';
import { dataChanged } from '../services/dataChanged';
import { buildSelfTransferReferences, manualSelfCategoryIds } from '../services/spendingSummary';
import { groupSplitsByParent } from '../utils/transactionSplits';

interface DataState {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  transactions: Transaction[];
  accounts: Account[];
  banks: Bank[];
  /** Banks plus the synthetic cash wallet. */
  banksWithCash: Bank[];
  categories: Category[];
  profiles: Profile[];
  activeProfileId: number | null;
  selfTransferReferences: Set<string>;
  selfCategoryIds: Set<number>;
  /** Expense reference -> amount reimbursed by linked credits. */
  reimbursedByExpense: Map<string, number>;
  /** Parent transaction reference -> its split parts. */
  splitsByParent: Map<string, TransactionSplit[]>;
  /** Cash spending tied to ATM withdrawals. */
  cashLinks: CashSpendLink[];
  /** Monotonic counter screens can depend on to reload derived data. */
  version: number;
  refresh(): Promise<void>;
  switchProfile(id: number): Promise<void>;
}

let inFlight: Promise<void> | null = null;
let queued = false;

export const useData = create<DataState>((set, get) => ({
  loaded: false,
  loading: false,
  error: null,
  transactions: [],
  accounts: [],
  banks: [],
  banksWithCash: [],
  categories: [],
  profiles: [],
  activeProfileId: null,
  selfTransferReferences: new Set(),
  selfCategoryIds: new Set(),
  reimbursedByExpense: new Map(),
  splitsByParent: new Map(),
  cashLinks: [],
  version: 0,

  async refresh() {
    // Coalesce bursts of change notifications (e.g. a batch SMS sync) into at most one extra reload.
    if (inFlight) {
      queued = true;
      return inFlight;
    }
    inFlight = (async () => {
      set({ loading: true });
      try {
        do {
          queued = false;
          const [transactions, accounts, banks, categories, profiles, activeProfileId] = await Promise.all([
            transactionRepository.getTransactions(),
            accountRepository.getAccounts(),
            bankRepository.getBanks(),
            categoryRepository.getCategories(),
            profileRepository.getProfiles(),
            profileRepository.getActiveProfileId(),
          ]);
          const reimbursedByExpense = await reimbursementRepository.getAppliedTotalsForExpenses(
            transactions.filter((t) => t.type === 'DEBIT').map((t) => t.reference),
          );
          const banksWithCash = await bankRepository.getBanksWithCash();
          const [splits, cashLinks] = await Promise.all([splitRepository.getAll(), cashLinkRepository.getAll()]);
          set({
            loaded: true,
            error: null,
            transactions,
            accounts,
            banks,
            banksWithCash,
            categories,
            profiles,
            activeProfileId,
            selfTransferReferences: buildSelfTransferReferences({ transactions, banks, accounts }),
            selfCategoryIds: manualSelfCategoryIds(categories),
            reimbursedByExpense,
            splitsByParent: groupSplitsByParent(splits),
            cashLinks,
            version: get().version + 1,
          });
        } while (queued);
      } catch (error) {
        if (__DEV__) console.warn('debug: Failed to load data', error);
        set({ error: error instanceof Error ? error.message : String(error) });
      } finally {
        set({ loading: false });
        inFlight = null;
      }
    })();
    return inFlight;
  },

  async switchProfile(id) {
    await profileRepository.setActiveProfile(id);
    dataChanged.notify();
  },
}));

dataChanged.subscribe(() => {
  void useData.getState().refresh();
});

/** Call after a UI-initiated write so every screen (and the store) reloads. */
export function notifyDataChanged(): void {
  dataChanged.notify();
}
