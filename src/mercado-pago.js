import { PaymentError, requireThat, providerId } from './errors.js';
import { toMajor } from './money.js';

export class MercadoPagoAdapter {
  #accessToken;
  #fetch;
  #timeoutMs;
  constructor({ accessToken, currency, exponent = 2, collectorId, liveMode = false,
    allowLive = false, fetch: fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
    requireThat(typeof accessToken === 'string' && accessToken.length > 0 && !/\s/.test(accessToken),
      'INVALID_ACCESS_TOKEN');
    requireThat(liveMode || accessToken.startsWith('TEST-'), 'TEST_CREDENTIAL_REQUIRED');
    requireThat(typeof liveMode === 'boolean' && (!liveMode || allowLive === true), 'LIVE_MODE_DISABLED');
    requireThat(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 15000, 'INVALID_TIMEOUT');
    requireThat(/^[A-Z]{3}$/.test(currency) && Number.isInteger(exponent) && exponent >= 0 && exponent <= 3,
      'INVALID_MERCHANT_CONFIG');
    this.#accessToken = accessToken;
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
    Object.defineProperty(this, 'account', { value: Object.freeze({ collectorId: providerId(collectorId),
      currency, exponent, liveMode }), enumerable: true });
  }
  async #request(path, { method = 'GET', body, key } = {}) {
    try {
      const response = await this.#fetch(`https://api.mercadopago.com${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs),
        headers: { Authorization: `Bearer ${this.#accessToken}`, 'Content-Type': 'application/json',
          ...(key ? { 'X-Idempotency-Key': key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw new PaymentError('PROVIDER_UNAVAILABLE', 503);
      return await response.json();
    } catch {
      // Never propagate provider bodies, request payloads, tokens or PII into logs/errors.
      // Every POST error is ambiguous until provider reconciliation proves otherwise.
      throw new PaymentError('PROVIDER_UNAVAILABLE', 503);
    }
  }
  async createPayment({ record, instrument, payer, description }) {
    const result = await this.#request('/v1/payments', { method: 'POST', key: record.id,
      body: {
        transaction_amount: toMajor(record.amountMinor, record.exponent),
        token: instrument.token,
        payment_method_id: instrument.paymentMethodId,
        installments: instrument.installments,
        ...(instrument.issuerId ? { issuer_id: instrument.issuerId } : {}),
        payer, description, external_reference: record.id,
      } });
    // Currency is determined by merchant account in Payments API, not a browser field.
    return { id: providerId(result.id) };
  }
  async getPayment(id) {
    return this.#request(`/v1/payments/${providerId(id)}`);
  }
  async findPaymentIds(externalReference) {
    const result = await this.#request(`/v1/payments/search?${new URLSearchParams({
      external_reference: externalReference, limit: '2', offset: '0',
    })}`);
    requireThat(Array.isArray(result.results) && Number.isSafeInteger(result.paging?.total) &&
      result.paging.total >= 0, 'INVALID_PROVIDER_SEARCH', 502);
    requireThat(result.paging.total <= 1 && result.results.length <= 1 &&
      result.results.length === result.paging.total, 'AMBIGUOUS_PROVIDER_RESULT', 409);
    return result.results.map(p => {
      requireThat(p.external_reference === externalReference, 'PROVIDER_REFERENCE_MISMATCH', 409);
      return providerId(p.id);
    });
  }
}
