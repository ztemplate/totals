export type CategoryFlow = 'income' | 'expense';

export interface Category {
  id?: number | null;
  name: string;
  essential: boolean;
  uncategorized: boolean;
  iconKey?: string | null;
  colorKey?: string | null;
  description?: string | null;
  flow: CategoryFlow;
  recurring: boolean;
  builtIn: boolean;
  builtInKey?: string | null;
}

export function normalizeFlow(raw: string | null | undefined): CategoryFlow {
  return (raw ?? '').trim().toLowerCase() === 'income' ? 'income' : 'expense';
}

export function categoryFromDb(row: Record<string, any>): Category {
  let iconKey: string | null = row.iconKey ?? null;
  let colorKey: string | null = row.colorKey ?? null;
  // Legacy rows stored the colour in iconKey as `color:<key>`.
  if (iconKey && iconKey.startsWith('color:')) {
    colorKey = colorKey ?? iconKey.substring('color:'.length);
    iconKey = 'more_horiz';
  }
  return {
    id: row.id ?? null,
    name: String(row.name ?? ''),
    essential: row.essential === 1 || row.essential === true,
    uncategorized: row.uncategorized === 1 || row.uncategorized === true,
    iconKey,
    colorKey,
    description: row.description ?? null,
    flow: normalizeFlow(row.flow),
    recurring: row.recurring === 1 || row.recurring === true,
    builtIn: row.builtIn === 1 || row.builtIn === true,
    builtInKey: row.builtInKey ?? null,
  };
}

export function categoryToDb(category: Category): Record<string, unknown> {
  return {
    name: category.name,
    essential: category.essential ? 1 : 0,
    uncategorized: category.uncategorized ? 1 : 0,
    iconKey: category.iconKey ?? null,
    colorKey: category.colorKey ?? null,
    description: category.description ?? null,
    flow: category.flow,
    recurring: category.recurring ? 1 : 0,
    builtIn: category.builtIn ? 1 : 0,
    builtInKey: category.builtInKey ?? null,
  };
}

export function categoryTypeLabel(category: Category): string {
  if (category.uncategorized) return 'Uncategorized';
  if (category.flow === 'income') return category.essential ? 'Main income' : 'Side income';
  return category.essential ? 'Essential' : 'Non-essential';
}

type BuiltIn = Omit<Category, 'id' | 'colorKey' | 'builtIn'> & { builtInKey: string };

const b = (
  name: string,
  essential: boolean,
  iconKey: string,
  description: string,
  flow: CategoryFlow,
  recurring: boolean,
  builtInKey: string,
  uncategorized = false,
): BuiltIn => ({ name, essential, uncategorized, iconKey, description, flow, recurring, builtInKey });

export const BUILT_IN_CATEGORIES: BuiltIn[] = [
  b('Salary', true, 'payments', 'Income from salary or wages', 'income', true, 'income_salary'),
  b('Business', true, 'payments', 'Income from a business or shop', 'income', true, 'income_business'),
  b('Side hustle', false, 'payments', 'Income from side jobs or freelance work', 'income', true, 'income_side_hustle'),
  b('Bonus', false, 'payments', 'Bonus, commission, or performance pay', 'income', false, 'income_bonus'),
  b('Refund', false, 'payments', 'Money returned by a merchant for a purchase', 'income', false, 'income_refund'),
  b('Reimbursement', false, 'payments', 'Money someone paid back toward an expense', 'income', false, 'income_reimbursement'),
  b('Gifts given', false, 'gift', 'Gifts you give to others', 'expense', false, 'expense_gifts_given'),
  b('Gifts received', false, 'gift', 'Gifts you receive from others', 'income', false, 'income_gifts_received'),
  b('Debt', false, 'request_quote', 'Money you borrowed from someone', 'income', false, 'income_debt'),
  b('Repayment', false, 'request_quote', 'Money paid back toward a loan or debt', 'income', false, 'income_repayment'),
  b('Misc', false, 'more_horiz', 'Other income that doesn’t fit other categories', 'income', false, 'income_misc', true),
  b('Rent', true, 'home', 'Housing rent and lease payments', 'expense', true, 'expense_rent'),
  b('Utilities', true, 'bolt', 'Electricity, water, internet, and bills', 'expense', true, 'expense_utilities'),
  b('Groceries', true, 'shopping_cart', 'Food and household essentials', 'expense', false, 'expense_groceries'),
  b('Transport', true, 'directions_car', 'Taxi, fuel, fares, and transport', 'expense', false, 'expense_transport'),
  b('Eating outside', false, 'restaurant', 'Restaurants, cafes, and takeaway', 'expense', false, 'expense_eating_outside'),
  b('Clothing', false, 'checkroom', 'Clothes, shoes, and accessories', 'expense', false, 'expense_clothing'),
  b('Health', true, 'health', 'Medical, pharmacy, and health spending', 'expense', false, 'expense_health'),
  b('Airtime', true, 'phone', 'Mobile airtime and data bundles', 'expense', true, 'expense_airtime'),
  b('Loan', true, 'request_quote', 'Loan payments and interest', 'expense', true, 'expense_loan'),
  b('Repayment', false, 'request_quote', 'Money paid back toward a loan or debt', 'expense', false, 'expense_repayment'),
  b('Beauty', false, 'spa', 'Salon, grooming, and personal care', 'expense', false, 'expense_beauty'),
  b('Misc', false, 'more_horiz', 'Anything that doesn’t fit other categories', 'expense', false, 'expense_misc', true),
];

/** Categories whose assignment is managed by loan/debt or reimbursement flows. */
export const LOAN_DEBT_KEYS = new Set(['expense_loan', 'income_debt']);
export const REPAYMENT_KEYS = new Set(['income_repayment', 'expense_repayment']);
export const REIMBURSEMENT_KEY = 'income_reimbursement';

export function isLoanDebtCategory(c: Category | null | undefined): boolean {
  return !!c?.builtInKey && LOAN_DEBT_KEYS.has(c.builtInKey);
}

export function isRepaymentCategory(c: Category | null | undefined): boolean {
  return !!c?.builtInKey && REPAYMENT_KEYS.has(c.builtInKey);
}

export function isReimbursementCategory(c: Category | null | undefined): boolean {
  return c?.builtInKey === REIMBURSEMENT_KEY;
}

export function isManagedCategory(c: Category | null | undefined): boolean {
  return isLoanDebtCategory(c) || isRepaymentCategory(c) || isReimbursementCategory(c);
}

/** Material icon key -> @expo/vector-icons MaterialIcons glyph name. */
export const CATEGORY_ICON_MAP: Record<string, string> = {
  payments: 'payments',
  gift: 'card-giftcard',
  request_quote: 'request-quote',
  more_horiz: 'more-horiz',
  home: 'home',
  bolt: 'bolt',
  shopping_cart: 'shopping-cart',
  directions_car: 'directions-car',
  restaurant: 'restaurant',
  checkroom: 'checkroom',
  health: 'local-hospital',
  phone: 'phone-android',
  spa: 'spa',
  school: 'school',
  savings: 'savings',
  pets: 'pets',
  sports: 'sports-soccer',
  travel: 'flight',
  movie: 'movie',
  coffee: 'local-cafe',
  work: 'work',
  child: 'child-care',
  church: 'church',
  wifi: 'wifi',
  fitness: 'fitness-center',
  book: 'menu-book',
  build: 'build',
  local_gas_station: 'local-gas-station',
  receipt: 'receipt',
  attach_money: 'attach-money',
};

export const CATEGORY_ICON_KEYS = Object.keys(CATEGORY_ICON_MAP);

export function categoryIconName(iconKey: string | null | undefined): string {
  return CATEGORY_ICON_MAP[iconKey ?? ''] ?? 'label';
}
