import type { Bank } from '../models/bank';

export function normalizeSender(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

interface Candidate {
  bank: Bank;
  code: string;
  exact: boolean;
  atStart: boolean;
  unmatched: number;
}

function candidatesFor(bank: Bank, address: string): Candidate[] {
  const normalizedAddress = normalizeSender(address);
  if (!normalizedAddress) return [];
  const result: Candidate[] = [];
  for (const raw of bank.codes) {
    const code = normalizeSender(raw);
    if (!code) continue;
    const index = normalizedAddress.indexOf(code);
    if (index < 0) continue;
    result.push({
      bank,
      code,
      exact: normalizedAddress === code,
      atStart: index === 0,
      unmatched: normalizedAddress.length - code.length,
    });
  }
  return result;
}

function compare(a: Candidate, b: Candidate): number {
  if (a.exact !== b.exact) return a.exact ? -1 : 1;
  if (a.code.length !== b.code.length) return b.code.length - a.code.length;
  if (a.atStart !== b.atStart) return a.atStart ? -1 : 1;
  return a.unmatched - b.unmatched;
}

/** Picks the bank whose sender code best matches the SMS address. */
export function findBankForSender(address: string | null | undefined, banks: Bank[]): Bank | null {
  if (!address) return null;
  const candidates = banks.flatMap((bank) => candidatesFor(bank, address));
  if (candidates.length === 0) return null;
  candidates.sort(compare);
  return candidates[0].bank;
}

export function senderAddressMatchesBank(bank: Bank, address: string | null | undefined, allBanks?: Bank[]): boolean {
  if (!address) return false;
  if (candidatesFor(bank, address).length === 0) return false;
  if (!allBanks || allBanks.length === 0) return true;
  return findBankForSender(address, allBanks)?.id === bank.id;
}
