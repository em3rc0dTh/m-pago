export class PaymentError extends Error {
  constructor(code, status = 409) {
    super(code);
    this.name = 'PaymentError';
    this.code = code;
    this.status = status;
  }
}
export function requireThat(condition, code, status = 400) {
  if (!condition) throw new PaymentError(code, status);
}
export function safeCode(error) {
  return error instanceof PaymentError ? error.code : 'INTERNAL_ERROR';
}
export function identifier(value, name = 'INVALID_IDENTIFIER') {
  requireThat(typeof value === 'string' && /^[a-zA-Z0-9_.:@/-]{1,160}$/.test(value), name);
  return value;
}
export function providerId(value) {
  requireThat((typeof value === 'string' && /^[1-9][0-9]{0,29}$/.test(value)) ||
    (Number.isSafeInteger(value) && value > 0), 'INVALID_PROVIDER_ID', 502);
  return String(value);
}
