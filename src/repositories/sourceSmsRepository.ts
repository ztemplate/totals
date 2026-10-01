import { getDb } from '../db/database';
import type { TransactionSourceSms } from '../models/misc';

const CHUNK = 500;

function fromDb(row: Record<string, any>): TransactionSourceSms {
  return {
    transactionReference: String(row.transactionReference),
    body: String(row.body ?? ''),
    senderAddress: row.senderAddress ?? null,
    receivedAt: row.receivedAt ?? null,
    messageId: row.messageId ?? null,
  };
}

export const sourceSmsRepository = {
  async getForTransaction(transactionReference: string): Promise<TransactionSourceSms | null> {
    const reference = transactionReference.trim();
    if (!reference) return null;
    const db = await getDb();
    const row = await db.getFirstAsync<Record<string, unknown>>(
      'SELECT * FROM transaction_source_sms WHERE transactionReference = ? LIMIT 1',
      [reference],
    );
    return row ? fromDb(row) : null;
  },

  async getForTransactionReferences(references: Iterable<string>): Promise<TransactionSourceSms[]> {
    const refs = [...new Set([...references].map((r) => r.trim()).filter(Boolean))];
    if (refs.length === 0) return [];
    const db = await getDb();
    const out: TransactionSourceSms[] = [];
    for (let i = 0; i < refs.length; i += CHUNK) {
      const chunk = refs.slice(i, i + CHUNK);
      const rows = await db.getAllAsync<Record<string, unknown>>(
        `SELECT * FROM transaction_source_sms WHERE transactionReference IN (${chunk.map(() => '?').join(',')})
         ORDER BY transactionReference ASC`,
        chunk,
      );
      out.push(...rows.map(fromDb));
    }
    return out;
  },

  upsert(sourceSms: TransactionSourceSms): Promise<void> {
    return this.upsertAll([sourceSms]);
  },

  async upsertAll(messages: Iterable<TransactionSourceSms>): Promise<void> {
    const normalized = new Map<string, TransactionSourceSms>();
    for (const m of messages) {
      const reference = m.transactionReference.trim();
      if (!reference || !m.body.trim()) continue;
      normalized.set(reference, {
        transactionReference: reference,
        body: m.body,
        senderAddress: m.senderAddress?.trim() ?? null,
        receivedAt: m.receivedAt ?? null,
        messageId: m.messageId?.trim() ?? null,
      });
    }
    if (normalized.size === 0) return;
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const m of normalized.values()) {
        await db.runAsync(
          `INSERT OR REPLACE INTO transaction_source_sms (transactionReference, body, senderAddress, receivedAt, messageId)
           VALUES (?, ?, ?, ?, ?)`,
          [m.transactionReference, m.body, m.senderAddress ?? null, m.receivedAt ?? null, m.messageId ?? null],
        );
      }
    });
  },

  async getAll(): Promise<TransactionSourceSms[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM transaction_source_sms');
    return rows.map(fromDb);
  },
};
