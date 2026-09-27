import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { requireThat, PaymentError } from './errors.js';
import { checkTransition, publicPayment } from './state.js';

/** Durable single-host reference store. Never put this file on NFS or ephemeral storage. */
export class SQLitePaymentStore {
  #db;
  constructor(filename) {
    requireThat(typeof filename === 'string' && filename.length > 0, 'INVALID_DATABASE_PATH');
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE,
        active_key TEXT UNIQUE, provider_id TEXT UNIQUE, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER NOT NULL DEFAULT 0, lease_token TEXT,
        attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(delivered, seq);`);
  }
  close() { this.#db.close(); }
  #transaction(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.#db.exec('COMMIT'); return result; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  bindAccount(account) {
    this.#transaction(() => {
      const value = JSON.stringify([account.collectorId, account.liveMode, account.currency, account.exponent]);
      this.#db.prepare('INSERT OR IGNORE INTO settings VALUES (?, ?)').run('account:v1', value);
      requireThat(this.#db.prepare('SELECT value FROM settings WHERE key=?').get('account:v1').value === value,
        'DATABASE_ACCOUNT_MISMATCH', 409);
    });
  }
  #decode(row) { return row ? JSON.parse(row.payload) : null; }
  get(id) { return this.#decode(this.#db.prepare('SELECT payload FROM payments WHERE id=?').get(id)); }
  getByProviderId(id) {
    return this.#decode(this.#db.prepare('SELECT payload FROM payments WHERE provider_id=?').get(id));
  }
  #save(record) {
    this.#db.prepare('UPDATE payments SET active_key=?, provider_id=?, payload=? WHERE id=?')
      .run(record.activeKey, record.providerId, JSON.stringify(record), record.id);
  }
  claim(record) {
    return this.#transaction(() => {
      const existing = this.#decode(this.#db.prepare('SELECT payload FROM payments WHERE request_key=?')
        .get(record.requestKey));
      if (existing) {
        requireThat(existing.fingerprint === record.fingerprint, 'IDEMPOTENCY_CONFLICT', 409);
        return { created: false, record: existing };
      }
      requireThat(!this.#db.prepare('SELECT id FROM payments WHERE active_key=?').get(record.activeKey),
        'PAYMENT_ALREADY_ACTIVE', 409);
      this.#db.prepare('INSERT INTO payments VALUES (?, ?, ?, ?, ?)')
        .run(record.id, record.requestKey, record.activeKey, null, JSON.stringify(record));
      return { created: true, record };
    });
  }
  attachProviderId(id, providerId) {
    return this.#transaction(() => {
      const record = this.get(id);
      requireThat(record && (!record.providerId || record.providerId === providerId), 'PROVIDER_ID_MISMATCH', 409);
      const other = this.getByProviderId(providerId);
      requireThat(!other || other.id === id, 'PROVIDER_ID_CONFLICT', 409);
      record.providerId = providerId;
      this.#save(record);
      return record;
    });
  }
  apply(id, snapshot, now = Date.now()) {
    return this.#transaction(() => {
      const record = this.get(id);
      requireThat(record, 'PAYMENT_NOT_FOUND', 404);
      requireThat(!record.providerId || record.providerId === snapshot.providerId, 'PROVIDER_ID_MISMATCH', 409);
      const other = this.getByProviderId(snapshot.providerId);
      requireThat(!other || other.id === id, 'PROVIDER_ID_CONFLICT', 409);
      const decision = checkTransition(record, snapshot);
      if (decision === 'stale' || decision === 'duplicate') return record;
      const firstApproval = snapshot.status === 'approved' && !record.everApproved;
      Object.assign(record, { providerId: snapshot.providerId, status: snapshot.status,
        providerStatus: snapshot.providerStatus, providerUpdatedAt: snapshot.updatedAt,
        refundedMinor: snapshot.refundedMinor, lastSyncedAt: now,
        everApproved: record.everApproved || firstApproval });
      // Unknown, timeouts, refunds and chargebacks NEVER free the payable for another charge.
      if (['rejected', 'cancelled'].includes(record.status)) record.activeKey = null;
      if (decision === 'change') {
        record.version += 1;
        const event = { id: `${record.id}:${record.version}`, type: firstApproval ? 'payment.approved' : 'payment.updated',
          payment: publicPayment(record), createdAt: now };
        this.#db.prepare('INSERT INTO outbox(id, payload) VALUES (?, ?)').run(event.id, JSON.stringify(event));
      }
      this.#save(record);
      return record;
    });
  }
  list({ after = '', limit = 100 } = {}) {
    requireThat(Number.isInteger(limit) && limit > 0 && limit <= 1000, 'INVALID_LIMIT');
    return this.#db.prepare('SELECT payload FROM payments WHERE id > ? ORDER BY id LIMIT ?')
      .all(after, limit).map(row => this.#decode(row));
  }
  leaseEvent({ now = Date.now(), leaseMs = 60_000 } = {}) {
    requireThat(Number.isFinite(now) && Number.isFinite(leaseMs) && leaseMs > 0, 'INVALID_LEASE');
    return this.#transaction(() => {
      // Preserve event ordering. An outstanding earliest event blocks later delivery.
      const row = this.#db.prepare('SELECT * FROM outbox WHERE delivered=0 ORDER BY seq LIMIT 1').get();
      if (!row || row.lease_until > now) return null;
      const token = randomUUID();
      this.#db.prepare('UPDATE outbox SET lease_until=?, lease_token=?, attempts=attempts+1 WHERE id=?')
        .run(now + leaseMs, token, row.id);
      return { event: JSON.parse(row.payload), token, attempts: row.attempts + 1 };
    });
  }
  ackEvent(id, token) {
    const result = this.#db.prepare('UPDATE outbox SET delivered=1 WHERE id=? AND lease_token=? AND delivered=0')
      .run(id, token);
    if (result.changes !== 1) throw new PaymentError('EVENT_LEASE_LOST');
  }
  retryEvent(id, token, retryAt) {
    this.#db.prepare('UPDATE outbox SET lease_until=?, lease_token=NULL WHERE id=? AND lease_token=? AND delivered=0')
      .run(retryAt, id, token);
  }
}
