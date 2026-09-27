import { createHash, randomUUID } from 'node:crypto';
import { requireThat, identifier, providerId, safeCode } from './errors.js';
import { validateMoney } from './money.js';
import { verifyPayment, publicPayment } from './state.js';
import { verifyWebhook } from './webhook.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function actor(context) {
  identifier(context?.tenantId, 'UNAUTHORIZED');
  identifier(context?.userId, 'UNAUTHORIZED');
}
function instrumentFrom(value) {
  requireThat(value && typeof value === 'object', 'INVALID_INSTRUMENT');
  requireThat(Object.keys(value).every(k => ['token', 'paymentMethodId', 'installments', 'issuerId'].includes(k)),
    'UNSUPPORTED_INSTRUMENT_FIELD');
  const token = identifier(value.token, 'INVALID_TOKEN');
  const paymentMethodId = identifier(value.paymentMethodId, 'INVALID_PAYMENT_METHOD');
  const installments = value.installments ?? 1;
  requireThat(Number.isInteger(installments) && installments > 0 && installments <= 48, 'INVALID_INSTALLMENTS');
  return { token, paymentMethodId, installments,
    ...(value.issuerId === undefined ? {} : { issuerId: identifier(value.issuerId, 'INVALID_ISSUER') }) };
}
function quoteFrom(value, account) {
  requireThat(value && typeof value === 'object', 'INVALID_QUOTE');
  validateMoney(value.amountMinor, value.currency, value.exponent);
  requireThat(value.currency === account.currency && value.exponent === account.exponent, 'MERCHANT_CURRENCY_MISMATCH');
  const version = identifier(value.version, 'INVALID_QUOTE_VERSION');
  requireThat(typeof value.description === 'string' && value.description.length > 0 &&
    value.description.length <= 200, 'INVALID_DESCRIPTION');
  requireThat(typeof value.payer?.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.payer.email) &&
    value.payer.email.length <= 254, 'INVALID_PAYER');
  const payer = { email: value.payer.email };
  if (value.payer.identification) {
    payer.identification = {
      type: identifier(value.payer.identification.type, 'INVALID_PAYER_IDENTIFICATION'),
      number: identifier(value.payer.identification.number, 'INVALID_PAYER_IDENTIFICATION'),
    };
  }
  return { amountMinor: value.amountMinor, currency: value.currency, exponent: value.exponent,
    version, description: value.description, payer };
}

export class PaymentService {
  #store; #provider; #resolveQuote; #authorizeOperator; #secret; #ready;
  constructor({ store, provider, resolveQuote, authorizeOperator, webhookSecret }) {
    requireThat(store && provider?.account && typeof resolveQuote === 'function' &&
      typeof authorizeOperator === 'function', 'INVALID_SERVICE_CONFIG');
    requireThat(typeof webhookSecret === 'string' && webhookSecret.length >= 16, 'INVALID_WEBHOOK_CONFIG');
    this.#store = store;
    this.#provider = provider;
    this.#resolveQuote = resolveQuote;
    this.#authorizeOperator = authorizeOperator;
    this.#secret = webhookSecret;
    this.#ready = store.bindAccount(provider.account);
  }
  async create(context, command) {
    await this.#ready;
    actor(context);
    identifier(command?.payableId, 'INVALID_PAYABLE_ID');
    identifier(command?.idempotencyKey, 'INVALID_IDEMPOTENCY_KEY');
    const instrument = instrumentFrom(command.instrument);
    // The host resolves identity, ownership, price and payer from its database.
    const quote = quoteFrom(await this.#resolveQuote(context, command.payableId), this.#provider.account);
    const fingerprint = digest([command.payableId, quote, instrument]);
    const id = randomUUID();
    const candidate = { id, tenantId: context.tenantId, userId: context.userId, payableId: command.payableId,
      requestKey: digest([context.tenantId, context.userId, command.idempotencyKey]),
      activeKey: digest([context.tenantId, command.payableId]), fingerprint,
      amountMinor: quote.amountMinor, currency: quote.currency, exponent: quote.exponent,
      quoteVersion: quote.version, providerId: null, providerStatus: null, status: 'creating',
      providerUpdatedAt: null, refundedMinor: 0, everApproved: false, version: 0, createdAt: Date.now() };
    const claimed = await this.#store.claim(candidate);
    let record = claimed.record;
    if (!claimed.created) {
      // Never POST again after an ambiguous outcome, even with the same key.
      if (record.providerId) record = await this.#sync(record.providerId);
      return publicPayment(record);
    }
    const created = await this.#provider.createPayment({ record, instrument, payer: quote.payer,
      description: quote.description });
    await this.#store.attachProviderId(record.id, providerId(created.id));
    record = await this.#sync(providerId(created.id));
    return publicPayment(record);
  }
  async #sync(id) {
    const payment = await this.#provider.getPayment(id);
    requireThat(providerId(payment.id) === id, 'PROVIDER_ID_MISMATCH', 409);
    const record = await this.#store.getByProviderId(id) ??
      (typeof payment.external_reference === 'string' ? await this.#store.get(payment.external_reference) : null);
    if (!record) return null; // Valid webhook for another integration in this merchant account.
    const snapshot = verifyPayment(record, payment, this.#provider.account);
    return this.#store.apply(record.id, snapshot);
  }
  async get(context, { payableId, paymentId }) {
    await this.#ready;
    actor(context);
    identifier(payableId); identifier(paymentId);
    await this.#resolveQuote(context, payableId); // Authorization is required on every read/replay.
    const record = await this.#store.get(paymentId);
    requireThat(record && record.tenantId === context.tenantId && record.userId === context.userId &&
      record.payableId === payableId, 'PAYMENT_NOT_FOUND', 404);
    return publicPayment(record);
  }
  async webhook({ url, headers }) {
    await this.#ready;
    const signed = verifyWebhook({ url, headers, secret: this.#secret });
    // Only Payments API numeric identifiers. Other topics need a separate adapter.
    requireThat(/^\d+$/.test(signed.dataId), 'UNSUPPORTED_WEBHOOK_RESOURCE');
    const record = await this.#sync(providerId(signed.dataId));
    return { received: true, matched: record !== null };
  }
  async #operator(context, action) {
    requireThat(await this.#authorizeOperator(context, action) === true, 'FORBIDDEN', 403);
  }
  async #recover(record) {
    if (record.providerId) return this.#sync(record.providerId);
    const ids = await this.#provider.findPaymentIds(record.id);
    requireThat(Array.isArray(ids) && ids.length <= 1, 'AMBIGUOUS_PROVIDER_RESULT', 409);
    // Empty searches (including eventual consistency) are NOT proof of no charge.
    if (ids.length === 0) return record;
    const recovered = await this.#sync(providerId(ids[0]));
    requireThat(recovered?.id === record.id, 'PROVIDER_REFERENCE_MISMATCH', 409);
    return recovered;
  }
  async reconcile(context, paymentId) {
    await this.#ready;
    await this.#operator(context, 'reconcile');
    identifier(paymentId);
    const record = await this.#store.get(paymentId);
    requireThat(record, 'PAYMENT_NOT_FOUND', 404);
    return publicPayment(await this.#recover(record));
  }
  async reconcileBatch(context, { after = '', limit = 100 } = {}) {
    await this.#ready;
    await this.#operator(context, 'reconcile');
    const records = await this.#store.list({ after, limit });
    const results = [];
    for (const record of records) {
      try { results.push({ id: record.id, status: (await this.#recover(record)).status }); }
      catch (error) { results.push({ id: record.id, error: safeCode(error) }); }
    }
    return { results, nextCursor: records.length === limit ? records.at(-1).id : null };
  }
  async dispatchEvents(context, handler, { limit = 100 } = {}) {
    await this.#ready;
    await this.#operator(context, 'outbox');
    requireThat(typeof handler === 'function' && Number.isInteger(limit) && limit > 0 && limit <= 1000,
      'INVALID_DISPATCH');
    let delivered = 0;
    while (delivered < limit) {
      const delivery = await this.#store.leaseEvent();
      if (!delivery) break;
      try {
        // At least once. Host MUST atomically deduplicate event.id with business mutation.
        await handler(delivery.event);
        await this.#store.ackEvent(delivery.event.id, delivery.token);
        delivered++;
      } catch (error) {
        await this.#store.retryEvent(delivery.event.id, delivery.token,
          Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(delivery.attempts, 8)));
        return { delivered, error: safeCode(error) };
      }
    }
    return { delivered };
  }
}
