import { DatabaseSync } from 'node:sqlite';
import { PaymentError } from '../src/index.js';

// Demo business adapter: replace with your actual order/reservation/invoice model.
export class DemoDomain {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS orders (
        tenant TEXT, id TEXT, owner TEXT NOT NULL, amount_minor INTEGER NOT NULL,
        paid INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(tenant, id)
      );
      CREATE TABLE IF NOT EXISTS processed_events (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS fulfillment (
        tenant TEXT, payable_id TEXT, PRIMARY KEY(tenant, payable_id)
      );`);
    this.db.prepare('INSERT OR IGNORE INTO orders(tenant,id,owner,amount_minor) VALUES (?,?,?,?)')
      .run('demo-tenant', 'order-1', 'demo-user', 25000);
  }
  async resolveQuote(context, payableId) {
    const order = this.db.prepare('SELECT * FROM orders WHERE tenant=? AND id=? AND owner=?')
      .get(context.tenantId, payableId, context.userId);
    if (!order) throw new PaymentError('FORBIDDEN', 403);
    // This demo has immutable orders. In a real app persist/freeze the checkout quote,
    // verify its eligibility/expiry and resolve payer identity from authenticated data.
    return { amountMinor: order.amount_minor, currency: 'PEN', exponent: 2,
      version: 'immutable-v1', description: 'Demonstration order',
      payer: { email: 'demo@example.invalid' } };
  }
  async applyEvent(event) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare('SELECT 1 FROM processed_events WHERE id=?').get(event.id)) {
        if (event.type === 'payment.approved') {
          const payment = event.payment;
          const order = this.db.prepare('SELECT * FROM orders WHERE tenant=? AND id=?')
            .get(payment.tenantId, payment.payableId);
          if (!order || order.amount_minor !== payment.amountMinor || payment.currency !== 'PEN')
            throw new PaymentError('DOMAIN_MISMATCH');
          this.db.prepare('UPDATE orders SET paid=1 WHERE tenant=? AND id=?')
            .run(payment.tenantId, payment.payableId);
          // Durable fulfillment intent; another idempotent worker can perform external effects.
          this.db.prepare('INSERT OR IGNORE INTO fulfillment VALUES (?,?)')
            .run(payment.tenantId, payment.payableId);
        }
        // A real host must also handle refunds, chargebacks and dispute updates here.
        this.db.prepare('INSERT INTO processed_events VALUES (?)').run(event.id);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
