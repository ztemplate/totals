/**
 * Sender prefilter shared by the JS fallback and mirrored in SmsReaderModule.kt.
 * Kept free of React Native imports so it can be unit tested.
 */

/** Same normalization as normalizeSender in src/utils/bankSenderMatcher.ts and the Kotlin module. */
export function normalizeSenderCode(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function normalizedCodes(codes: readonly string[] | null | undefined): string[] | null {
  if (!codes) return null;
  const out = new Set<string>();
  for (const code of codes) {
    const normalized = normalizeSenderCode(code);
    if (normalized) out.add(normalized);
  }
  return out.size > 0 ? [...out] : null;
}

export function senderMatchesCodes(address: string | null | undefined, codes: readonly string[]): boolean {
  const normalized = normalizeSenderCode(address);
  return normalized.length > 0 && codes.some((code) => normalized.includes(code));
}
