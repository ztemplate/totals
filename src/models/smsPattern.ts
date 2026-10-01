export interface SmsPattern {
  bankId: number;
  senderId: string;
  regex: string;
  type: string;
  description: string;
  refRequired?: boolean | null;
  hasAccount?: boolean | null;
}

export function smsPatternFromJson(json: Record<string, any>): SmsPattern {
  const toOptBool = (v: unknown): boolean | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v === 1;
    if (typeof v === 'string') return v === '1' || v.toLowerCase() === 'true';
    return null;
  };
  return {
    bankId: Number(json.bankId),
    senderId: String(json.senderId ?? ''),
    regex: String(json.regex ?? ''),
    type: String(json.type ?? ''),
    description: String(json.description ?? ''),
    refRequired: toOptBool(json.refRequired),
    hasAccount: toOptBool(json.hasAccount),
  };
}
