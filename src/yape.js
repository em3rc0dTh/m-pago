import { PaymentError, requireThat } from './errors.js';

function digits(value, pattern, code) {
  const normalized = String(value ?? '').trim();
  requireThat(pattern.test(normalized), code);
  return normalized;
}

function tokenId(resource) {
  if (typeof resource === 'string') return resource;
  return resource?.id;
}

/**
 * Browser-side Yape tokenization helper.
 *
 * Phone number and OTP are sent only to Mercado Pago JS. The returned backend
 * instrument contains only the one-time token and fixed Yape payment metadata.
 */
export async function createYapeInstrument({
  publicKey,
  phoneNumber,
  otp,
  MercadoPago: MercadoPagoCtor = globalThis.MercadoPago,
}) {
  requireThat(typeof publicKey === 'string' && publicKey.length > 0 &&
    publicKey.length <= 256 && !/\s/.test(publicKey), 'INVALID_YAPE_PUBLIC_KEY');
  const phone = digits(phoneNumber, /^\d{9,15}$/, 'INVALID_YAPE_PHONE');
  const approvalCode = digits(otp, /^\d{6}$/, 'INVALID_YAPE_OTP');
  requireThat(typeof MercadoPagoCtor === 'function', 'YAPE_SDK_UNAVAILABLE', 503);

  let mp;
  try {
    mp = new MercadoPagoCtor(publicKey);
  } catch {
    throw new PaymentError('YAPE_SDK_UNAVAILABLE', 503);
  }

  requireThat(typeof mp?.yape === 'function', 'YAPE_SDK_UNAVAILABLE', 503);

  let resource;
  try {
    const yapeClient = mp.yape({ phoneNumber: phone, otp: approvalCode });
    requireThat(typeof yapeClient?.create === 'function', 'YAPE_SDK_UNAVAILABLE', 503);
    resource = await yapeClient.create();
  } catch (error) {
    if (error instanceof PaymentError) throw error;
    throw new PaymentError('YAPE_TOKENIZATION_FAILED', 502);
  }

  const token = tokenId(resource);
  requireThat(typeof token === 'string' && token.length >= 8 && token.length <= 256 &&
    !/\s/.test(token), 'INVALID_YAPE_TOKEN', 502);

  return Object.freeze({ token, paymentMethodId: 'yape', installments: 1 });
}
