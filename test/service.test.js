import test from 'node:test';
import assert from 'node:assert/strict';
import { PaymentService, PaymentError, SQLitePaymentStore } from '../src/index.js';
import { setup, context, operator, command, quote, secret, signed, FakeProvider } from './helpers.js';

const code = expected => error => error.code === expected;

test('backend owns amount, currency and payer; read-back creates one durable approval', async t => {
  const { service, provider, store } = setup(t);
  const result = await service.create(context, { ...command(), amountMinor: 1, currency: 'USD', payer: { email: 'attacker@invalid.test' } });
  assert.equal(result.amountMinor, 25000);
  assert.equal(result.status, 'approved');
  assert.equal(provider.gets, 1);
  assert.equal(provider.lastInput.payer.email, quote.payer.email);
  assert.equal(store.leaseEvent().event.type, 'payment.approved');
  assert.equal(JSON.stringify(result).includes('token'), false);
});
test('same-key replay re-reads provider and never emits a duplicate approval', async t => {
  const { service, provider } = setup(t);
  const original = await service.create(context, command());
  for (let i = 0; i < 3; i++) assert.equal((await service.create(context, command())).id, original.id);
  const delivered = [];
  await service.dispatchEvents(operator, event => delivered.push(event));
  assert.equal(provider.creates, 1);
  assert.equal(delivered.length, 1);
});
test('different keys racing for one payable call provider exactly once', async t => {
  const { service, provider } = setup(t);
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => service.create(context, command(`key-${i}`))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(provider.creates, 1);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'PAYMENT_ALREADY_ACTIVE'));
});
test('same key cannot change payable, token, or frozen quote', async t => {
  const { service } = setup(t);
  await service.create(context, command());
  await assert.rejects(service.create(context, command('key-1', 'order-2')), code('IDEMPOTENCY_CONFLICT'));
  const altered = command(); altered.instrument.token = 'different-token';
  await assert.rejects(service.create(context, altered), code('IDEMPOTENCY_CONFLICT'));
});
test('authorization runs on replays and reads, before exposing any ledger result', async t => {
  const { service, provider } = setup(t);
  const result = await service.create(context, command());
  const other = { ...context, userId: 'other' };
  await assert.rejects(service.create(other, command()), code('FORBIDDEN'));
  await assert.rejects(service.get(other, { payableId: 'order-1', paymentId: result.id }), code('FORBIDDEN'));
  assert.equal(provider.creates, 1);
});
for (const [name, patch, expected] of [
  ['amount', { transaction_amount: 1 }, 'PROVIDER_AMOUNT_MISMATCH'],
  ['currency', { currency_id: 'USD' }, 'PROVIDER_CURRENCY_MISMATCH'],
  ['reference', { external_reference: 'foreign' }, 'PROVIDER_REFERENCE_MISMATCH'],
  ['collector', { collector_id: 999 }, 'PROVIDER_ACCOUNT_MISMATCH'],
  ['environment', { live_mode: true }, 'PROVIDER_MODE_MISMATCH'],
  ['id', { id: '999' }, 'PROVIDER_ID_MISMATCH'],
  ['timestamp', { date_last_updated: null }, 'INVALID_PROVIDER_TIMESTAMP'],
  ['fraction', { transaction_amount: 250.001 }, 'INVALID_PROVIDER_AMOUNT'],
]) test(`provider ${name} mismatch cannot approve or release claim`, async t => {
  const provider = new FakeProvider();
  const get = provider.getPayment.bind(provider);
  provider.getPayment = async id => ({ ...await get(id), ...patch });
  const { service, store } = setup(t, { provider });
  await assert.rejects(service.create(context, command()), code(expected));
  assert.equal(store.list()[0].status, 'creating');
  assert.equal(store.leaseEvent(), null);
  await assert.rejects(service.create(context, command('key-2')), code('PAYMENT_ALREADY_ACTIVE'));
});
test('uncertain POST and zero-result search retain claim; recovery uses GET only', async t => {
  const provider = new FakeProvider();
  const create = provider.createPayment.bind(provider);
  provider.createPayment = async args => { await create(args); throw new PaymentError('PROVIDER_UNAVAILABLE', 503); };
  const { service, store } = setup(t, { provider });
  await assert.rejects(service.create(context, command()), code('PROVIDER_UNAVAILABLE'));
  const local = store.list()[0];
  const search = provider.findPaymentIds.bind(provider);
  provider.findPaymentIds = async () => [];
  assert.equal((await service.reconcile(operator, local.id)).status, 'creating');
  assert.equal((await service.create(context, command())).status, 'creating');
  await assert.rejects(service.create(context, command('another')), code('PAYMENT_ALREADY_ACTIVE'));
  provider.findPaymentIds = search;
  assert.equal((await service.reconcile(operator, local.id)).status, 'approved');
  assert.equal(provider.creates, 1);
});
test('unknown provider status fails closed and keeps claim', async t => {
  const { service, provider } = setup(t);
  const get = provider.getPayment.bind(provider);
  provider.getPayment = async id => ({ ...await get(id), status: 'new_future_status' });
  const result = await service.create(context, command());
  assert.equal(result.status, 'unknown');
  await assert.rejects(service.create(context, command('key-2')), code('PAYMENT_ALREADY_ACTIVE'));
  const events = [];
  await service.dispatchEvents(operator, event => events.push(event));
  assert.equal(events[0].type, 'payment.updated');
});
for (const status of ['rejected', 'cancelled']) test(`verified ${status} allows a new attempt`, async t => {
  const { service, provider } = setup(t);
  const get = provider.getPayment.bind(provider);
  provider.getPayment = async id => ({ ...await get(id), status });
  const first = await service.create(context, command());
  const second = await service.create(context, command('key-2'));
  assert.notEqual(first.id, second.id);
  assert.equal(provider.creates, 2);
});
for (const status of ['refunded', 'charged_back']) test(`${status} remains distinct and cannot reopen the payable`, async t => {
  const { service, provider } = setup(t);
  const first = await service.create(context, command());
  provider.change(first.providerId, { status, transaction_amount_refunded: status === 'refunded' ? 250 : 0 });
  assert.equal((await service.reconcile(operator, first.id)).status, status);
  await assert.rejects(service.create(context, command('key-2')), code('PAYMENT_ALREADY_ACTIVE'));
});
test('partial refunds produce state updates without repeating fulfillment', async t => {
  const { service, provider } = setup(t);
  const result = await service.create(context, command());
  provider.change(result.providerId, { transaction_amount_refunded: 10 });
  const updated = await service.reconcile(operator, result.id);
  assert.equal(updated.status, 'partially_refunded'); assert.equal(updated.refundedMinor, 1000);
  const events = [];
  await service.dispatchEvents(operator, event => events.push(event));
  assert.deepEqual(events.map(e => e.type), ['payment.approved', 'payment.updated']);
});
test('stale, conflicting and regressive snapshots cannot undo approval', async t => {
  const { service, provider } = setup(t);
  const result = await service.create(context, command());
  const p = provider.payments.get(result.providerId);
  const original = structuredClone(p);
  Object.assign(p, { status: 'pending', date_last_updated: '2026-09-26T20:00:00Z' });
  assert.equal((await service.reconcile(operator, result.id)).status, 'approved');
  Object.assign(p, { ...original, status: 'pending' });
  await assert.rejects(service.reconcile(operator, result.id), code('AMBIGUOUS_PROVIDER_VERSION'));
  provider.change(result.providerId, { status: 'pending' });
  await assert.rejects(service.reconcile(operator, result.id), code('STATE_REGRESSION'));
});
test('webhook reads signed URL resource, repeated delivery is idempotent', async t => {
  const { service, provider } = setup(t);
  const result = await service.create(context, command());
  await service.webhook(signed(result.providerId));
  await service.webhook(signed(result.providerId));
  assert.equal(provider.gets, 3);
  let count = 0;
  await service.dispatchEvents(operator, () => count++);
  assert.equal(count, 1);
});
test('operator privileges are mandatory for both recovery and event delivery', async t => {
  const { service } = setup(t);
  const result = await service.create(context, command());
  await assert.rejects(service.reconcile(context, result.id), code('FORBIDDEN'));
  await assert.rejects(service.reconcileBatch(context), code('FORBIDDEN'));
  await assert.rejects(service.dispatchEvents(context, () => {}), code('FORBIDDEN'));
});
test('batch reconciliation reports isolated failures and a continuation cursor', async t => {
  const { service } = setup(t);
  await service.create(context, command('a', 'one'));
  await service.create(context, command('b', 'two'));
  const page = await service.reconcileBatch(operator, { limit: 1 });
  assert.equal(page.results.length, 1); assert.ok(page.nextCursor);
  const next = await service.reconcileBatch(operator, { after: page.nextCursor });
  assert.equal(next.results.length, 1);
});
test('durable outbox retries failed consumers and fences obsolete workers', async t => {
  const { service, store } = setup(t);
  await service.create(context, command());
  assert.deepEqual(await service.dispatchEvents(operator, () => { throw Error('secret-payload'); }),
    { delivered: 0, error: 'INTERNAL_ERROR' });
  assert.equal(store.leaseEvent(), null);
  const lease = store.leaseEvent({ now: Date.now() + 5000, leaseMs: 1 });
  const replacement = store.leaseEvent({ now: Date.now() + 6000 });
  assert.equal(lease.event.id, replacement.event.id);
  assert.throws(() => store.ackEvent(lease.event.id, lease.token), code('EVENT_LEASE_LOST'));
  store.ackEvent(replacement.event.id, replacement.token);
});
test('ledger never stores token, email or identification', async t => {
  const { service, store } = setup(t);
  await service.create(context, command());
  const contents = JSON.stringify(store.list());
  assert.equal(contents.includes('fixture-card-token'), false);
  assert.equal(contents.includes(quote.payer.email), false);
});
test('merchant/environment mismatch cannot share an existing ledger', t => {
  const { store } = setup(t);
  assert.throws(() => new PaymentService({ store, provider: { account: { collectorId: '999', liveMode: true,
    currency: 'PEN', exponent: 2 } }, resolveQuote: () => quote, authorizeOperator: () => false,
    webhookSecret: secret }), code('DATABASE_ACCOUNT_MISMATCH'));
});
test('required key and PAN/CVV-like extra instrument fields are rejected before provider I/O', async t => {
  const { service, provider } = setup(t);
  await assert.rejects(service.create(context, { ...command(), idempotencyKey: undefined }), code('INVALID_IDEMPOTENCY_KEY'));
  const raw = command(); raw.instrument.cvv = 'fixture';
  await assert.rejects(service.create(context, raw), code('UNSUPPORTED_INSTRUMENT_FIELD'));
  assert.equal(provider.creates, 0);
});
test('same client key and payable id are isolated between tenants', async t => {
  const { service, provider } = setup(t, { resolveQuote: async () => quote });
  await service.create(context, command());
  await service.create({ ...context, tenantId: 'tenant-b' }, command());
  assert.equal(provider.creates, 2);
});

test('changed authoritative quote cannot reuse a key or bypass an existing claim', async t => {
  let amountMinor = quote.amountMinor;
  const { service, provider } = setup(t, { resolveQuote: async () => ({ ...quote, amountMinor }) });
  await service.create(context, command());
  amountMinor++;
  await assert.rejects(service.create(context, command()), code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(service.create(context, command('key-2')), code('PAYMENT_ALREADY_ACTIVE'));
  assert.equal(provider.creates, 1);
});
test('concurrent GET snapshots completing out of order preserve newer refunded state', async t => {
  const { service, provider } = setup(t);
  const result = await service.create(context, command());
  const old = structuredClone(provider.payments.get(result.providerId));
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const get = provider.getPayment.bind(provider);
  let first = true;
  provider.getPayment = async id => {
    if (first) { first = false; started(); await wait; return old; }
    return get(id);
  };
  const slow = service.reconcile(operator, result.id);
  await entered;
  provider.change(result.providerId, { status: 'refunded', transaction_amount_refunded: 250 });
  await service.reconcile(operator, result.id);
  release();
  assert.equal((await slow).status, 'refunded');
});
