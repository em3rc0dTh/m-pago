import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentHandlers } from '../src/index.js';
import { setup, context, command, yapeCommand, signed } from './helpers.js';
function request(data, headers = {}) {
  return new Request('https://example.invalid/payments', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-idempotency-key': 'key-1', ...headers },
    body: typeof data === 'string' ? data : JSON.stringify(data) });
}
function handlers(service, authenticate = async () => context) {
  return createPaymentHandlers({ service, authenticate });
}
test('HTTP command, status read and reconciliation use real service and ledger', async t => {
  const { service } = setup(t);
  const h = handlers(service);
  const response = await h.create(request(command()));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const payment = await response.json();
  const get = await h.get(new Request('https://example.invalid/payments'), { payableId: 'order-1', paymentId: payment.id });
  assert.equal((await get.json()).status, 'approved');
  const denied = await h.reconcile(request({}), { paymentId: payment.id });
  assert.equal(denied.status, 403);
});
test('HTTP boundary rejects missing auth, key, invalid JSON and large bodies', async t => {
  const { service, provider } = setup(t);
  assert.equal((await handlers(service, async () => null).create(request(command()))).status, 401);
  assert.equal((await handlers(service).create(request(command(), { 'x-idempotency-key': '' }))).status, 400);
  assert.equal((await handlers(service).create(request('{invalid'))).status, 400);
  assert.equal((await handlers(service).create(request(' '.repeat(20000)))).status, 413);
  assert.equal((await handlers(service).create(request(command(), { 'content-type': 'text/plain' }))).status, 415);
  assert.equal(provider.creates, 0);
});
test('HTTP webhook ignores forged body status and body resource, uses signed URL only', async t => {
  const { service, provider } = setup(t);
  const payment = await service.create(context, command());
  provider.change(payment.providerId, { status: 'refunded', transaction_amount_refunded: 250 });
  const signature = signed(payment.providerId);
  const result = await handlers(service).webhook(new Request(signature.url, { method: 'POST',
    headers: signature.headers, body: JSON.stringify({ data: { id: '999' }, status: 'approved' }) }));
  assert.equal(result.status, 200);
  assert.equal((await service.get(context, { payableId: 'order-1', paymentId: payment.id })).status, 'refunded');
});
test('HTTP failures do not echo internal errors or acknowledge failed provider read-back', async t => {
  const { service, provider } = setup(t);
  const h = handlers(service, async () => { throw Error('private-session-token'); });
  const response = await h.create(request(command()));
  assert.deepEqual(await response.json(), { error: 'INTERNAL_ERROR' });
  const payment = await service.create(context, command());
  provider.getPayment = async () => { throw Error('private-provider-data'); };
  const signature = signed(payment.providerId);
  const wh = await handlers(service).webhook(new Request(signature.url, { method: 'POST', headers: signature.headers }));
  assert.equal(wh.status, 500);
  assert.deepEqual(await wh.json(), { error: 'INTERNAL_ERROR' });
});
test('HTTP methods and unsigned webhooks are rejected', async t => {
  const { service } = setup(t);
  const h = handlers(service);
  assert.equal((await h.create(new Request('https://example.invalid'))).status, 405);
  assert.equal((await h.webhook(request({}))).status, 401);
});

test('HTTP Yape command reaches the same payment core without phone or OTP fields', async t => {
  const { service, provider } = setup(t);
  const response = await handlers(service).create(request(yapeCommand()));
  assert.equal(response.status, 200);
  const payment = await response.json();
  assert.equal(payment.paymentMethodId, 'yape');
  assert.equal(provider.lastInput.instrument.paymentMethodId, 'yape');
  assert.equal(provider.lastInput.instrument.installments, 1);
  assert.equal('phoneNumber' in provider.lastInput.instrument, false);
  assert.equal('otp' in provider.lastInput.instrument, false);
});
