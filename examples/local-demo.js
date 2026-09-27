import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { PaymentService, SQLitePaymentStore, MercadoPagoAdapter } from '../src/index.js';
import { DemoDomain } from './domain-sqlite.js';

// Fully offline example. No network, credentials or real payment.
const directory = mkdtempSync(join(tmpdir(), 'm-pago-demo-'));
const domain = new DemoDomain(join(directory, 'domain.sqlite'));
const store = new SQLitePaymentStore(join(directory, 'ledger.sqlite'));
let payment; let creates = 0;
const provider = new MercadoPagoAdapter({ accessToken: 'APP_USR-offline-fixture', collectorId: '123', currency: 'PEN',
  environment: 'test', fetch: async (_url, init) => {
    if (init.method === 'POST') {
      creates++;
      const input = JSON.parse(init.body);
      payment = { id: '1', collector_id: 123, live_mode: false, status: 'approved', currency_id: 'PEN',
        payment_method_id: input.payment_method_id,
        external_reference: input.external_reference, transaction_amount: input.transaction_amount,
        date_last_updated: '2026-09-27T20:00:00Z', transaction_amount_refunded: 0 };
    }
    return Response.json(payment);
  } });
const operator = Object.freeze({ role: 'local-operator' });
const service = new PaymentService({ store, provider, webhookSecret: 'offline-demo-secret-not-a-credential',
  resolveQuote: (context, id) => domain.resolveQuote(context, id),
  authorizeOperator: context => context === operator });
try {
  const context = { tenantId: 'demo-tenant', userId: 'demo-user' };
  const command = { payableId: 'order-1', idempotencyKey: 'demo-key',
    instrument: { token: 'offline-fixture', paymentMethodId: 'visa', installments: 1 } };
  const result = await service.create(context, command);
  const replay = await service.create(context, command);
  assert.equal(result.id, replay.id);
  await service.dispatchEvents(operator, event => domain.applyEvent(event));
  await service.dispatchEvents(operator, event => domain.applyEvent(event));
  assert.equal(creates, 1);
  assert.equal(domain.db.prepare('SELECT COUNT(*) AS n FROM fulfillment').get().n, 1);
  console.log(JSON.stringify({ mode: 'OFFLINE_SIMULATION', paymentStatus: result.status,
    providerCreates: creates, fulfillmentIntents: 1, samePaymentOnReplay: result.id === replay.id }, null, 2));
} finally { store.close(); domain.close(); rmSync(directory, { recursive: true }); }
