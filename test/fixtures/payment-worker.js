import { MercadoPagoAdapter, PaymentService, SQLitePaymentStore } from '../../src/index.js';
import { context, command, quote, secret } from '../helpers.js';
const [filename, endpoint, key, crash] = process.argv.slice(2);
const store = new SQLitePaymentStore(filename);
const provider = new MercadoPagoAdapter({ accessToken: 'TEST-fixture', currency: 'PEN', collectorId: '123',
  fetch: (url, init) => fetch(endpoint + new URL(url).pathname + new URL(url).search, init) });
if (crash === 'crash') {
  const create = provider.createPayment.bind(provider);
  provider.createPayment = async input => { await create(input); process.exit(23); };
}
const service = new PaymentService({ store, provider, webhookSecret: secret, resolveQuote: async () => quote,
  authorizeOperator: async () => false });
process.send({ ready: true });
process.once('message', async () => {
  try { process.send({ result: await service.create(context, command(key)) }); }
  catch (error) { process.send({ error: error.code ?? 'INTERNAL_ERROR' }); }
  finally { store.close(); process.disconnect(); }
});
