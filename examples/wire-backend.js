import { MercadoPagoAdapter, PaymentService, SQLitePaymentStore, createPaymentHandlers } from '../src/index.js';

/** Call from your backend after implementing the three application hooks. No server auto-starts. */
export function wireBackend({ resolveQuote, authenticate, authorizeOperator, env = process.env }) {
  const provider = new MercadoPagoAdapter({ accessToken: env.MP_ACCESS_TOKEN,
    collectorId: env.MP_COLLECTOR_ID, currency: env.MP_CURRENCY, exponent: Number(env.MP_EXPONENT ?? 2),
    environment: env.MP_ENVIRONMENT,
    allowLive: env.MP_ALLOW_LIVE === 'true' });
  const store = new SQLitePaymentStore(env.MP_DATABASE_PATH);
  const service = new PaymentService({ store, provider, resolveQuote, authorizeOperator,
    webhookSecret: env.MP_WEBHOOK_SECRET });
  return { service, handlers: createPaymentHandlers({ service, authenticate }), close: () => store.close() };
}
