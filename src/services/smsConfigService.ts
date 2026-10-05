import NetInfo from '@react-native-community/netinfo';
import { getDb } from '../db/database';
import { smsPatternFromJson, type SmsPattern } from '../models/smsPattern';

const REMOTE_URL = 'https://sms-parsing-visualizer.vercel.app/sms_patterns.json';
/** Bundled patterns that always win over stored/remote ones (keyed by bankId|description). */
const BUNDLED_PATTERN_OVERRIDES = new Set<string>(['4|dashen telebirr credit']);

let assetPatternsCache: SmsPattern[] | null = null;
let remoteSyncInFlight: Promise<void> | null = null;

function patternsFromData(data: unknown): SmsPattern[] {
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { patterns?: unknown }).patterns)
      ? (data as { patterns: unknown[] }).patterns
      : [];
  return list.filter((item) => item && typeof item === 'object').map((item) => smsPatternFromJson(item as Record<string, any>));
}

export function parsePatternsFromJson(body: string): SmsPattern[] {
  let normalized = body.trim();
  if (/^(export|const|var|let)/.test(normalized)) {
    const match = normalized.match(/(\[[\s\S]*\])|(\{[\s\S]*\})/);
    if (match) normalized = match[0];
  }
  return patternsFromData(JSON.parse(normalized));
}

function loadAssetPatterns(): SmsPattern[] {
  if (assetPatternsCache) return assetPatternsCache;
  try {
    // Copied from the Flutter app by scripts/copy-assets.ts.
    const data = require('../../assets/sms_patterns.json');
    assetPatternsCache = patternsFromData(data);
  } catch (error) {
    if (__DEV__) console.warn('debug: Error loading asset patterns', error);
    assetPatternsCache = [];
  }
  return assetPatternsCache;
}

function patternKey(pattern: SmsPattern): string {
  return `${pattern.bankId}|${pattern.description.trim().toLowerCase()}`;
}

function applyBundledPatternOverrides(stored: SmsPattern[], bundled: SmsPattern[]): SmsPattern[] {
  const merged = [...stored];
  for (const pattern of bundled) {
    const key = patternKey(pattern);
    if (!BUNDLED_PATTERN_OVERRIDES.has(key)) continue;
    const index = merged.findIndex((p) => patternKey(p) === key);
    if (index < 0) merged.push(pattern);
    else merged[index] = pattern;
  }
  return merged;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // bun-types and the DOM lib disagree on AbortSignal; the runtime object is the same.
    const init = { signal: controller.signal, headers: { 'Cache-Control': 'no-cache' } } as unknown as RequestInit;
    return await fetch(url, init);
  } finally {
    clearTimeout(timer);
  }
}

async function hasInternetConnection(): Promise<boolean> {
  try {
    const state = await NetInfo.fetch();
    if (!state.isConnected) return false;
    try {
      const response = await fetchWithTimeout('https://www.google.com', 3000);
      return response.status === 200;
    } catch {
      return false;
    }
  } catch (error) {
    if (__DEV__) console.warn('debug: Error checking connectivity', error);
    return false;
  }
}

async function fetchRemotePatterns(): Promise<SmsPattern[]> {
  try {
    const response = await fetchWithTimeout(REMOTE_URL, 10_000);
    if (response.status !== 200) return [];
    return parsePatternsFromJson(await response.text());
  } catch (error) {
    if (__DEV__) console.warn('debug: Exception fetching remote patterns', error);
    return [];
  }
}

async function storedPatternRows(): Promise<Record<string, unknown>[]> {
  const db = await getDb();
  return db.getAllAsync<Record<string, unknown>>('SELECT * FROM sms_patterns ORDER BY id ASC');
}

export const smsConfigService = {
  cleanSmsText(text: string): string {
    return text.trim();
  },

  async getPatterns(options: { allowRemoteFetch?: boolean } = {}): Promise<SmsPattern[]> {
    const allowRemoteFetch = options.allowRemoteFetch ?? true;
    const rows = await storedPatternRows();
    if (rows.length > 0) {
      try {
        return applyBundledPatternOverrides(rows.map(smsPatternFromJson), loadAssetPatterns());
      } catch (error) {
        if (__DEV__) console.warn('debug: Error parsing stored patterns', error);
      }
    }

    if (allowRemoteFetch && (await hasInternetConnection())) {
      const remote = await fetchRemotePatterns();
      if (remote.length > 0) {
        const patterns = applyBundledPatternOverrides(remote, loadAssetPatterns());
        await this.savePatterns(patterns);
        return patterns;
      }
    }

    const assetPatterns = loadAssetPatterns();
    if (assetPatterns.length > 0) await this.savePatterns(assetPatterns);
    return assetPatterns;
  },

  async savePatterns(patterns: SmsPattern[]): Promise<void> {
    const db = await getDb();
    const toInt = (v: boolean | null | undefined) => (v == null ? null : v ? 1 : 0);
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM sms_patterns');
      const statement = await db.prepareAsync(
        `INSERT INTO sms_patterns (bankId, senderId, regex, type, description, refRequired, hasAccount)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      try {
        for (const p of patterns) {
          await statement.executeAsync([
            p.bankId,
            p.senderId,
            p.regex,
            p.type,
            p.description,
            toInt(p.refRequired),
            toInt(p.hasAccount),
          ]);
        }
      } finally {
        await statement.finalizeAsync();
      }
    });
  },

  /** Background remote sync; concurrent callers share the same in-flight request. */
  syncRemoteConfig(options: { showError?: boolean } = {}): Promise<void> {
    if (remoteSyncInFlight) return remoteSyncInFlight;
    const sync = (async () => {
      if (!(await hasInternetConnection())) return;
      try {
        const patterns = await fetchRemotePatterns();
        if (patterns.length > 0) await this.savePatterns(patterns);
      } catch (error) {
        if (options.showError) throw error;
      }
    })();
    remoteSyncInFlight = sync;
    return sync.finally(() => {
      if (remoteSyncInFlight === sync) remoteSyncInFlight = null;
    });
  },

  async refreshPatternsFromInternet(): Promise<number> {
    if (!(await hasInternetConnection())) throw new Error('No internet connection. Connect and try again.');
    const patterns = await fetchRemotePatterns();
    if (patterns.length === 0) throw new Error('Could not download SMS patterns right now.');
    await this.savePatterns(patterns);
    return patterns.length;
  },

  /**
   * Ensures patterns exist on first launch. Returns true when internet is required
   * but unavailable (callers may still fall back to bundled patterns via getPatterns).
   */
  async initializePatterns(): Promise<boolean> {
    const rows = await storedPatternRows();
    if (rows.length > 0) return false;
    if (!(await hasInternetConnection())) return true;
    try {
      const patterns = await fetchRemotePatterns();
      if (patterns.length > 0) {
        await this.savePatterns(patterns);
        return false;
      }
    } catch (error) {
      if (__DEV__) console.warn('debug: Error initializing patterns', error);
    }
    const assetPatterns = loadAssetPatterns();
    if (assetPatterns.length > 0) await this.savePatterns(assetPatterns);
    return false;
  },

  async patternCount(): Promise<number> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM sms_patterns');
    return row?.c ?? 0;
  },

  hasInternetConnection,
};
