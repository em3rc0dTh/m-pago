import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MercadoPagoAdapter, PaymentService, SQLitePaymentStore } from '../src/index.js';
import { context, operator, quote, secret } from './helpers.js';

async function environment(t) {
  const directory = mkdtempSync(join(tmpdir(), 'm-pago-test-'));
  const filename = join(directory, 'ledger.sqlite');
  const initial = new SQLitePaymentStore(filename); initial.close();
  const payments = new Map(); let creates = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let value;
    if (req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const input = JSON.parse(body); creates++;
      const id = String(creates);
      value = { id, external_reference: input.external_reference, transaction_amount: input.transaction_amount,
        currency_id: 'PEN', collector_id: 123, live_mode: false, status: 'approved',
        date_last_updated: '2026-09-27T20:00:00Z', transaction_amount_refunded: 0 };
      payments.set(id, value);
    } else if (url.pathname.endsWith('/search')) {
      const results = [...payments.values()].filter(p => p.external_reference === url.searchParams.get('external_reference'));
      value = { paging: { total: results.length }, results };
    } else value = payments.get(url.pathname.split('/').at(-1));
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true }); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return { filename, endpoint, payments, creates: () => creates };
}
async function worker(t, env, key, crash = '') {
  const child = fork(new URL('./fixtures/payment-worker.js', import.meta.url), [env.filename, env.endpoint, key, crash],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let errorOutput = ''; child.stderr.on('data', d => { errorOutput += d; });
  const ready = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw Error(errorOutput); })]);
  assert.equal(ready[0].ready, true);
  const result = new Promise((resolve, reject) => {
    let last;
    child.on('message', msg => { last = msg; });
    child.once('exit', code => code === 0 || code === 23 ? resolve({ code, ...last }) : reject(Error(errorOutput)));
  });
  return { child, result };
}
function reopened(t, env) {
  const store = new SQLitePaymentStore(env.filename); t.after(() => store.close());
  const provider = new MercadoPagoAdapter({ accessToken: 'TEST-fixture', currency: 'PEN', collectorId: '123',
    fetch: (url, init) => fetch(env.endpoint + new URL(url).pathname + new URL(url).search, init) });
  const service = new PaymentService({ store, provider, webhookSecret: secret, resolveQuote: async () => quote,
    authorizeOperator: async actor => actor?.role === 'payments-operator' });
  return { store, service };
}
test('six independent processes share one atomic claim and make one provider POST', { timeout: 15000 }, async t => {
  const env = await environment(t);
  const workers = await Promise.all(Array.from({ length: 6 }, (_, i) => worker(t, env, `key-${i}`)));
  workers.forEach(w => w.child.send('start'));
  const results = await Promise.all(workers.map(w => w.result));
  assert.equal(results.filter(r => r.result?.status === 'approved').length, 1);
  assert.equal(results.filter(r => r.error === 'PAYMENT_ALREADY_ACTIVE').length, 5);
  assert.equal(env.creates(), 1);
});
test('process death after accepted provider POST recovers payment and outbox from disk', { timeout: 15000 }, async t => {
  const env = await environment(t);
  const process = await worker(t, env, 'key-1', 'crash'); process.child.send('start');
  assert.equal((await process.result).code, 23);
  const { store, service } = reopened(t, env);
  const record = store.list()[0];
  assert.equal(record.status, 'creating'); assert.equal(record.providerId, null);
  assert.equal((await service.reconcile(operator, record.id)).status, 'approved');
  assert.equal(env.creates(), 1);
  const lease = store.leaseEvent({ now: 1, leaseMs: 1 });
  // Simulates worker death after domain commit, before outbox acknowledgement.
  const domain = new Set([lease.event.id]);
  let applied = 1;
  await service.dispatchEvents(operator, event => { if (!domain.has(event.id)) { domain.add(event.id); applied++; } });
  assert.equal(applied, 1);
  assert.equal(store.leaseEvent(), null);
  const files = [env.filename, `${env.filename}-wal`];
  for (const file of files) {
    const content = readFileSync(file).toString('utf8');
    assert.equal(content.includes('fixture-card-token'), false);
    assert.equal(content.includes('fixture@example.invalid'), false);
  }
  assert.equal((await service.get(context, { payableId: 'order-1', paymentId: record.id })).status, 'approved');
});

test('failed outbox insertion rolls back ledger state; later reconciliation recovers atomically', { timeout: 15000 }, async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const env = await environment(t);
  const { store, service } = reopened(t, env);
  const control = new DatabaseSync(env.filename); t.after(() => control.close());
  control.exec("CREATE TRIGGER block_event BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
  await assert.rejects(service.create(context, { payableId: 'order-1', idempotencyKey: 'rollback-key',
    instrument: { token: 'fixture', paymentMethodId: 'visa', installments: 1 } }));
  const record = store.list()[0];
  assert.equal(record.status, 'creating'); assert.equal(record.version, 0);
  assert.equal(store.leaseEvent(), null);
  control.exec('DROP TRIGGER block_event');
  assert.equal((await service.reconcile(operator, record.id)).status, 'approved');
  assert.equal(store.leaseEvent().event.type, 'payment.approved');
  assert.equal(env.creates(), 1);
});
