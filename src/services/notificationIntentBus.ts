export type NotificationIntent =
  | { type: 'categorizeTransaction'; reference: string }
  | { type: 'quickCategorizeTransaction'; reference: string; categoryId: number }
  | { type: 'openSharedExpenses'; groupId?: string | null }
  | { type: 'openAccountReparseResult'; id: string }
  | { type: 'openLoanDebt'; reference: string };

type Listener = (intent: NotificationIntent) => void;

const listeners = new Set<Listener>();
/** Intents emitted before any listener subscribed (e.g. a cold start from a notification tap). */
let pending: NotificationIntent[] = [];

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function intentFromPayload(payload: string | null | undefined): NotificationIntent | null {
  const raw = payload?.trim();
  if (!raw) return null;
  if (raw.startsWith('tx:')) {
    const body = raw.substring(3);
    const catIndex = body.indexOf('|cat:');
    if (catIndex >= 0) {
      const reference = safeDecode(body.substring(0, catIndex));
      const categoryId = Number.parseInt(body.substring(catIndex + 5), 10);
      if (!reference || !Number.isFinite(categoryId)) return null;
      return { type: 'quickCategorizeTransaction', reference, categoryId };
    }
    const reference = safeDecode(body);
    return reference ? { type: 'categorizeTransaction', reference } : null;
  }
  if (raw === 'shared_expenses') return { type: 'openSharedExpenses', groupId: null };
  if (raw.startsWith('shared_expenses:')) {
    const groupId = safeDecode(raw.substring('shared_expenses:'.length)).trim();
    return { type: 'openSharedExpenses', groupId: groupId || null };
  }
  if (raw.startsWith('account_reparse_result:')) {
    const id = raw.substring('account_reparse_result:'.length).trim();
    return id ? { type: 'openAccountReparseResult', id } : null;
  }
  if (raw.startsWith('loan_debt:')) {
    const reference = safeDecode(raw.substring('loan_debt:'.length));
    return reference ? { type: 'openLoanDebt', reference } : null;
  }
  return null;
}

export const notificationIntentBus = {
  emit(intent: NotificationIntent): void {
    if (listeners.size === 0) {
      pending.push(intent);
      return;
    }
    listeners.forEach((listener) => listener(intent));
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    if (pending.length > 0) {
      const queued = pending;
      pending = [];
      queued.forEach((intent) => listener(intent));
    }
    return () => {
      listeners.delete(listener);
    };
  },
};
