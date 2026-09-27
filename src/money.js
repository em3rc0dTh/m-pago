import { requireThat } from './errors.js';

// Restrict integer amounts to keep their JSON number representation exact to cents.
export function validateMoney(amountMinor, currency, exponent) {
  requireThat(Number.isSafeInteger(amountMinor) && amountMinor > 0 && amountMinor <= 1e12,
    'INVALID_AMOUNT');
  requireThat(typeof currency === 'string' && /^[A-Z]{3}$/.test(currency), 'INVALID_CURRENCY');
  requireThat(Number.isInteger(exponent) && exponent >= 0 && exponent <= 3, 'INVALID_EXPONENT');
}
export function toMinor(value, exponent) {
  requireThat(typeof value === 'number' || typeof value === 'string', 'INVALID_PROVIDER_AMOUNT', 502);
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(String(value));
  requireThat(match, 'INVALID_PROVIDER_AMOUNT', 502);
  const fraction = match[2] ?? '';
  requireThat(!/[1-9]/.test(fraction.slice(exponent)), 'INVALID_PROVIDER_AMOUNT', 502);
  const minor = Number(match[1]) * 10 ** exponent + Number(fraction.slice(0, exponent).padEnd(exponent, '0'));
  requireThat(Number.isSafeInteger(minor) && minor <= 1e12, 'INVALID_PROVIDER_AMOUNT', 502);
  return minor;
}
export function toMajor(minor, exponent) {
  const value = minor / 10 ** exponent;
  requireThat(toMinor(value, exponent) === minor, 'INEXACT_AMOUNT');
  return value;
}
