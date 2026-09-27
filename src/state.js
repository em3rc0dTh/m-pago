import { requireThat, providerId } from './errors.js';
import { toMinor } from './money.js';

export function normalizeStatus(status, refundedMinor = 0) {
  if (status === 'approved') return refundedMinor > 0 ? 'partially_refunded' : 'approved';
  if (['pending', 'in_process', 'authorized'].includes(status)) return 'pending';
  if (['rejected', 'cancelled', 'refunded', 'charged_back', 'in_mediation'].includes(status)) return status;
  return 'unknown';
}
export function verifyPayment(record, payment, account) {
  const id = providerId(payment.id);
  requireThat(!record.providerId || record.providerId === id, 'PROVIDER_ID_MISMATCH', 409);
  requireThat(payment.external_reference === record.id, 'PROVIDER_REFERENCE_MISMATCH', 409);
  requireThat(toMinor(payment.transaction_amount, record.exponent) === record.amountMinor,
    'PROVIDER_AMOUNT_MISMATCH', 409);
  requireThat(payment.currency_id === record.currency, 'PROVIDER_CURRENCY_MISMATCH', 409);
  requireThat(providerId(payment.collector_id) === account.collectorId, 'PROVIDER_ACCOUNT_MISMATCH', 409);
  requireThat(payment.live_mode === account.liveMode, 'PROVIDER_MODE_MISMATCH', 409);
  requireThat(typeof payment.status === 'string' && payment.status.length <= 80, 'INVALID_PROVIDER_STATUS', 502);
  requireThat(typeof payment.date_last_updated === 'string', 'INVALID_PROVIDER_TIMESTAMP', 502);
  const updatedAt = Date.parse(payment.date_last_updated);
  requireThat(Number.isFinite(updatedAt), 'INVALID_PROVIDER_TIMESTAMP', 502);
  const refundedMinor = toMinor(payment.transaction_amount_refunded ?? 0, record.exponent);
  requireThat(refundedMinor <= record.amountMinor, 'INVALID_REFUND_AMOUNT', 502);
  return { providerId: id, providerStatus: payment.status, updatedAt, refundedMinor,
    status: normalizeStatus(payment.status, refundedMinor) };
}
export function checkTransition(record, snapshot) {
  if (snapshot.updatedAt < (record.providerUpdatedAt ?? -1)) return 'stale';
  const same = record.status === snapshot.status && record.refundedMinor === snapshot.refundedMinor &&
    record.providerStatus === snapshot.providerStatus;
  if (snapshot.updatedAt === record.providerUpdatedAt) {
    requireThat(same, 'AMBIGUOUS_PROVIDER_VERSION', 409);
    return 'duplicate';
  }
  requireThat(snapshot.refundedMinor >= record.refundedMinor, 'REFUND_REGRESSION', 409);
  if (record.everApproved) {
    requireThat(!['pending', 'rejected', 'cancelled'].includes(snapshot.status), 'STATE_REGRESSION', 409);
  }
  if (['refunded', 'charged_back'].includes(record.status)) {
    requireThat(snapshot.status === record.status || snapshot.status === 'charged_back', 'STATE_REGRESSION', 409);
  }
  if (['rejected', 'cancelled'].includes(record.status)) {
    requireThat(snapshot.status === record.status, 'STATE_REGRESSION', 409);
  }
  return same ? 'refresh' : 'change';
}
export function publicPayment(record) {
  return { id: record.id, tenantId: record.tenantId, payableId: record.payableId,
    providerId: record.providerId, status: record.status, amountMinor: record.amountMinor,
    currency: record.currency, refundedMinor: record.refundedMinor, version: record.version };
}
