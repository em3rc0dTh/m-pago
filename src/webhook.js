import { createHmac, timingSafeEqual } from 'node:crypto';
import { PaymentError, requireThat } from './errors.js';

// Contract and official SDK source links: docs/PROVIDER_SOURCES.md.
// Signature authenticates URL data.id, request-id and ts; NOT the JSON body.
export function verifyWebhook({ url, headers, secret, now = Date.now(), toleranceMs = 300_000 }) {
  try {
    requireThat(typeof secret === 'string' && secret.length >= 16, 'INVALID_WEBHOOK_CONFIG');
    requireThat(Number.isFinite(now) && Number.isFinite(toleranceMs) && toleranceMs > 0,
      'INVALID_WEBHOOK_CONFIG');
    const query = new URL(url).searchParams;
    const ids = query.getAll('data.id');
    requireThat(ids.length === 1 && /^[a-zA-Z0-9]{1,128}$/.test(ids[0]), 'INVALID_SIGNATURE');
    const h = new Headers(headers);
    const requestId = h.get('x-request-id');
    requireThat(requestId && /^[a-zA-Z0-9_-]{1,200}$/.test(requestId), 'INVALID_SIGNATURE');
    const signature = h.get('x-signature');
    requireThat(signature && signature.length < 512, 'INVALID_SIGNATURE');
    const entries = signature.split(',').map(part => part.trim().split('='));
    requireThat(entries.length === 2 && entries.every(e => e.length === 2), 'INVALID_SIGNATURE');
    const parts = Object.fromEntries(entries);
    requireThat(Object.keys(parts).length === 2 && /^\d{10}$|^\d{13}$/.test(parts.ts) &&
      /^[a-fA-F0-9]{64}$/.test(parts.v1), 'INVALID_SIGNATURE');
    // Docs contain both seconds and milliseconds examples. Sign with original ts.
    const timestamp = Number(parts.ts) * (parts.ts.length === 10 ? 1000 : 1);
    requireThat(Math.abs(now - timestamp) <= toleranceMs, 'INVALID_SIGNATURE');
    const dataId = ids[0].toLowerCase();
    const manifest = `id:${dataId};request-id:${requestId};ts:${parts.ts};`;
    const expected = createHmac('sha256', secret).update(manifest).digest();
    requireThat(timingSafeEqual(expected, Buffer.from(parts.v1, 'hex')), 'INVALID_SIGNATURE');
    return { dataId, requestId, timestamp };
  } catch {
    throw new PaymentError('INVALID_SIGNATURE', 401);
  }
}
