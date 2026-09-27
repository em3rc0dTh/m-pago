import { createHmac } from 'node:crypto';
import { PaymentService, SQLitePaymentStore, PaymentError } from '../src/index.js';
export const secret = 'fixture-webhook-secret-not-a-credential';
export const context = { tenantId: 'tenant-a', userId: 'user-a' };
export const operator = { role: 'payments-operator' };
export const command = (key = 'key-1', payableId = 'order-1') => ({ payableId, idempotencyKey: key,
  instrument: { token: 'fixture-card-token', paymentMethodId: 'visa', installments: 1 } });
export const quote = { amountMinor: 25000, currency: 'PEN', exponent: 2, version: 'v1',
  description: 'Fixture order', payer: { email: 'fixture@example.invalid' } };
export function signed(id, { now = Date.now(), ts = String(Math.floor(now / 1000)), requestId = 'request-1' } = {}) {
  const v1 = createHmac('sha256', secret).update(`id:${id.toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex');
  return { url: `https://example.invalid/webhook?data.id=${id}`, headers: {
    'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId }, secret, now };
}
export class FakeProvider {
  account = { collectorId: '123', currency: 'PEN', exponent: 2, liveMode: false };
  payments = new Map(); creates = 0; gets = 0;
  async createPayment({ record, instrument, payer }) {
    this.creates++;
    this.lastInput = { record, instrument, payer };
    const id = String(this.creates);
    this.payments.set(id, { id, external_reference: record.id, transaction_amount: 250,
      currency_id: 'PEN', collector_id: 123, live_mode: false, status: 'approved',
      transaction_amount_refunded: 0, date_last_updated: '2026-09-27T20:00:00.000Z' });
    return { id };
  }
  async getPayment(id) { this.gets++; return structuredClone(this.payments.get(id)); }
  async findPaymentIds(reference) {
    return [...this.payments.values()].filter(p => p.external_reference === reference).map(p => p.id);
  }
  change(id, patch) {
    const previous = this.payments.get(id);
    Object.assign(previous, { date_last_updated: new Date(Date.parse(previous.date_last_updated) + 1000).toISOString() }, patch);
  }
}
export function setup(t, options = {}) {
  const store = options.store ?? new SQLitePaymentStore(':memory:');
  t.after(() => store.close());
  const provider = options.provider ?? new FakeProvider();
  const service = new PaymentService({ store, provider, webhookSecret: secret,
    authorizeOperator: async actor => actor?.role === 'payments-operator',
    resolveQuote: async actor => {
      if (actor.userId !== context.userId || actor.tenantId !== context.tenantId) throw new PaymentError('FORBIDDEN', 403);
      return structuredClone(quote);
    }, ...options, store, provider });
  return { store, provider, service };
}
