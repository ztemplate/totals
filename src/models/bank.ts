export interface Bank {
  id: number;
  name: string;
  shortName: string;
  codes: string[];
  image: string;
  maskPattern?: number | null;
  uniformMasking?: boolean | null;
  simBased?: boolean | null;
  colors?: string[] | null;
}

export function bankFromJson(json: Record<string, unknown>): Bank {
  const parseList = (raw: unknown): string[] => {
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === 'string' && raw.trim()) {
      try {
        const decoded = JSON.parse(raw);
        if (Array.isArray(decoded)) return decoded.map(String);
      } catch {
        return raw.split(',').map((s) => s.trim()).filter(Boolean);
      }
    }
    return [];
  };
  const toBool = (raw: unknown): boolean | null => {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'number') return raw !== 0;
    if (typeof raw === 'string') return raw === '1' || raw.toLowerCase() === 'true';
    return null;
  };
  return {
    id: Number(json.id),
    name: String(json.name ?? ''),
    shortName: String(json.shortName ?? ''),
    codes: parseList(json.codes),
    image: String(json.image ?? ''),
    maskPattern: json.maskPattern == null ? null : Number(json.maskPattern),
    uniformMasking: toBool(json.uniformMasking),
    simBased: toBool(json.simBased),
    colors: parseList(json.colors),
  };
}
