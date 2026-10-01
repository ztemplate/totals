import type { Bank } from '../models/bank';
import { prefs } from './prefs';

const CANDIDATES_KEY = 'failed_parse_review_candidates_v1';
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export const NO_MATCHING_PATTERN_REASON = 'No matching pattern';

export interface FailedParseReviewCandidate {
  id: string;
  bankId: number;
  bankName: string;
  address: string;
  body: string;
  timestamp: string;
}

function isCandidate(value: unknown): value is FailedParseReviewCandidate {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.body === 'string' && typeof v.timestamp === 'string';
}

async function readCandidates(): Promise<FailedParseReviewCandidate[]> {
  const raw = await prefs.getJson<unknown[]>(CANDIDATES_KEY);
  if (!Array.isArray(raw)) return [];
  const cutoff = Date.now() - MAX_AGE_MS;
  const candidates = raw.filter(isCandidate).filter((c) => {
    const time = Date.parse(c.timestamp);
    return Number.isFinite(time) && time >= cutoff;
  });
  if (candidates.length !== raw.length) await writeCandidates(candidates);
  return candidates;
}

async function writeCandidates(candidates: FailedParseReviewCandidate[]): Promise<void> {
  await prefs.setJson(CANDIDATES_KEY, candidates);
}

async function takeCandidate(id: string): Promise<FailedParseReviewCandidate | null> {
  const candidates = await readCandidates();
  const index = candidates.findIndex((c) => c.id === id);
  if (index < 0) return null;
  const [candidate] = candidates.splice(index, 1);
  await writeCandidates(candidates);
  return candidate;
}

export const failedParseReviewService = {
  getCandidates: readCandidates,

  async storeCandidate(params: { bank: Bank; address: string; body: string; messageDate: Date }): Promise<string> {
    const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const candidates = await readCandidates();
    candidates.push({
      id,
      bankId: params.bank.id,
      bankName: params.bank.shortName || params.bank.name,
      address: params.address,
      body: params.body,
      timestamp: params.messageDate.toISOString(),
    });
    await writeCandidates(candidates);
    return id;
  },

  /** The user confirmed the SMS was a transaction: keep it as a failed parse for later review. */
  async confirmCandidate(id: string): Promise<boolean> {
    const candidate = await takeCandidate(id);
    if (!candidate) return false;
    // Imported lazily: repositories pull in the database layer.
    const [{ accountRepository }, { failedParseRepository }] = await Promise.all([
      import('../repositories/accountRepository'),
      import('../repositories/failedParseRepository'),
    ]);
    const accounts = await accountRepository.getAccounts();
    if (!accounts.some((a) => a.bank === candidate.bankId)) return false;
    const existing = await failedParseRepository.getAll();
    const duplicate = existing.some(
      (f) => f.address === candidate.address && f.body === candidate.body && f.timestamp === candidate.timestamp,
    );
    if (duplicate) return false;
    await failedParseRepository.add({
      address: candidate.address,
      body: candidate.body,
      reason: NO_MATCHING_PATTERN_REASON,
      timestamp: candidate.timestamp,
    });
    return true;
  },

  async discardCandidate(id: string): Promise<void> {
    await takeCandidate(id);
  },
};
