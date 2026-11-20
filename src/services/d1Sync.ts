/**
 * Sync through the user's own Cloudflare D1 database (see d1SyncCore.ts for the record format and
 * the merge rules). The API token lives in SecureStore and is never logged; account and database
 * ids are plain prefs.
 */
import * as SecureStore from 'expo-secure-store';
import { getDb } from '../db/database';
import { profileRepository } from '../repositories/profileRepository';
import { BACKUP_SCHEMA_VERSION, buildExportJson, importBackupJson, type ImportSummary } from './backup';
import {
  D1Error,
  runD1SyncCore,
  testD1Connection as testConnectionCore,
  type D1ConnectionInfo,
  type D1Credentials,
  type FetchLike,
  type ItemState,
} from './d1SyncCore';
import { getSyncDeviceId, syncDeviceName } from './driveSync';
import { PrefKeys, prefs } from './prefs';

export interface D1SyncResultSummary {
  at: string;
  pushed: number;
  deleted: number;
  pulled: number;
  imported: ImportSummary | null;
  skippedDeletions: number;
}

export interface D1SyncSettings {
  accountId: string;
  databaseId: string;
  /** Remote namespace; empty means the active profile's name. */
  namespace: string;
  autoSync: boolean;
  lastSyncAt: string | null;
  lastResult: D1SyncResultSummary | null;
  lastError: string | null;
  /** Pull cursor (D1 server time, ms) per local state namespace. */
  cursors: Record<string, number>;
}

export interface D1SyncState extends D1SyncSettings {
  tokenSaved: boolean;
  /** Namespace actually used: the custom one or the active profile's name. */
  effectiveNamespace: string;
  configured: boolean;
}

const TOKEN_KEY = 'cloudflare_d1_api_token';
const DEFAULTS: D1SyncSettings = {
  accountId: '',
  databaseId: '',
  namespace: '',
  autoSync: false,
  lastSyncAt: null,
  lastResult: null,
  lastError: null,
  cursors: {},
};
const TIMEOUT_MS = 60_000;
const AUTO_SYNC_MIN_GAP_MS = 10 * 60 * 1000;
const BACKGROUND_SYNC_GAP_MS = 60 * 60 * 1000;
const STATE_TABLE = 'd1_sync_state';

let inFlight: Promise<D1SyncResultSummary> | null = null;

async function getSettings(): Promise<D1SyncSettings> {
  const saved = await prefs.getJson<Partial<D1SyncSettings>>(PrefKeys.d1Sync);
  return { ...DEFAULTS, ...saved, cursors: { ...(saved?.cursors ?? {}) } };
}

async function updateSettings(patch: Partial<D1SyncSettings>): Promise<D1SyncSettings> {
  const next = { ...(await getSettings()), ...patch };
  await prefs.setJson(PrefKeys.d1Sync, next);
  return next;
}

async function activeProfileName(): Promise<string> {
  try {
    const profile = await profileRepository.getActiveProfile();
    return profile?.name?.trim() || 'default';
  } catch {
    return 'default';
  }
}

export async function getD1State(): Promise<D1SyncState> {
  const settings = await getSettings();
  const tokenSaved = !!(await SecureStore.getItemAsync(TOKEN_KEY));
  const effectiveNamespace = settings.namespace.trim() || (await activeProfileName());
  return {
    ...settings,
    tokenSaved,
    effectiveNamespace,
    configured: tokenSaved && !!settings.accountId.trim() && !!settings.databaseId.trim(),
  };
}

export async function saveD1Settings(patch: { accountId?: string; databaseId?: string; namespace?: string }): Promise<D1SyncState> {
  const clean: Partial<D1SyncSettings> = {};
  if (patch.accountId !== undefined) clean.accountId = patch.accountId.trim();
  if (patch.databaseId !== undefined) clean.databaseId = patch.databaseId.trim();
  if (patch.namespace !== undefined) clean.namespace = patch.namespace.trim();
  await updateSettings(clean);
  return getD1State();
}

export async function saveD1Token(token: string): Promise<D1SyncState> {
  const trimmed = token.trim();
  if (!trimmed) throw new D1Error('Paste an API token first.');
  await SecureStore.setItemAsync(TOKEN_KEY, trimmed);
  return getD1State();
}

export async function clearD1Token(): Promise<D1SyncState> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await updateSettings({ autoSync: false });
  return getD1State();
}

export async function setD1AutoSync(autoSync: boolean): Promise<D1SyncState> {
  await updateSettings({ autoSync });
  return getD1State();
}

async function credentials(): Promise<{ creds: D1Credentials; state: D1SyncState }> {
  const state = await getD1State();
  const apiToken = (await SecureStore.getItemAsync(TOKEN_KEY)) ?? '';
  if (!state.accountId) throw new D1Error('Enter your Cloudflare account ID.');
  if (!state.databaseId) throw new D1Error('Enter the D1 database ID.');
  if (!apiToken) throw new D1Error('Save a Cloudflare API token first.');
  return { creds: { accountId: state.accountId, databaseId: state.databaseId, apiToken }, state };
}

const appFetch: FetchLike = (url, init) => fetch(url, init as RequestInit);

/** Local bookkeeping is per database and namespace, so switching either starts fresh. */
function stateNamespace(state: D1SyncState): string {
  return `${state.accountId}/${state.databaseId}/${state.effectiveNamespace}`;
}

async function ensureStateTable(): Promise<void> {
  const db = await getDb();
  await db.execAsync(
    `CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (namespace TEXT NOT NULL, item TEXT NOT NULL, local_hash TEXT, remote_hash TEXT, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (namespace, item))`,
  );
}

async function loadStates(namespace: string): Promise<Map<string, ItemState>> {
  await ensureStateTable();
  const db = await getDb();
  const rows = await db.getAllAsync<{ item: string; local_hash: string | null; remote_hash: string | null; deleted: number }>(
    `SELECT item, local_hash, remote_hash, deleted FROM ${STATE_TABLE} WHERE namespace = ?`,
    [namespace],
  );
  return new Map(rows.map((r) => [r.item, { local: r.local_hash, remote: r.remote_hash, deleted: r.deleted === 1 }]));
}

async function saveStates(namespace: string, changes: Map<string, ItemState>): Promise<void> {
  await ensureStateTable();
  const db = await getDb();
  const statement = await db.prepareAsync(
    `INSERT OR REPLACE INTO ${STATE_TABLE} (namespace, item, local_hash, remote_hash, deleted) VALUES (?, ?, ?, ?, ?)`,
  );
  try {
    await db.withTransactionAsync(async () => {
      for (const [item, state] of changes) {
        await statement.executeAsync([namespace, item, state.local, state.remote, state.deleted ? 1 : 0]);
      }
    });
  } finally {
    await statement.finalizeAsync();
  }
}

/** Forgets what was synced, so the next sync pushes everything and pulls the whole namespace again. */
export async function resetD1SyncProgress(): Promise<void> {
  const state = await getD1State();
  const namespace = stateNamespace(state);
  await ensureStateTable();
  const db = await getDb();
  await db.runAsync(`DELETE FROM ${STATE_TABLE} WHERE namespace = ?`, [namespace]);
  const cursors = { ...state.cursors };
  delete cursors[namespace];
  await updateSettings({ cursors });
}

export async function testD1Connection(): Promise<D1ConnectionInfo> {
  const { creds, state } = await credentials();
  return testConnectionCore({ creds, fetch: appFetch, timeoutMs: TIMEOUT_MS, profile: state.effectiveNamespace });
}

async function doSync(): Promise<D1SyncResultSummary> {
  try {
    const { creds, state } = await credentials();
    const namespace = stateNamespace(state);
    const result = await runD1SyncCore({
      creds,
      fetch: appFetch,
      timeoutMs: TIMEOUT_MS,
      profile: state.effectiveNamespace,
      deviceId: await getSyncDeviceId(),
      deviceName: syncDeviceName(),
      schemaVersion: BACKUP_SCHEMA_VERSION,
      cursor: state.cursors[namespace] ?? 0,
      exportJson: buildExportJson,
      importJson: importBackupJson,
      loadStates: () => loadStates(namespace),
      saveStates: (changes) => saveStates(namespace, changes),
    });
    const summary: D1SyncResultSummary = {
      at: new Date().toISOString(),
      pushed: result.pushed,
      deleted: result.deleted,
      pulled: result.pulled,
      imported: result.imported,
      skippedDeletions: result.skippedDeletions,
    };
    const latest = await getSettings();
    await updateSettings({
      lastSyncAt: summary.at,
      lastResult: summary,
      lastError: null,
      cursors: { ...latest.cursors, [namespace]: result.cursor },
    });
    return summary;
  } catch (error) {
    await updateSettings({ lastError: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/** Pushes local changes to D1 and merges in what other devices pushed. */
export function syncD1Now(): Promise<D1SyncResultSummary> {
  if (!inFlight) {
    inFlight = doSync().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

export function isD1SyncRunning(): boolean {
  return inFlight !== null;
}

async function syncIfDue(minGapMs: number, now: number): Promise<boolean> {
  const state = await getD1State();
  if (!state.autoSync || !state.configured) return false;
  const last = state.lastSyncAt ? Date.parse(state.lastSyncAt) : 0;
  if (Number.isFinite(last) && now - last < minGapMs) return false;
  await syncD1Now();
  return true;
}

/** Auto sync when the app opens. */
export function runAutoD1Sync(now = Date.now()): Promise<boolean> {
  return syncIfDue(AUTO_SYNC_MIN_GAP_MS, now);
}

/** Called from the periodic background task. */
export function runScheduledD1Sync(now = new Date()): Promise<boolean> {
  return syncIfDue(BACKGROUND_SYNC_GAP_MS, now.getTime());
}
