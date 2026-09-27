import test from 'node:test';
import assert from 'node:assert/strict';
import { createYapeInstrument } from '../src/yape.js';

const code = expected => error => error.code === expected;

class FakeMercadoPago {
  static calls = [];
  constructor(publicKey) {
    FakeMercadoPago.calls.push({ publicKey });
  }
  yape(input) {
    FakeMercadoPago.calls.at(-1).input = input;
    return { create: async () => ({ id: 'fixture-yape-token-abcdefgh' }) };
  }
}

test('browser helper sends phone and OTP only to Mercado Pago and returns backend-safe instrument', async () => {
  FakeMercadoPago.calls.length = 0;
  const instrument = await createYapeInstrument({
    publicKey: 'APP_USR-fixture-public-key',
    phoneNumber: '111111111',
    otp: '123456',
    MercadoPago: FakeMercadoPago,
  });
  assert.deepEqual(FakeMercadoPago.calls[0], {
    publicKey: 'APP_USR-fixture-public-key',
    input: { phoneNumber: '111111111', otp: '123456' },
  });
  assert.deepEqual(instrument, {
    token: 'fixture-yape-token-abcdefgh',
    paymentMethodId: 'yape',
    installments: 1,
  });
  assert.equal(JSON.stringify(instrument).includes('111111111'), false);
  assert.equal(JSON.stringify(instrument).includes('123456'), false);
});

test('browser helper accepts a direct token string from compatible SDK wrappers', async () => {
  class Wrapper {
    yape() { return { create: async () => 'fixture-yape-token-string' }; }
  }
  assert.equal((await createYapeInstrument({
    publicKey: 'public-key', phoneNumber: '111111111', otp: '123456', MercadoPago: Wrapper,
  })).token, 'fixture-yape-token-string');
});

for (const [name, patch, expected] of [
  ['public key', { publicKey: 'bad key' }, 'INVALID_YAPE_PUBLIC_KEY'],
  ['phone', { phoneNumber: 'abc' }, 'INVALID_YAPE_PHONE'],
  ['OTP', { otp: '12345' }, 'INVALID_YAPE_OTP'],
]) test(`browser helper rejects invalid ${name} before SDK invocation`, async () => {
  FakeMercadoPago.calls.length = 0;
  await assert.rejects(createYapeInstrument({
    publicKey: 'public-key', phoneNumber: '111111111', otp: '123456',
    MercadoPago: FakeMercadoPago, ...patch,
  }), code(expected));
  assert.equal(FakeMercadoPago.calls.length, 0);
});

test('browser helper sanitizes Mercado Pago tokenization failures', async () => {
  class Broken {
    yape() { return { create: async () => { throw Error('private otp/provider data'); } }; }
  }
  await assert.rejects(createYapeInstrument({
    publicKey: 'public-key', phoneNumber: '111111111', otp: '123456', MercadoPago: Broken,
  }), error => error.code === 'YAPE_TOKENIZATION_FAILED' && !error.message.includes('private'));
});

test('browser helper rejects unavailable SDK and malformed token responses', async () => {
  await assert.rejects(createYapeInstrument({
    publicKey: 'public-key', phoneNumber: '111111111', otp: '123456', MercadoPago: undefined,
  }), code('YAPE_SDK_UNAVAILABLE'));
  class Invalid {
    yape() { return { create: async () => ({ id: '' }) }; }
  }
  await assert.rejects(createYapeInstrument({
    publicKey: 'public-key', phoneNumber: '111111111', otp: '123456', MercadoPago: Invalid,
  }), code('INVALID_YAPE_TOKEN'));
});

test('browser helper sanitizes constructor failures', async () => {
  class BrokenConstructor {
    constructor() { throw Error('private sdk config'); }
  }
  await assert.rejects(createYapeInstrument({
    publicKey: 'public-key', phoneNumber: '111111111', otp: '123456', MercadoPago: BrokenConstructor,
  }), code('YAPE_SDK_UNAVAILABLE'));
});

test('browser helper rejects incomplete Yape SDK surfaces', async () => {
  class Incomplete {
    yape() { return {}; }
  }
  await assert.rejects(createYapeInstrument({
    publicKey: 'public-key', phoneNumber: '111111111', otp: '123456', MercadoPago: Incomplete,
  }), code('YAPE_SDK_UNAVAILABLE'));
});
