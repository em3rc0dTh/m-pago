import { PaymentError, requireThat } from './errors.js';

async function body(request) {
  requireThat(request.headers.get('content-type')?.split(';')[0].trim() === 'application/json',
    'JSON_REQUIRED', 415);
  requireThat(request.body, 'INVALID_JSON');
  const reader = request.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) { await reader.cancel(); throw new PaymentError('BODY_TOO_LARGE', 413); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new PaymentError('INVALID_JSON', 400); }
  } finally { reader.releaseLock(); }
}
const json = (value, status = 200) => Response.json(value, { status,
  headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
function endpoint(method, fn) {
  return async (request, ...args) => {
    try {
      requireThat(request.method === method, 'METHOD_NOT_ALLOWED', 405);
      return await fn(request, ...args);
    } catch (error) {
      return json({ error: error instanceof PaymentError ? error.code : 'INTERNAL_ERROR' },
        error instanceof PaymentError ? error.status : 500);
    }
  };
}
/** Mount these handlers in your framework. authenticate must enforce auth AND CSRF policy. */
export function createPaymentHandlers({ service, authenticate }) {
  requireThat(typeof authenticate === 'function', 'AUTHENTICATOR_REQUIRED');
  return {
    create: endpoint('POST', async request => {
      const context = await authenticate(request);
      requireThat(context, 'UNAUTHORIZED', 401);
      const input = await body(request);
      requireThat(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_COMMAND');
      const result = await service.create(context, { payableId: input.payableId,
        instrument: input.instrument, idempotencyKey: request.headers.get('x-idempotency-key') });
      return json(result, result.status === 'creating' ? 202 : 200);
    }),
    get: endpoint('GET', async (request, { payableId, paymentId }) => {
      const context = await authenticate(request);
      requireThat(context, 'UNAUTHORIZED', 401);
      return json(await service.get(context, { payableId, paymentId }));
    }),
    webhook: endpoint('POST', async request => {
      await service.webhook({ url: request.url, headers: request.headers });
      return json({ received: true });
    }),
    reconcile: endpoint('POST', async (request, { paymentId }) => {
      const context = await authenticate(request);
      requireThat(context, 'UNAUTHORIZED', 401);
      return json(await service.reconcile(context, paymentId));
    }),
  };
}
