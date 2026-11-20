import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  batchStatements,
  buildUpsertStatements,
  contentHash,
  d1Query,
  D1Error,
  d1QueryUrl,
  exportToRecords,
  planPull,
  planPush,
  recordsToBackupJson,
  runD1SyncCore,
  stableStringify,
  syncId,
  testD1Connection,
  type D1SyncDeps,
  type FetchLike,
  type ItemState,
} from '../src/services/d1SyncCore';

const creds = { accountId: 'acc123', databaseId: 'db-456', apiToken: 'secret-token' };

/** A fetch that serves the D1 /query endpoint from an in-memory SQLite database. */
function fakeD1(db = new Database(':memory:')) {
  const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    const statements = body.batch ?? [body];
    try {
      const result = statements.map((s: { sql: string; params?: string[] }) => {
        if ((s.params?.length ?? 0) > 100) throw new Error('too many SQL variables');
        const rows = db.prepare(s.sql).all(...((s.params ?? []) as any[]));
        return { results: rows, success: true, meta: {} };
      });
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, errors: [], messages: [], result }) };
    } catch (error) {
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ success: false, errors: [{ code: 7500, message: String(error) }], result: [] }),
      };
    }
  };
  return { db, fetch, calls };
}

/** A tiny stand-in for the app: local ids, export like buildExportJson, merge-only import. */
function fakeDevice(name: string, firstId: number) {
  let nextId = firstId;
  const categories: { id: number; name: string; flow: string }[] = [];
  const transactions: { reference: string; amount: number; categoryId: number | null }[] = [];
  const states = new Map<string, ItemState>();
  let cursor = 0;
  const addCategory = (catName: string, flow = 'expense') => {
    const existing = categories.find((c) => c.name.toLowerCase() === catName.toLowerCase() && c.flow === flow);
    if (existing) return existing.id;
    const id = nextId++;
    categories.push({ id, name: catName, flow });
    return id;
  };
  return {
    name,
    categories,
    transactions,
    states,
    addCategory,
    exportJson: async () =>
      JSON.stringify({
        schemaVersion: 14,
        categories: categories.map((c) => ({ ...c, builtInKey: null })),
        transactions: transactions.map((t) => ({ ...t, profileId: 1, categoryIds: t.categoryId == null ? null : [t.categoryId] })),
      }),
    importJson: async (json: string) => {
      const data = JSON.parse(json);
      const idMap = new Map<number, number>();
      let cats = 0;
      for (const c of data.categories ?? []) {
        const before = categories.length;
        idMap.set(c.id, addCategory(c.name, c.flow));
        if (categories.length > before) cats++;
      }
      let txs = 0;
      for (const t of data.transactions ?? []) {
        if (transactions.some((x) => x.reference === t.reference)) continue;
        transactions.push({ reference: t.reference, amount: t.amount, categoryId: t.categoryId == null ? null : (idMap.get(t.categoryId) ?? null) });
        txs++;
      }
      return { accounts: 0, transactions: txs, budgets: 0, categories: cats };
    },
    deps(fetch: FetchLike, profile = 'shared'): D1SyncDeps {
      const self = this;
      return {
        creds,
        fetch,
        profile,
        deviceId: name,
        deviceName: name,
        schemaVersion: 14,
        cursor,
        exportJson: self.exportJson,
        importJson: self.importJson,
        loadStates: async () => new Map(states),
        saveStates: async (changes) => {
          for (const [k, v] of changes) states.set(k, v);
        },
      };
    },
    setCursor(value: number) {
      cursor = value;
    },
  };
}

async function sync(device: ReturnType<typeof fakeDevice>, fetch: FetchLike, profile?: string) {
  const result = await runD1SyncCore(device.deps(fetch, profile));
  device.setCursor(result.cursor);
  return result;
}

const categoryName = (device: ReturnType<typeof fakeDevice>, id: number | null) => device.categories.find((c) => c.id === id)?.name;

describe('canonical JSON and hashing', () => {
  test('stableStringify ignores key order and undefined', () => {
    expect(stableStringify({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"x":2,"y":1}]},"b":1}');
    expect(contentHash(stableStringify({ a: 1, b: 2 }))).toBe(contentHash(stableStringify({ b: 2, a: 1 })));
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });

  test('syncId is stable and positive 31-bit', () => {
    const id = syncId('category', 'n:food|expense');
    expect(id).toBe(syncId('category', 'n:food|expense'));
    expect(id).toBeGreaterThan(0);
    expect(id).toBeLessThan(2 ** 31);
    expect(id).not.toBe(syncId('category', 'n:rent|expense'));
  });
});

describe('exportToRecords', () => {
  const exportA = {
    schemaVersion: 14,
    exportDate: '2026-01-01T00:00:00Z',
    categories: [
      { id: 3, name: 'Food', flow: 'expense', builtInKey: null, parentId: null },
      { id: 4, name: 'Snacks', flow: 'expense', builtInKey: null, parentId: 3 },
      { id: 9, name: 'Salary', flow: 'income', builtInKey: 'salary' },
    ],
    people: [{ id: 2, name: 'Abebe  K', profileId: 1, createdAt: 'x' }],
    personAccounts: [{ id: 7, personId: 2, bankId: 1, identifier: '1000123', kind: 'account' }],
    peopleGroups: [{ id: 5, name: 'Family', memberIds: [2, 99] }],
    transactions: [{ reference: 'FT1', amount: 10, categoryId: 4, categoryIds: [4, 3], profileId: 1 }],
    transactionSplits: [
      { id: 21, parentReference: 'FT1', amount: 4, kind: 'loan', categoryId: null, personId: 2 },
      { id: 20, parentReference: 'FT1', amount: 6, kind: 'expense', categoryId: 3, personId: null },
    ],
    loanDebtEntries: [{ transactionReference: 'FT1#split-21', personName: 'Abebe K' }],
    budgets: [{ id: 1, name: 'Monthly', type: 'monthly', amount: 100, categoryIds: [3], startDate: '2026-01-01' }],
    failedParses: [{ id: 1, address: 'CBE', body: 'hello', reason: 'x', timestamp: 't' }],
    pockets: [{ id: 77, name: 'Future list', categoryId: 3 }],
  };
  // The same data on a second phone, where every local id is different.
  const exportB = {
    ...exportA,
    categories: [
      { id: 40, name: 'food', flow: 'expense', builtInKey: null, parentId: null },
      { id: 41, name: 'Snacks', flow: 'expense', builtInKey: null, parentId: 40 },
      { id: 42, name: 'Pay', flow: 'income', builtInKey: 'salary' },
    ],
    people: [{ id: 8, name: 'abebe k', profileId: 3, createdAt: 'x' }],
    personAccounts: [{ id: 1, personId: 8, bankId: 1, identifier: '1000123', kind: 'account' }],
    peopleGroups: [{ id: 1, name: 'Family', memberIds: [8] }],
    transactions: [{ reference: 'FT1', amount: 10, categoryId: 41, categoryIds: [41, 40], profileId: 3 }],
    transactionSplits: [
      { id: 5, parentReference: 'FT1', amount: 6, kind: 'expense', categoryId: 40, personId: null },
      { id: 6, parentReference: 'FT1', amount: 4, kind: 'loan', categoryId: null, personId: 8 },
    ],
    loanDebtEntries: [{ transactionReference: 'FT1#split-6', personName: 'Abebe K' }],
    budgets: [{ id: 9, name: 'Monthly', type: 'monthly', amount: 100, categoryIds: [40], startDate: '2026-01-01' }],
    failedParses: [{ id: 33, address: 'CBE', body: 'hello', reason: 'x', timestamp: 't' }],
  };
  const byKey = (json: object) => new Map(exportToRecords(json).map((r) => [`${r.entity}|${r.key}`, r]));

  test('derives natural keys and rewrites local ids to sync ids', () => {
    const records = byKey(exportA);
    const food = syncId('category', 'n:food|expense');
    const snacks = syncId('category', 'n:snacks|expense');
    const person = syncId('person', 'abebe k');
    expect(JSON.parse(records.get('categories|n:snacks|expense')!.data)).toMatchObject({ id: snacks, parentId: food });
    expect(records.has('categories|b:salary')).toBe(true);
    const tx = JSON.parse(records.get('transactions|FT1')!.data);
    expect(tx).toEqual({ reference: 'FT1', amount: 10, categoryId: snacks, categoryIds: [snacks, food] });
    expect(JSON.parse(records.get(`personAccounts|${person}|1|1000123`)!.data).personId).toBe(person);
    // Dangling member 99 is dropped.
    expect(JSON.parse(records.get('peopleGroups|family')!.data).memberIds).toEqual([person]);
    expect(JSON.parse(records.get('budgets|monthly|monthly|100.00|' + food + '|2026-01-01|||')!.data).id).toBeUndefined();
  });

  test('splits are grouped per parent and split loan references follow the split sync id', () => {
    const records = byKey(exportA);
    const splits = JSON.parse(records.get('transactionSplits|FT1')!.data);
    expect(splits.map((s: any) => s.amount)).toEqual([6, 4]);
    const loanSplitId = splits[1].id;
    expect(loanSplitId).toBe(syncId('split', 'FT1#1'));
    expect(records.has(`loanDebtEntries|FT1#split-${loanSplitId}`)).toBe(true);
  });

  test('the same data on two phones produces identical records', () => {
    const a = byKey(exportA);
    const b = byKey(exportB);
    for (const key of ['transactions|FT1', 'categories|n:snacks|expense', 'transactionSplits|FT1', 'peopleGroups|family', 'failedParses|CBE|t|' + contentHash('hello')]) {
      expect(b.get(key)?.hash).toBe(a.get(key)!.hash);
    }
    expect([...a.keys()].filter((k) => k.startsWith('loanDebtEntries'))).toEqual([...b.keys()].filter((k) => k.startsWith('loanDebtEntries')));
  });

  test('unknown lists are keyed by content and keep their ids', () => {
    const pocket = exportToRecords(exportA).find((r) => r.entity === 'pockets')!;
    expect(JSON.parse(pocket.data)).toEqual({ id: 77, name: 'Future list', categoryId: syncId('category', 'n:food|expense') });
  });

  test('recordsToBackupJson flattens groups and skips bad rows', () => {
    const records = exportToRecords(exportA);
    const json = JSON.parse(recordsToBackupJson([...records, { entity: 'transactions', data: '{oops' }], 14, new Date(0)));
    expect(json.schemaVersion).toBe(14);
    expect(json.transactions).toHaveLength(1);
    expect(json.transactionSplits).toHaveLength(2);
    expect(json.categories).toHaveLength(3);
  });
});

describe('planning', () => {
  const rec = (key: string, hash: string) => ({ entity: 'transactions', key, data: '{}', hash });

  test('pushes new and changed records, baselines pulled ones, tombstones removed ones', () => {
    const states = new Map<string, ItemState>([
      ['transactions|same', { local: 'h1', remote: 'h1', deleted: false }],
      ['transactions|changed', { local: 'h1', remote: 'h1', deleted: false }],
      ['transactions|pulled', { local: null, remote: 'r', deleted: false }],
      ['transactions|gone', { local: 'h1', remote: 'h1', deleted: false }],
      ['transactions|neverHere', { local: null, remote: 'r', deleted: false }],
    ]);
    const plan = planPush([rec('same', 'h1'), rec('changed', 'h2'), rec('pulled', 'p'), rec('new', 'n')], states);
    expect(plan.upserts.map((r) => r.key).sort()).toEqual(['changed', 'new']);
    expect(plan.baselines.get('transactions|pulled')?.local).toBe('p');
    expect(plan.tombstones).toEqual([{ entity: 'transactions', key: 'gone' }]);
  });

  test('holds back deletions when most records vanish at once', () => {
    const states = new Map<string, ItemState>();
    for (let i = 0; i < 100; i++) states.set(`transactions|t${i}`, { local: 'h', remote: 'h', deleted: false });
    const plan = planPush([rec('t0', 'h')], states);
    expect(plan.tombstones).toEqual([]);
    expect(plan.skippedDeletions).toBe(99);
  });

  test('pull skips rows already seen and records tombstones', () => {
    const states = new Map<string, ItemState>([['transactions|a', { local: 'x', remote: contentHash('{"a":1}'), deleted: false }]]);
    const rows = [
      { entity: 'transactions', record_key: 'a', data: '{"a":1}', updated_at: 1, deleted: 0 },
      { entity: 'transactions', record_key: 'b', data: '{"b":1}', updated_at: 2, deleted: 0 },
      { entity: 'transactions', record_key: 'c', data: 'null', updated_at: 3, deleted: 1 },
    ];
    const { toImport, tombstoned } = planPull(rows, states);
    expect(toImport.map((r) => r.record_key)).toEqual(['b']);
    expect(tombstoned.get('transactions|c')).toEqual({ local: null, remote: null, deleted: true });
  });
});

describe('SQL chunking', () => {
  test('upserts stay within 100 bound parameters', () => {
    const rows = Array.from({ length: 45 }, (_, i) => ({ entity: 'transactions', key: `k${i}`, data: '{}' }));
    const statements = buildUpsertStatements('p', 'dev', rows);
    expect(statements).toHaveLength(3);
    for (const s of statements) expect(s.params!.length).toBeLessThanOrEqual(100);
    expect(statements.reduce((n, s) => n + s.params!.length / 5, 0)).toBe(45);
  });

  test('large rows get their own statements and batches respect byte budgets', () => {
    const big = 'x'.repeat(300_000);
    const rows = Array.from({ length: 4 }, (_, i) => ({ entity: 'transactions', key: `k${i}`, data: big }));
    const statements = buildUpsertStatements('p', 'dev', rows);
    expect(statements).toHaveLength(4);
    const batches = batchStatements(statements);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toHaveLength(4);
  });
});

describe('d1Query', () => {
  test('uses the documented URL, bearer auth and single vs batch bodies', async () => {
    const { fetch, calls } = fakeD1();
    expect(d1QueryUrl(creds)).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/d1/database/db-456/query');
    const [[row]] = await d1Query(creds, [{ sql: 'SELECT ? AS v', params: ['1'] }], fetch);
    expect(row).toEqual({ v: '1' });
    expect(calls[0].body).toEqual({ sql: 'SELECT ? AS v', params: ['1'] });
    expect(calls[0].headers.Authorization).toBe('Bearer secret-token');
    const results = await d1Query(creds, [{ sql: 'SELECT 1 AS a' }, { sql: 'SELECT 2 AS b' }], fetch);
    expect(calls[1].body).toEqual({ batch: [{ sql: 'SELECT 1 AS a' }, { sql: 'SELECT 2 AS b' }] });
    expect(results).toEqual([[{ a: 1 }], [{ b: 2 }]]);
  });

  test('maps HTTP and network failures to readable errors without the token', async () => {
    const respond = (status: number, body: object): FetchLike => async () => ({ ok: false, status, text: async () => JSON.stringify(body) });
    const run = (f: FetchLike) => d1Query(creds, [{ sql: 'SELECT 1' }], f, 200).catch((e) => e);

    const auth = await run(respond(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] }));
    expect(auth).toBeInstanceOf(D1Error);
    expect(auth.message).toContain('API token');
    expect((await run(respond(404, { success: false, errors: [] }))).message).toContain('could not find');
    expect((await run(respond(400, { success: false, errors: [{ code: 7500, message: 'no such table: x' }] }))).message).toBe(
      'Cloudflare D1: no such table: x',
    );
    const offline = await run(async () => {
      throw new TypeError('Network request failed');
    });
    expect(offline.message).toContain('Could not reach Cloudflare');
    const slow = await run(() => new Promise(() => undefined));
    expect(slow.message).toContain('too long');
    for (const error of [auth, offline, slow]) expect(String(error.message)).not.toContain('secret-token');
  });
});

describe('runD1SyncCore against a fake D1', () => {
  test('two phones converge through D1 without echoing records back', async () => {
    const { fetch, db } = fakeD1();
    const a = fakeDevice('phone-a', 1);
    const b = fakeDevice('phone-b', 500);
    a.transactions.push({ reference: 'A1', amount: 5, categoryId: a.addCategory('Food') });
    a.transactions.push({ reference: 'A2', amount: 7, categoryId: null });
    b.addCategory('Transport');
    b.transactions.push({ reference: 'B1', amount: 9, categoryId: b.addCategory('Food') });

    const first = await sync(a, fetch);
    expect(first.pushed).toBe(3);
    expect(first.pulled).toBe(0);

    const second = await sync(b, fetch);
    expect(second.pushed).toBe(3); // Food (same content as A's), Transport, B1
    expect(second.imported?.transactions).toBe(2);
    expect(b.transactions.map((t) => t.reference).sort()).toEqual(['A1', 'A2', 'B1']);
    expect(categoryName(b, b.transactions.find((t) => t.reference === 'A1')!.categoryId)).toBe('Food');

    const third = await sync(a, fetch);
    expect(third.pushed).toBe(0);
    expect(third.imported?.transactions).toBe(1);
    expect(categoryName(a, a.transactions.find((t) => t.reference === 'B1')!.categoryId)).toBe('Food');
    expect(a.categories.map((c) => c.name).sort()).toEqual(['Food', 'Transport']);

    // Nothing left to move in either direction.
    for (const device of [b, a, b]) {
      const quiet = await sync(device, fetch);
      expect(quiet.pushed).toBe(0);
      expect(quiet.pulled).toBe(0);
    }
    const count = db.prepare("SELECT COUNT(*) AS n FROM hisab_records WHERE profile = 'shared'").get() as { n: number };
    expect(count.n).toBe(5);
    expect((db.prepare('SELECT COUNT(*) AS n FROM hisab_sync_meta').get() as { n: number }).n).toBe(2);
  });

  test('a local deletion becomes a tombstone that other phones keep their copy of', async () => {
    const { fetch, db } = fakeD1();
    const a = fakeDevice('phone-a', 1);
    const b = fakeDevice('phone-b', 100);
    a.transactions.push({ reference: 'A1', amount: 5, categoryId: null }, { reference: 'A2', amount: 6, categoryId: null });
    await sync(a, fetch);
    await sync(b, fetch);
    a.transactions.splice(0, 1);
    const result = await sync(a, fetch);
    expect(result.deleted).toBe(1);
    expect((db.prepare("SELECT deleted FROM hisab_records WHERE record_key = 'A1'").get() as { deleted: number }).deleted).toBe(1);
    const onB = await sync(b, fetch);
    expect(onB.pushed).toBe(0); // B keeps A1 but does not resurrect it
    expect(b.transactions).toHaveLength(2);
    // A brand-new phone never receives the deleted record.
    const c = fakeDevice('phone-c', 900);
    await sync(c, fetch);
    expect(c.transactions.map((t) => t.reference)).toEqual(['A2']);
  });

  test('namespaces keep profiles apart', async () => {
    const { fetch } = fakeD1();
    const a = fakeDevice('phone-a', 1);
    const b = fakeDevice('phone-b', 100);
    a.transactions.push({ reference: 'A1', amount: 5, categoryId: null });
    await sync(a, fetch, 'work');
    await sync(b, fetch, 'home');
    expect(b.transactions).toHaveLength(0);
  });

  test('pull pages through more rows than one page', async () => {
    const { fetch } = fakeD1();
    const a = fakeDevice('phone-a', 1);
    for (let i = 0; i < 1203; i++) a.transactions.push({ reference: `T${i}`, amount: i, categoryId: null });
    await sync(a, fetch);
    const b = fakeDevice('phone-b', 5000);
    const result = await sync(b, fetch);
    expect(result.pulled).toBe(1203);
    expect(b.transactions).toHaveLength(1203);
  });

  test('connection test creates tables and counts records', async () => {
    const { fetch } = fakeD1();
    const info = await testD1Connection({ creds, fetch, profile: 'p' });
    expect(info).toEqual({ records: 0, devices: 0 });
  });

  test('progress survives a failed request', async () => {
    const { fetch } = fakeD1();
    const a = fakeDevice('phone-a', 1);
    for (let i = 0; i < 900; i++) a.transactions.push({ reference: `T${i}`, amount: i, categoryId: null });
    let upsertRequests = 0;
    const flaky: FetchLike = async (url, init) => {
      if (init.body.includes('INSERT INTO hisab_records') && ++upsertRequests > 1) throw new TypeError('offline');
      return fetch(url, init);
    };
    await expect(runD1SyncCore(a.deps(flaky))).rejects.toThrow('Could not reach Cloudflare');
    const saved = [...a.states.values()].filter((s) => s.local);
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.length).toBeLessThan(900);
    const retry = await sync(a, fetch);
    expect(retry.pushed).toBe(900 - saved.length);
  });
});
