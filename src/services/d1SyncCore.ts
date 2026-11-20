/**
 * Pure logic for Cloudflare D1 sync: no React Native imports, so it can be unit-tested with a mocked
 * fetch. The remote side is one generic table of JSON records keyed by (profile, entity, record_key),
 * so every list in the backup JSON syncs without a schema per table.
 *
 * Local ids differ between phones, so before a record leaves the device every reference to a
 * category, person or split is rewritten to a "sync id" derived from that row's natural key (the same
 * keys backup.ts uses when it merges an import). Pulled rows are rebuilt into a backup-shaped JSON and
 * merged with importBackupJson, which maps those ids back to local ones.
 *
 * D1 REST API (checked against developers.cloudflare.com, Nov 2026):
 *   POST https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query
 *   Authorization: Bearer <token>
 *   body: { sql, params?: string[] }  or  { batch: [{ sql, params? }, ...] }
 *   response: { success, errors: [{ code, message }], messages, result: [{ results: row[], success, meta }] }
 * Limits: 100 bound parameters per statement, 100 KB of SQL text per statement, 2 MB per row.
 */

type Json = Record<string, any>;

// ---------------------------------------------------------------------------------------------
// Hashing and canonical JSON
// ---------------------------------------------------------------------------------------------

/** cyrb53: fast 53-bit string hash. Good enough for change detection and id derivation. */
export function cyrb53(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** ~106-bit content hash as a short string. */
export function contentHash(text: string): string {
  return `${cyrb53(text).toString(36)}.${cyrb53(text, 0x9e3779b9).toString(36)}`;
}

/** Deterministic positive 31-bit id for a natural key, identical on every device. */
export function syncId(kind: string, naturalKey: string): number {
  return (cyrb53(`${kind}:${naturalKey}`) % 2147483646) + 1;
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Json = {};
    for (const key of Object.keys(value as Json).sort()) {
      const v = (value as Json)[key];
      if (v !== undefined) out[key] = sortDeep(v);
    }
    return out;
  }
  return value;
}

/** JSON with object keys sorted, so equal content always gives an equal string. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value)) ?? 'null';
}

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

export interface SyncRecord {
  entity: string;
  key: string;
  /** Canonical JSON of the normalized item (an array for grouped entities). */
  data: string;
  hash: string;
}

export const SPLIT_SEPARATOR = '#split-';
/** Entities stored as one record per group (an array of items) instead of one per item. */
const GROUPED_ENTITIES = new Set(['transactionSplits']);
/** Entities whose `id` is referenced by other lists and so becomes a sync id. */
const SYNC_ID_ENTITIES = new Set(['categories', 'people', 'transactionSplits']);
/** Entities whose `id` is a fixed, global value (bank ids ship with the app). */
const RAW_ID_ENTITIES = new Set(['banks']);
/** Entities fetched in full whenever anything is imported, so ids in pulled rows can be mapped. */
export const DICTIONARY_ENTITIES = ['categories', 'people'];

const CATEGORY_REF_FIELDS = ['categoryId', 'categoryIds', 'parentCategoryId'];
const PERSON_REF_FIELDS = ['personId', 'personIds', 'memberIds'];
const VOLATILE_FIELDS = ['id', 'profileId', 'createdAt', 'updatedAt'];

const str = (v: unknown) => (v == null ? '' : String(v)).trim();
const lower = (v: unknown) => str(v).replace(/\s+/g, ' ').toLowerCase();
const flowOf = (v: unknown) => (lower(v) === 'income' ? 'income' : 'expense');

function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number.parseInt(value.trim(), 10);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

export function categoryNaturalKey(item: Json): string {
  const builtInKey = str(item.builtInKey);
  if (builtInKey) return `b:${builtInKey}`;
  const name = lower(item.name);
  return name ? `n:${name}|${flowOf(item.flow)}` : '';
}

export function personNaturalKey(item: Json): string {
  return lower(item.name);
}

function sortedIds(value: unknown): string {
  return Array.isArray(value) ? [...value].map(Number).sort((a, b) => a - b).join(',') : str(value);
}

function withoutVolatile(item: Json): Json {
  const copy = { ...item };
  for (const field of VOLATILE_FIELDS) delete copy[field];
  return copy;
}

/** Natural key per entity, computed on the normalized item. Unknown lists key by content. */
const RECORD_KEYS: Record<string, (item: Json) => string> = {
  accounts: (i) => (str(i.accountNumber) ? `${str(i.bank)}|${str(i.accountNumber)}` : ''),
  banks: (i) => str(i.id),
  budgets: (i) =>
    lower(i.name)
      ? [
          lower(i.name),
          str(i.type),
          Number(i.amount || 0).toFixed(2),
          sortedIds(i.categoryIds ?? (i.categoryId == null ? [] : [i.categoryId])),
          str(i.startDate),
          str(i.endDate),
          str(i.timeFrame),
          str(i.calendar),
        ].join('|')
      : '',
  categories: categoryNaturalKey,
  userAccounts: (i) => (str(i.accountNumber) ? `${str(i.bankId)}|${str(i.accountNumber)}` : ''),
  transactions: (i) => str(i.reference),
  transactionSourceSms: (i) => str(i.transactionReference),
  failedParses: (i) => `${str(i.address)}|${str(i.timestamp)}|${contentHash(String(i.body ?? ''))}`,
  autoCategoryRules: (i) => (lower(i.counterparty) ? `${lower(i.counterparty)}|${flowOf(i.flow)}|${str(i.categoryId)}` : ''),
  autoCategoryPromptDismissals: (i) => (lower(i.counterparty) ? `${lower(i.counterparty)}|${flowOf(i.flow)}` : ''),
  loanDebtEntries: (i) => str(i.transactionReference),
  loanDebtRepayments: (i) =>
    str(i.repaymentTransactionReference) ? `${str(i.repaymentTransactionReference)}|${str(i.loanDebtTransactionReference)}` : '',
  reimbursementAllocations: (i) =>
    str(i.reimbursementTransactionReference)
      ? `${str(i.reimbursementTransactionReference)}|${str(i.expenseTransactionReference)}`
      : '',
  people: personNaturalKey,
  personAccounts: (i) => (str(i.identifier) ? `${str(i.personId)}|${str(i.bankId)}|${lower(i.identifier)}` : ''),
  personTransactionLinks: (i) => str(i.transactionReference),
  peopleGroups: (i) => lower(i.name),
  cashSpendLinks: (i) => str(i.cashReference),
  plannedItems: (i) => lower(i.name),
  incomeSources: (i) => lower(i.name),
  assets: (i) => lower(i.name),
  moneyOpportunities: (i) => lower(i.name),
};

function mapRef(value: unknown, map: Map<number, number>): unknown {
  if (Array.isArray(value)) {
    const out: number[] = [];
    for (const v of value) {
      const mapped = map.get(asInt(v) ?? Number.NaN);
      if (mapped !== undefined && !out.includes(mapped)) out.push(mapped);
    }
    return out;
  }
  if (value == null) return null;
  // A dangling id means nothing on another phone, so drop it rather than guess.
  return map.get(asInt(value) ?? Number.NaN) ?? null;
}

function assignIds(items: Json[], kind: string, keyOf: (item: Json) => string): Map<number, number> {
  const map = new Map<number, number>();
  const used = new Map<number, string>();
  for (const item of items) {
    const id = asInt(item.id);
    const key = keyOf(item);
    if (id === null || !key) continue;
    let sid = syncId(kind, key);
    // Collisions are astronomically unlikely; probe so they can't merge two rows on this device.
    while (used.has(sid) && used.get(sid) !== key) sid = (sid % 2147483646) + 1;
    used.set(sid, key);
    map.set(id, sid);
  }
  return map;
}

/** Turns buildExportJson() output into normalized, keyed records. */
export function exportToRecords(exportJson: string | Json): SyncRecord[] {
  const data: Json = typeof exportJson === 'string' ? JSON.parse(exportJson) : exportJson;
  const list = (key: string): Json[] =>
    Array.isArray(data[key]) ? (data[key] as unknown[]).filter((v): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)) : [];

  const categoryIds = assignIds(list('categories'), 'category', categoryNaturalKey);
  const personIds = assignIds(list('people'), 'person', personNaturalKey);

  // Split ids: ordinal within the parent, so a re-imported copy on another phone gets the same id.
  const splitIds = new Map<string, number>();
  const splitOrder = new Map<number, number>();
  const splitLoanRefs = new Map<string, string>();
  const byParent = new Map<string, Json[]>();
  for (const split of list('transactionSplits')) {
    const parent = str(split.parentReference);
    if (!parent) continue;
    byParent.set(parent, [...(byParent.get(parent) ?? []), split]);
  }
  for (const [parent, splits] of byParent) {
    [...splits]
      .sort((a, b) => (asInt(a.id) ?? 0) - (asInt(b.id) ?? 0))
      .forEach((split, ordinal) => {
        const sid = syncId('split', `${parent}#${ordinal}`);
        splitIds.set(`${parent}|${asInt(split.id)}`, sid);
        splitOrder.set(sid, ordinal);
        splitLoanRefs.set(`${parent}${SPLIT_SEPARATOR}${asInt(split.id)}`, `${parent}${SPLIT_SEPARATOR}${sid}`);
      });
  }
  const mapLoanRef = (value: unknown) => (typeof value === 'string' ? (splitLoanRefs.get(value.trim()) ?? value) : value);

  const records = new Map<string, SyncRecord>();
  const grouped = new Map<string, Map<string, Json[]>>();

  for (const [entity, value] of Object.entries(data)) {
    if (!Array.isArray(value)) continue;
    for (const raw of list(entity)) {
      const item: Json = { ...raw };
      delete item.profileId;
      for (const field of CATEGORY_REF_FIELDS) if (field in item) item[field] = mapRef(item[field], categoryIds);
      for (const field of PERSON_REF_FIELDS) if (field in item) item[field] = mapRef(item[field], personIds);

      if (entity === 'categories') {
        if ('parentId' in item) item.parentId = mapRef(item.parentId, categoryIds);
        item.id = categoryIds.get(asInt(raw.id) ?? Number.NaN) ?? null;
      } else if (entity === 'people') {
        item.id = personIds.get(asInt(raw.id) ?? Number.NaN) ?? null;
      } else if (entity === 'transactionSplits') {
        item.id = splitIds.get(`${str(raw.parentReference)}|${asInt(raw.id)}`) ?? null;
      } else if (entity === 'loanDebtEntries') {
        item.transactionReference = mapLoanRef(item.transactionReference);
      } else if (entity === 'loanDebtRepayments') {
        item.loanDebtTransactionReference = mapLoanRef(item.loanDebtTransactionReference);
      }
      const known = entity in RECORD_KEYS;
      // Local row ids of other known lists aren't referenced anywhere and differ per phone.
      if (known && !SYNC_ID_ENTITIES.has(entity) && !RAW_ID_ENTITIES.has(entity)) delete item.id;

      if (GROUPED_ENTITIES.has(entity)) {
        const parent = str(item.parentReference);
        if (!parent) continue;
        const groups = grouped.get(entity) ?? new Map<string, Json[]>();
        groups.set(parent, [...(groups.get(parent) ?? []), item]);
        grouped.set(entity, groups);
        continue;
      }

      const key = known ? RECORD_KEYS[entity](item) : contentHash(stableStringify(withoutVolatile(item)));
      if (!key) continue;
      const json = stableStringify(item);
      records.set(`${entity}|${key}`, { entity, key, data: json, hash: contentHash(json) });
    }
  }
  for (const [entity, groups] of grouped) {
    for (const [key, items] of groups) {
      const order = (item: Json) => splitOrder.get(item.id) ?? Number.MAX_SAFE_INTEGER;
      const json = stableStringify([...items].sort((a, b) => order(a) - order(b)));
      records.set(`${entity}|${key}`, { entity, key, data: json, hash: contentHash(json) });
    }
  }
  return [...records.values()];
}

export function itemKey(entity: string, key: string): string {
  return `${entity}|${key}`;
}

/** Rebuilds a backup-shaped JSON (for importBackupJson) from record rows. */
export function recordsToBackupJson(rows: { entity: string; data: string }[], schemaVersion: number, exportDate = new Date()): string {
  const out: Json = { schemaVersion, version: '1.0', exportDate: exportDate.toISOString() };
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.data);
    } catch {
      continue;
    }
    const items = GROUPED_ENTITIES.has(row.entity) && Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      (out[row.entity] ??= []).push(item);
    }
  }
  return JSON.stringify(out);
}

// ---------------------------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------------------------

/**
 * What this device knows about one remote record.
 * - local: hash of the local version at the last sync ('' = deleted here, null = not seen locally yet)
 * - remote: hash of the last remote version this device wrote or pulled
 * - deleted: the remote row is a tombstone
 */
export interface ItemState {
  local: string | null;
  remote: string | null;
  deleted: boolean;
}

export interface PushPlan {
  upserts: SyncRecord[];
  tombstones: { entity: string; key: string }[];
  /** States that change without a request (first local sighting of a pulled row). */
  baselines: Map<string, ItemState>;
  /** Deletions held back because too much disappeared at once (a reset, a different profile…). */
  skippedDeletions: number;
}

export function planPush(records: SyncRecord[], states: Map<string, ItemState>): PushPlan {
  const upserts: SyncRecord[] = [];
  const baselines = new Map<string, ItemState>();
  const present = new Set<string>();
  for (const record of records) {
    const id = itemKey(record.entity, record.key);
    present.add(id);
    const state = states.get(id);
    if (!state) upserts.push(record);
    else if (state.local === null) {
      // Pulled earlier (or a tombstone from another phone): don't echo it back, just remember it.
      baselines.set(id, { ...state, local: record.hash });
    } else if (state.local !== record.hash) upserts.push(record);
  }

  const tombstones: { entity: string; key: string }[] = [];
  let tracked = 0;
  for (const [id, state] of states) {
    if (state.local) tracked++;
    if (present.has(id) || state.deleted || !state.local) continue;
    const split = id.indexOf('|');
    tombstones.push({ entity: id.slice(0, split), key: id.slice(split + 1) });
  }
  // Removing a quarter of everything in one go looks like a wipe, not a series of edits.
  if (tombstones.length > 20 && tombstones.length > tracked / 4) {
    return { upserts, tombstones: [], baselines, skippedDeletions: tombstones.length };
  }
  return { upserts, tombstones, baselines, skippedDeletions: 0 };
}

export interface RemoteRow {
  entity: string;
  record_key: string;
  data: string;
  updated_at: number;
  deleted: number;
}

/** Splits pulled rows into those to import and the state updates for tombstones. */
export function planPull(
  rows: RemoteRow[],
  states: Map<string, ItemState>,
): { toImport: RemoteRow[]; tombstoned: Map<string, ItemState> } {
  const latest = new Map<string, RemoteRow>();
  for (const row of rows) latest.set(itemKey(row.entity, row.record_key), row);
  const toImport: RemoteRow[] = [];
  const tombstoned = new Map<string, ItemState>();
  for (const [id, row] of latest) {
    const state = states.get(id);
    if (Number(row.deleted)) {
      if (!state?.deleted) tombstoned.set(id, { local: null, remote: null, deleted: true });
      continue;
    }
    if (state && !state.deleted && state.remote === contentHash(row.data)) continue;
    toImport.push(row);
  }
  return { toImport, tombstoned };
}

// ---------------------------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------------------------

export interface D1Statement {
  sql: string;
  params?: string[];
}

export const D1_MAX_PARAMS = 100;
/** Bound data per statement; well under D1's 2 MB row limit. */
const MAX_STATEMENT_BYTES = 400_000;
const MAX_BATCH_STATEMENTS = 25;
const MAX_BATCH_BYTES = 900_000;
const SERVER_NOW_MS = `CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`;

export const SCHEMA_STATEMENTS: D1Statement[] = [
  {
    sql: `CREATE TABLE IF NOT EXISTS hisab_records (profile TEXT NOT NULL, entity TEXT NOT NULL, record_key TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, device_id TEXT, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (profile, entity, record_key))`,
  },
  { sql: 'CREATE INDEX IF NOT EXISTS hisab_records_updated ON hisab_records (profile, updated_at)' },
  {
    sql: `CREATE TABLE IF NOT EXISTS hisab_sync_meta (profile TEXT NOT NULL, device_id TEXT NOT NULL, device_name TEXT, schema_version INTEGER, last_sync_at INTEGER NOT NULL, PRIMARY KEY (profile, device_id))`,
  },
];

const UPSERT_COLUMNS = 5;

/** Multi-row upserts, chunked to D1's bound-parameter limit and a per-statement size budget. */
export function buildUpsertStatements(
  profile: string,
  deviceId: string,
  rows: { entity: string; key: string; data: string; deleted?: boolean }[],
): D1Statement[] {
  const statements: D1Statement[] = [];
  const perStatement = Math.floor(D1_MAX_PARAMS / UPSERT_COLUMNS);
  let chunk: typeof rows = [];
  let bytes = 0;
  const flush = () => {
    if (chunk.length === 0) return;
    const groups: string[] = [];
    const params: string[] = [];
    // Tombstones and live rows can share a statement; the deleted flag is a literal per row.
    for (const row of chunk) {
      groups.push(`(?, ?, ?, ?, ${SERVER_NOW_MS}, ?, ${row.deleted ? 1 : 0})`);
      params.push(profile, row.entity, row.key, row.deleted ? 'null' : row.data, deviceId);
    }
    statements.push({
      sql:
        `INSERT INTO hisab_records (profile, entity, record_key, data, updated_at, device_id, deleted) VALUES ${groups.join(', ')} ` +
        'ON CONFLICT (profile, entity, record_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, ' +
        'device_id = excluded.device_id, deleted = excluded.deleted',
      params,
    });
    chunk = [];
    bytes = 0;
  };
  for (const row of rows) {
    const size = row.data.length + row.key.length + row.entity.length;
    if (chunk.length >= perStatement || (chunk.length > 0 && bytes + size > MAX_STATEMENT_BYTES)) flush();
    chunk.push(row);
    bytes += size;
  }
  flush();
  return statements;
}

function statementBytes(statement: D1Statement): number {
  return statement.sql.length + (statement.params ?? []).reduce((sum, p) => sum + p.length + 4, 0);
}

/** Groups statements into requests (D1's `batch` body). */
export function batchStatements(statements: D1Statement[], maxStatements = MAX_BATCH_STATEMENTS, maxBytes = MAX_BATCH_BYTES): D1Statement[][] {
  const batches: D1Statement[][] = [];
  let current: D1Statement[] = [];
  let bytes = 0;
  for (const statement of statements) {
    const size = statementBytes(statement);
    if (current.length > 0 && (current.length >= maxStatements || bytes + size > maxBytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(statement);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// ---------------------------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------------------------

export interface D1Credentials {
  accountId: string;
  databaseId: string;
  apiToken: string;
}

type ResponseLike = { ok: boolean; status: number; text(): Promise<string> };
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: any }) => Promise<ResponseLike>;

export class D1Error extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'D1Error';
  }
}

export function d1QueryUrl(creds: Pick<D1Credentials, 'accountId' | 'databaseId'>): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(creds.accountId.trim())}/d1/database/${encodeURIComponent(
    creds.databaseId.trim(),
  )}/query`;
}

function errorFor(status: number, body: Json | null): D1Error {
  const first = Array.isArray(body?.errors) ? body!.errors[0] : null;
  const code = typeof first?.code === 'number' ? first.code : undefined;
  const detail = typeof first?.message === 'string' ? first.message : '';
  if (status === 401 || status === 403 || code === 10000 || code === 9109) {
    return new D1Error('Cloudflare rejected the API token. It needs the "D1 Edit" permission on this account.', status, code);
  }
  if (status === 404 || code === 7404 || /not found/i.test(detail)) {
    return new D1Error('Cloudflare could not find that database. Check the account ID and database ID.', status, code);
  }
  if (status === 429) return new D1Error('Cloudflare is rate limiting requests. Try again in a few minutes.', status, code);
  if (status >= 500) return new D1Error('Cloudflare D1 is unavailable right now. Try again later.', status, code);
  return new D1Error(detail ? `Cloudflare D1: ${detail}` : `Cloudflare D1 request failed (HTTP ${status}).`, status, code);
}

/**
 * Runs statements in one request and returns the rows of each. One statement uses the plain
 * `{ sql, params }` body, more use `{ batch: [...] }`.
 */
export async function d1Query(
  creds: D1Credentials,
  statements: D1Statement[],
  fetchImpl: FetchLike,
  timeoutMs = 60_000,
): Promise<Json[][]> {
  if (statements.length === 0) return [];
  const toBody = (s: D1Statement) => (s.params && s.params.length > 0 ? { sql: s.sql, params: s.params } : { sql: s.sql });
  const body = statements.length === 1 ? toBody(statements[0]) : { batch: statements.map(toBody) };
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new D1Error('Cloudflare took too long to respond. Try again.'));
    }, timeoutMs);
  });
  let status = 0;
  let text = '';
  try {
    const response = await Promise.race([
      fetchImpl(d1QueryUrl(creds), {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.apiToken.trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller?.signal,
      }).catch((error) => {
        if (error instanceof D1Error) throw error;
        throw new D1Error('Could not reach Cloudflare. Check your connection.');
      }),
      timeout,
    ]);
    status = response.status;
    text = await Promise.race([response.text(), timeout]);
    let json: Json | null = null;
    try {
      json = text.trim() ? (JSON.parse(text) as Json) : null;
    } catch {
      json = null;
    }
    if (!response.ok || !json || json.success === false) throw errorFor(response.ok ? 400 : status, json);
    const results: Json[] = Array.isArray(json.result) ? json.result : [];
    return results.map((result) => {
      if (result?.success === false) throw errorFor(400, { errors: [{ message: result?.error ?? 'statement failed' }] });
      return Array.isArray(result?.results) ? (result.results as Json[]) : [];
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------
// Sync engine
// ---------------------------------------------------------------------------------------------

export interface ImportCounts {
  accounts: number;
  transactions: number;
  budgets: number;
  categories: number;
}

export interface D1SyncDeps {
  creds: D1Credentials;
  fetch: FetchLike;
  /** Remote namespace, shared by the phones that should see the same data. */
  profile: string;
  deviceId: string;
  deviceName?: string;
  schemaVersion: number;
  /** Last pull cursor (server time in ms), 0 for a full pull. */
  cursor: number;
  exportJson(): Promise<string>;
  importJson(json: string): Promise<ImportCounts>;
  loadStates(): Promise<Map<string, ItemState>>;
  saveStates(changes: Map<string, ItemState>): Promise<void>;
  timeoutMs?: number;
}

export interface D1SyncResult {
  pushed: number;
  deleted: number;
  pulled: number;
  imported: ImportCounts | null;
  skippedDeletions: number;
  cursor: number;
}

const PULL_PAGE = 500;
/** Re-read a little before the cursor; already-seen rows are skipped by hash. */
const PULL_OVERLAP_MS = 5 * 60 * 1000;

export async function ensureD1Schema(deps: Pick<D1SyncDeps, 'creds' | 'fetch' | 'timeoutMs'>): Promise<void> {
  await d1Query(deps.creds, SCHEMA_STATEMENTS, deps.fetch, deps.timeoutMs);
}

async function pullChanged(deps: D1SyncDeps): Promise<{ rows: RemoteRow[]; cursor: number }> {
  const rows: RemoteRow[] = [];
  let cursor = deps.cursor;
  let after: [number, string, string] = [Math.max(0, deps.cursor - PULL_OVERLAP_MS), '', ''];
  for (;;) {
    const [page] = await d1Query(
      deps.creds,
      [
        {
          sql:
            'SELECT entity, record_key, data, updated_at, deleted FROM hisab_records WHERE profile = ? AND device_id IS NOT ? ' +
            'AND (updated_at, entity, record_key) > (CAST(? AS INTEGER), ?, ?) ORDER BY updated_at, entity, record_key LIMIT ?',
          params: [deps.profile, deps.deviceId, String(after[0]), after[1], after[2], String(PULL_PAGE)],
        },
      ],
      deps.fetch,
      deps.timeoutMs,
    );
    for (const raw of page ?? []) {
      const row: RemoteRow = {
        entity: String(raw.entity),
        record_key: String(raw.record_key),
        data: String(raw.data ?? 'null'),
        updated_at: Number(raw.updated_at) || 0,
        deleted: Number(raw.deleted) || 0,
      };
      rows.push(row);
      cursor = Math.max(cursor, row.updated_at);
      after = [row.updated_at, row.entity, row.record_key];
    }
    if (!page || page.length < PULL_PAGE) break;
  }
  return { rows, cursor };
}

async function pullDictionary(deps: D1SyncDeps): Promise<RemoteRow[]> {
  const placeholders = DICTIONARY_ENTITIES.map(() => '?').join(', ');
  const [rows] = await d1Query(
    deps.creds,
    [
      {
        sql: `SELECT entity, record_key, data, updated_at, deleted FROM hisab_records WHERE profile = ? AND deleted = 0 AND entity IN (${placeholders}) LIMIT 20000`,
        params: [deps.profile, ...DICTIONARY_ENTITIES],
      },
    ],
    deps.fetch,
    deps.timeoutMs,
  );
  return (rows ?? []).map((raw) => ({
    entity: String(raw.entity),
    record_key: String(raw.record_key),
    data: String(raw.data ?? 'null'),
    updated_at: Number(raw.updated_at) || 0,
    deleted: 0,
  }));
}

/**
 * One sync round: push local changes, pull what other devices changed since the cursor and merge it
 * with importJson (merge-only: nothing local is overwritten or deleted).
 */
export async function runD1SyncCore(deps: D1SyncDeps): Promise<D1SyncResult> {
  await ensureD1Schema(deps);
  const states = await deps.loadStates();
  const changes = new Map<string, ItemState>();
  const setState = (id: string, state: ItemState) => {
    states.set(id, state);
    changes.set(id, state);
  };
  let pushed = 0;
  let deleted = 0;
  let pulled = 0;
  let imported: ImportCounts | null = null;
  let skippedDeletions = 0;
  let cursor = deps.cursor;

  try {
    // 1. Push.
    const local = await deps.exportJson();
    const plan = planPush(exportToRecords(local), states);
    skippedDeletions = plan.skippedDeletions;
    for (const [id, state] of plan.baselines) setState(id, state);
    const rows = [
      ...plan.upserts.map((r) => ({ entity: r.entity, key: r.key, data: r.data, hash: r.hash, deleted: false })),
      ...plan.tombstones.map((t) => ({ entity: t.entity, key: t.key, data: 'null', hash: '', deleted: true })),
    ];
    // Send in slices so progress is saved even if a later request fails.
    const sliceSize = 400;
    for (let i = 0; i < rows.length; i += sliceSize) {
      const slice = rows.slice(i, i + sliceSize);
      for (const batch of batchStatements(buildUpsertStatements(deps.profile, deps.deviceId, slice))) {
        await d1Query(deps.creds, batch, deps.fetch, deps.timeoutMs);
      }
      for (const row of slice) {
        const id = itemKey(row.entity, row.key);
        if (row.deleted) {
          setState(id, { local: '', remote: null, deleted: true });
          deleted++;
        } else {
          setState(id, { local: row.hash, remote: row.hash, deleted: false });
          pushed++;
        }
      }
    }

    // 2. Pull.
    const changed = await pullChanged(deps);
    const { toImport, tombstoned } = planPull(changed.rows, states);
    for (const [id, state] of tombstoned) setState(id, state);
    if (toImport.length > 0) {
      const dictionary = await pullDictionary(deps);
      const byId = new Map<string, RemoteRow>();
      for (const row of dictionary) byId.set(itemKey(row.entity, row.record_key), row);
      for (const row of toImport) byId.set(itemKey(row.entity, row.record_key), row);
      const payload = recordsToBackupJson([...byId.values()], deps.schemaVersion);
      imported = await deps.importJson(payload);
      pulled = toImport.length;

      // Remember what came in and how it looks locally now, so it isn't pushed straight back.
      const after = new Map(exportToRecords(await deps.exportJson()).map((r) => [itemKey(r.entity, r.key), r.hash]));
      for (const row of toImport) {
        const id = itemKey(row.entity, row.record_key);
        setState(id, { local: after.get(id) ?? null, remote: contentHash(row.data), deleted: false });
      }
      for (const row of dictionary) {
        const id = itemKey(row.entity, row.record_key);
        const state = states.get(id);
        const hash = after.get(id);
        if (state && hash && state.local !== hash) setState(id, { ...state, local: hash });
      }
    }
    cursor = changed.cursor;

    await d1Query(
      deps.creds,
      [
        {
          sql:
            `INSERT INTO hisab_sync_meta (profile, device_id, device_name, schema_version, last_sync_at) VALUES (?, ?, ?, CAST(? AS INTEGER), ${SERVER_NOW_MS}) ` +
            'ON CONFLICT (profile, device_id) DO UPDATE SET device_name = excluded.device_name, schema_version = excluded.schema_version, last_sync_at = excluded.last_sync_at',
          params: [deps.profile, deps.deviceId, deps.deviceName ?? '', String(deps.schemaVersion)],
        },
      ],
      deps.fetch,
      deps.timeoutMs,
    );
  } finally {
    if (changes.size > 0) await deps.saveStates(changes);
  }
  return { pushed, deleted, pulled, imported, skippedDeletions, cursor };
}

export interface D1ConnectionInfo {
  records: number;
  devices: number;
}

/** Creates the tables if needed and reports how much is stored for this namespace. */
export async function testD1Connection(
  deps: Pick<D1SyncDeps, 'creds' | 'fetch' | 'timeoutMs' | 'profile'>,
): Promise<D1ConnectionInfo> {
  const [, , , ping, records, devices] = await d1Query(
    deps.creds,
    [
      ...SCHEMA_STATEMENTS,
      { sql: 'SELECT 1 AS ok' },
      { sql: 'SELECT COUNT(*) AS n FROM hisab_records WHERE profile = ? AND deleted = 0', params: [deps.profile] },
      { sql: 'SELECT COUNT(*) AS n FROM hisab_sync_meta WHERE profile = ?', params: [deps.profile] },
    ],
    deps.fetch,
    deps.timeoutMs,
  );
  if (Number(ping?.[0]?.ok) !== 1) throw new D1Error('Cloudflare D1 returned an unexpected response.');
  return { records: Number(records?.[0]?.n) || 0, devices: Number(devices?.[0]?.n) || 0 };
}
