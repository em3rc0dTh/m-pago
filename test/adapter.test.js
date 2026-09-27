import test from 'node:test';
import assert from 'node:assert/strict';
import { MercadoPagoAdapter, verifyWebhook } from '../src/index.js';
import { toMinor } from '../src/money.js';
import { secret, signed } from './helpers.js';
const config = { accessToken: 'TEST-fixture-not-a-credential', currency: 'PEN', collectorId: '123' };
const code = expected => e => e.code === expected;

test('adapter sends server UUID idempotency key and safe allowlisted body to fixed HTTPS API', async () => {
  let captured;
  const provider = new MercadoPagoAdapter({ ...config, fetch: async (url, init) => {
    captured = { url, init }; return Response.json({ id: 42 });
  } });
  await provider.createPayment({ record: { id: 'server-attempt-id', amountMinor: 101, exponent: 2 },
    instrument: { token: 'fixture', paymentMethodId: 'visa', installments: 1 },
    payer: { email: 'test@example.invalid' }, description: 'Test' });
  assert.equal(captured.url, 'https://api.mercadopago.com/v1/payments');
  assert.equal(captured.init.headers['X-Idempotency-Key'], 'server-attempt-id');
  assert.equal(captured.init.redirect, 'error');
  assert.equal(JSON.parse(captured.init.body).transaction_amount, 1.01);
  assert.equal('currency_id' in JSON.parse(captured.init.body), false);
  assert.equal(JSON.stringify(provider).includes('TEST-fixture'), false);
});
for (const status of [400, 401, 429, 500]) test(`HTTP ${status} is sanitized and not blindly retried`, async () => {
  let calls = 0;
  const provider = new MercadoPagoAdapter({ ...config, fetch: async () => {
    calls++; return Response.json({ token: 'sensitive-provider-body' }, { status });
  } });
  await assert.rejects(provider.getPayment('42'), e => e.code === 'PROVIDER_UNAVAILABLE' && !e.message.includes('sensitive'));
  assert.equal(calls, 1);
});
test('network failure and malformed JSON are sanitized', async () => {
  for (const fetch of [async () => { throw Error('secret'); }, async () => new Response('not-json')]) {
    const provider = new MercadoPagoAdapter({ ...config, fetch });
    await assert.rejects(provider.getPayment('42'), code('PROVIDER_UNAVAILABLE'));
  }
});
test('timeout aborts a stalled provider request', async () => {
  const provider = new MercadoPagoAdapter({ ...config, timeoutMs: 5, fetch: (_, { signal }) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json({})), 200);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    }) });
  await assert.rejects(provider.getPayment('42'), code('PROVIDER_UNAVAILABLE'));
});
test('TEST default rejects production token before I/O; LIVE needs explicit opt-in', () => {
  assert.throws(() => new MercadoPagoAdapter({ ...config, accessToken: 'APP_USR-fixture' }), code('TEST_CREDENTIAL_REQUIRED'));
  assert.throws(() => new MercadoPagoAdapter({ ...config, liveMode: true }), code('LIVE_MODE_DISABLED'));
});
test('provider ids reject unsafe integers and URL injection', async () => {
  const provider = new MercadoPagoAdapter(config);
  await assert.rejects(provider.getPayment(Number.MAX_SAFE_INTEGER + 1), code('INVALID_PROVIDER_ID'));
  await assert.rejects(provider.getPayment('../users'), code('INVALID_PROVIDER_ID'));
});
test('recovery search detects duplicate results using total even if pagination truncates them', async () => {
  const provider = new MercadoPagoAdapter({ ...config, fetch: async () => Response.json({
    paging: { total: 3 }, results: [{ id: 1, external_reference: 'ref' }],
  }) });
  await assert.rejects(provider.findPaymentIds('ref'), code('AMBIGUOUS_PROVIDER_RESULT'));
});
test('recovery search checks its response shape and exact reference', async () => {
  for (const [result, expected] of [
    [{}, 'INVALID_PROVIDER_SEARCH'],
    [{ paging: { total: 1 }, results: [{ id: 1, external_reference: 'other' }] }, 'PROVIDER_REFERENCE_MISMATCH'],
  ]) {
    const p = new MercadoPagoAdapter({ ...config, fetch: async () => Response.json(result) });
    await assert.rejects(p.findPaymentIds('ref'), code(expected));
  }
});
test('money conversion uses exact minor units and rejects excess fractional digits', () => {
  assert.equal(toMinor(0.29, 2), 29);
  assert.equal(toMinor('250.000', 2), 25000);
  assert.equal(toMinor('42', 0), 42);
  for (const value of [0.001, NaN, Infinity, -1, '1e3', '01.0'])
    assert.throws(() => toMinor(value, 2), code('INVALID_PROVIDER_AMOUNT'));
});
test('webhook signature supports documented seconds/milliseconds and lowercases alphanumeric ids', () => {
  assert.equal(verifyWebhook(signed('ABC123')).dataId, 'abc123');
  assert.equal(verifyWebhook(signed('12', { ts: String(Date.now()) })).dataId, '12');
});
for (const [name, change] of [
  ['tampered resource', input => { input.url = input.url.replace('12', '13'); }],
  ['missing request id', input => { delete input.headers['x-request-id']; }],
  ['missing signature', input => { delete input.headers['x-signature']; }],
  ['duplicate ts', input => { input.headers['x-signature'] += ',ts=1704908010'; }],
  ['duplicate query', input => { input.url += '&data.id=12'; }],
  ['malformed hex', input => { input.headers['x-signature'] = 'ts=1704908010,v1=zzz'; }],
  ['stale delivery', input => { input.now += 301000; }],
  ['future delivery', input => { input.now -= 301000; }],
  ['wrong secret', input => { input.secret = secret + 'wrong'; }],
]) test(`webhook rejects ${name}`, () => {
  const input = signed('12'); change(input);
  assert.throws(() => verifyWebhook(input), code('INVALID_SIGNATURE'));
});
