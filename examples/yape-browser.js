import { createYapeInstrument } from '@em3rc0d/m-pago/yape';

/**
 * Browser example. MercadoPago.js must already be loaded or supplied by the app.
 * Phone/OTP stay in the browser-to-Mercado-Pago tokenization boundary.
 */
export async function payWithYape({
  publicKey,
  payableId,
  phoneNumber,
  otp,
  idempotencyKey,
  endpoint = '/api/payments',
  MercadoPago = globalThis.MercadoPago,
  fetch: fetchImpl = globalThis.fetch,
}) {
  const instrument = await createYapeInstrument({
    publicKey, phoneNumber, otp, MercadoPago,
  });

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ payableId, instrument }),
  });

  if (!response.ok) throw new Error('PAYMENT_REQUEST_FAILED');
  return response.json();
}
