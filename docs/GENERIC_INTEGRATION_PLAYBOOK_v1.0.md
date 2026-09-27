# Mercado Pago — Generic Integration Playbook v1.0

Status: **Reusable engineering contract**
Origin: knowledge extracted from MitoS / BookCars and refreshed against current Mercado Pago documentation.

---

## 1. Objective

Integrate Mercado Pago so that payment state remains correct under:

- browser retries;
- API retries;
- duplicate clicks;
- concurrent requests;
- provider delays;
- repeated webhooks;
- missed webhooks;
- process restarts;
- multiple backend instances;
- partial network failure.

The integration is complete only when the application can recover provider truth without trusting the browser.

---

## 2. Trust boundaries

### 2.1 Browser

The browser may own:

- payment method selection;
- provider Public Key;
- provider-secure tokenization;
- tokenized payment instrument data;
- payer fields required by the provider;
- an application checkout/session identifier;
- an idempotency key generated for one logical payment attempt.

The browser must **not** be authoritative for:

- final amount;
- currency;
- product/reservation identity;
- discount validity;
- final payment status;
- business state transition.

### 2.2 Application backend

The backend owns:

- business object identity;
- authoritative amount;
- authoritative currency;
- pricing rules;
- external reference;
- idempotency semantics;
- distributed active-payment claim;
- local payment ledger;
- domain state transitions;
- reconciliation authorization.

### 2.3 Mercado Pago

Mercado Pago owns provider transaction truth:

- payment id;
- provider status;
- status detail;
- settled amount;
- currency;
- payment method;
- provider timestamps and transaction metadata.

---

## 3. Minimal architecture

```text
[Browser / App]
      |
      | tokenized payment data + checkout identity
      v
[Application API]
      |
      | authoritative quote
      | local payment claim
      | X-Idempotency-Key
      v
[Mercado Pago API]
      |
      | provider payment id + provider state
      v
[Local Payment Ledger]
      |
      +----> [Domain State]

[Mercado Pago Webhook]
      |
      | verified signature
      v
[Provider Read-back]
      |
      v
[Local Payment Ledger] -> [Domain State]

[Backoffice / Recovery Job]
      |
      v
[Reconciliation] -> [Provider Read-back] -> [Local Payment Ledger]
```

---

## 4. Recommended local payment state model

Keep provider state and application business state separate.

A minimal normalized payment state can be:

```text
pending
approved
rejected
refunded
failed
```

Example mapping:

```text
Mercado Pago approved                         -> approved
Mercado Pago pending/in_process/authorized   -> pending
Mercado Pago rejected/cancelled              -> rejected
Mercado Pago refunded/charged_back           -> refunded
unknown/unmapped                              -> failed or explicit unknown
```

Rule:

> Unknown provider states must never be silently promoted to approved.

Do not encode the whole business workflow into the payment record. A reservation, order, subscription or invoice should have its own state machine.

---

## 5. Authoritative quote

Before creating a provider payment, resolve the payable amount on the server from persisted business data.

Generic flow:

```text
businessObjectId + checkoutSessionId
        |
        v
load business object
        |
validate caller/session ownership
        |
recalculate price
        |
apply server-side policy
        |
return authoritative quote
```

The browser may display the amount, but the backend must recalculate it again at payment creation.

Never accept this as payment authority:

```json
{
  "amount": 90,
  "currency": "PEN"
}
```

when those values came only from the client.

---

## 6. Payment creation contract

A generic backend command can look like:

```ts
type CreatePaymentCommand = {
  businessObjectId: string
  checkoutSessionId: string
  token: string
  paymentMethodId: string
  installments?: number
  issuerId?: string
  payer: {
    email: string
    identification?: {
      type: string
      number: string
    }
  }
}
```

Transport header:

```text
X-Idempotency-Key: <unique logical payment attempt key>
```

The backend then derives:

```text
transaction_amount
currency_id
external_reference
description
business metadata
```

from authoritative state.

Mercado Pago currently requires `X-Idempotency-Key` for payment creation. The application should treat idempotency as part of its own contract too, not merely a provider header.

---

## 7. Idempotency: two distinct problems

### 7.1 Same logical request replay

Example:

```text
request A: business=123 key=K1
network timeout
request A retry: business=123 key=K1
```

Expected:

- reuse the same local PaymentTransaction;
- reuse the same provider idempotency key;
- never create a second logical payment;
- if a provider id already exists, re-read provider truth.

### 7.2 Different keys racing for the same business object

Example:

```text
request A: business=123 key=K1
request B: business=123 key=K2
arrive concurrently
```

A simple read-before-write guard is unsafe:

```text
A reads: no active payment
B reads: no active payment
A calls provider
B calls provider
=> duplicate active payments
```

This must be solved by a database-level atomic claim.

---

## 8. Distributed active-payment claim

Use a deterministic key representing the right to have an active provider payment.

Example:

```text
activeKey = mercado_pago:<businessObjectId>
```

Persist it on active payment states and enforce a unique sparse/partial constraint.

Generic record:

```ts
type PaymentTransaction = {
  provider: "mercado_pago"
  businessObjectId: string
  providerPaymentId?: string
  externalReference: string
  idempotencyKey: string
  activeKey?: string

  status: "pending" | "approved" | "rejected" | "refunded" | "failed"

  amount: number
  currency: string
  paymentMethodId?: string

  lastProviderSyncAt?: Date
  approvedAt?: Date
  processedApprovalAt?: Date
}
```

Recommended uniqueness:

```text
UNIQUE(provider, providerPaymentId) WHERE providerPaymentId exists
UNIQUE(idempotencyKey)
UNIQUE(activeKey) WHERE activeKey exists
```

Lifecycle:

```text
pending/approved -> activeKey retained
rejected/refunded/failed -> activeKey released
```

This allows a legitimate retry after a terminal failure while preventing two simultaneous active payments.

Do not rely on an in-memory mutex if multiple processes or instances can serve requests.

---

## 9. Provider adapter boundary

Keep the domain independent from the Mercado Pago SDK.

Recommended interface:

```ts
interface PaymentProviderAdapter {
  createPayment(command: ProviderCreatePaymentCommand): Promise<ProviderPayment>
  getPayment(providerPaymentId: string): Promise<ProviderPayment>
  verifyWebhook(input: ProviderWebhookVerificationInput): Promise<boolean>
}
```

Application layer:

```text
PaymentApplicationService
  -> PricingService
  -> PaymentLedgerRepository
  -> PaymentProviderAdapter
  -> DomainStateService
```

Mercado Pago-specific details remain inside the adapter:

- SDK initialization;
- `/v1/payments`;
- provider field names;
- webhook signature format;
- payment status mapping.

This makes a later Stripe/PayPal/other-provider adapter possible without rewriting the domain state machine.

---

## 10. Create-payment sequence

Recommended sequence:

```text
1. validate required request fields
2. require X-Idempotency-Key
3. resolve authoritative business object
4. validate checkout/session ownership
5. validate payer relationship when applicable
6. recalculate authoritative amount + currency
7. reuse same-key transaction if it already exists
8. atomically claim active payment right in DB
9. build provider request from server-owned values
10. call Mercado Pago with same idempotency key
11. persist provider payment id + normalized state
12. if provider reports approved, read provider resource again
13. apply domain transition idempotently
14. return normalized result
```

Important:

The local active claim should exist **before** provider I/O.

---

## 11. Never trust create-response approval blindly

Even if the payment-create response says `approved`, use provider read-back before applying irreversible business state.

```text
create payment
   |
provider says approved
   |
GET provider payment resource
   |
verify:
  external_reference
  amount
  currency
  provider id
   |
apply local approved state
```

This is stricter than trusting a frontend callback and gives one authoritative synchronization path reusable by:

- payment create;
- webhook;
- manual reconciliation;
- recovery jobs.

---

## 12. Webhooks

Mercado Pago currently sends verification material including:

- `x-signature`;
- `x-request-id`;
- the notification `data.id`.

The provider documentation describes validating the notification with the application webhook secret, or using the official SDK validator where supported.

Webhook processing rule:

```text
receive notification
  |
verify authenticity
  |
extract provider payment id
  |
read payment directly from provider API
  |
verify amount/currency/external reference
  |
upsert normalized local payment
  |
apply idempotent domain transition
  |
200
```

Do not treat the webhook body alone as final transaction truth when a provider resource can be read back.

Repeated webhooks must be safe.

---

## 13. Webhook signature implementation rule

Prefer the current official SDK validator if available in the selected SDK version.

If implementing verification manually:

- follow the current provider manifest format exactly;
- use HMAC with the configured webhook secret;
- use constant-time comparison;
- normalize fields exactly as documented;
- test valid, tampered and incomplete signatures;
- keep the provider docs URL next to the implementation because signature formats can evolve.

Never log:

- webhook secret;
- Access Token;
- raw card token;
- PAN;
- CVV;
- one-time codes.

---

## 14. Provider read-back verification

Before mutating business state, verify at minimum:

```text
providerPayment.id              expected
external_reference              expected business object
transaction_amount              equals authoritative amount
currency_id                     equals authoritative currency
provider status                 mapped explicitly
```

For floating point currencies, compare using a money-safe representation or integer minor units where practical.

A mismatch must fail closed.

---

## 15. Reconciliation

Webhook delivery is not guaranteed to be the only synchronization mechanism.

Provide a protected reconciliation path:

```text
POST /backoffice/payments/:providerPaymentId/reconcile
```

or an equivalent privileged job.

Reconciliation must:

- be backoffice/service-authorized;
- read the provider payment;
- apply the same sync function used by webhook processing;
- never accept browser-declared status.

The best design has one core function:

```ts
syncProviderPayment(providerPaymentId)
```

called by:

- create-payment follow-up;
- webhook;
- reconciliation;
- scheduled recovery.

---

## 16. Domain transition idempotency

Provider events can be repeated.

Therefore:

```text
approved -> approved
confirmed -> confirmed
email event -> already delivered
ledger mutation -> already applied
```

must be safe.

Irreversible or customer-visible side effects need their own idempotency boundary.

Examples:

- reservation confirmation;
- invoice creation;
- inventory allocation;
- email delivery;
- receipt generation;
- loyalty credit.

Do not assume payment-event idempotency automatically makes downstream side effects idempotent.

---

## 17. Frontend integration

Current Mercado Pago web integrations can use official browser libraries such as:

```bash
npm install @mercadopago/sdk-react
```

or the provider browser SDK.

The frontend should expose only provider-tokenized data to the application backend.

Safe conceptual boundary:

```text
PAN / expiration / CVV
        |
provider-secure/tokenizing surface
        |
one-time token
        |
application backend
```

The application backend should never receive raw PAN/CVV if the selected integration is designed for provider-side tokenization.

---

## 18. Secrets and configuration

Typical configuration classes:

### Public browser configuration

```text
MERCADO_PAGO_PUBLIC_KEY
```

This is expected to reach the frontend.

### Private backend configuration

```text
MERCADO_PAGO_ACCESS_TOKEN
MERCADO_PAGO_WEBHOOK_SECRET
```

These must remain server-side.

### Application policy configuration

Examples:

```text
PAYMENT_CURRENCY
FX_RATE
DEPOSIT_PERCENTAGE
MINIMUM_DEPOSIT
```

These are application policy, not Mercado Pago secrets.

Rules:

- never commit real secrets;
- never embed Access Token in frontend bundles;
- use separate TEST and production credentials;
- do not store generated one-time card tokens as evidence;
- redact credentials from CI logs and artifacts.

---

## 19. Testing ladder

A useful certification ladder is:

### Gate A — pure unit tests

Prove:

- status mapping;
- webhook verification;
- state-machine transitions;
- amount normalization.

### Gate B — application boundary with provider stub

Use real:

- HTTP routes;
- middleware;
- persistence;
- concurrency;
- domain transitions.

Stub only the external provider method boundary.

Prove:

- wrong session rejected;
- wrong payer rejected;
- missing idempotency rejected;
- same-key replay safe;
- different-key concurrency safe;
- tampered webhook rejected;
- amount/currency mismatch fail closed;
- reconciliation authorization.

### Gate C — real Mercado Pago TEST provider

Prove:

- real TEST tokenization;
- real payment creation;
- `live_mode=false`;
- external reference match;
- amount/currency match;
- direct provider read-back;
- same-key replay;
- sanitized evidence.

### Gate D — browser E2E

Prove:

- actual browser integration;
- payment UI/tokenization;
- application checkout;
- final normalized result.

### Gate E — real inbound webhook

Prove:

- public HTTPS notification endpoint;
- actual provider webhook delivery;
- valid signature;
- provider read-back;
- repeated delivery safety.

### Gate F — production readiness

Separate gate.

Include:

- production secrets;
- HTTPS;
- observability;
- retry/recovery;
- rate limits;
- operational runbook;
- production webhook configuration;
- incident handling;
- reconciliation tooling.

A sandbox success does not automatically certify Gate E or Gate F.

---

## 20. Evidence discipline

Every certification claim should identify:

```text
repository
branch
commit
workflow/test command
provider mode
payment id when safe
artifact or receipt
explicit nonclaims
```

Sanitized evidence may contain:

- provider payment id;
- amount;
- currency;
- normalized state;
- `live_mode`;
- external reference;
- timestamps;
- assertions.

Evidence must not contain:

- Access Token;
- webhook secret;
- PAN;
- CVV;
- raw tokenized card token;
- passwords;
- session cookies;
- JWTs.

---

## 21. Failure taxonomy

Classify failures before changing product code:

```text
PRODUCT DEFECT
PROVIDER DEFECT
HARNESS DEFECT
ENVIRONMENT DEFECT
AUTHORIZATION DEFECT
CONCURRENCY DEFECT
CONFIGURATION DEFECT
PROVIDER UI / TELEMETRY DISCREPANCY
```

This prevents a test-environment failure from being mislabeled as a payment defect.

---

## 22. Required invariants

A Mercado Pago integration is not considered robust unless these remain true:

1. The server owns amount and currency.
2. The browser never decides final payment state.
3. The provider payment is linked to a stable business reference.
4. Every logical payment attempt carries an idempotency key.
5. Same-key retries do not duplicate payments.
6. Different-key concurrent requests cannot open two active payments for the same business object.
7. Webhook authenticity is verified before processing.
8. Provider state is read back before irreversible domain transitions.
9. Provider amount/currency/reference are checked against local authority.
10. Repeated provider events are safe.
11. A missed webhook can be recovered through reconciliation.
12. Production secrets never cross into the browser or source repository.
13. Certification claims distinguish provider TEST, browser E2E, webhook delivery and production readiness.

---

## 23. Compact implementation pseudocode

```ts
async function createPayment(input, idempotencyKey) {
  require(idempotencyKey)

  const business = await loadBusinessObject(input.businessObjectId)
  assertSession(business, input.checkoutSessionId)

  const quote = await pricing.authoritativeQuote(business)
  assertPayer(input.payer, business)

  const replay = await ledger.findByIdempotencyKey(idempotencyKey)

  if (replay?.providerPaymentId) {
    return syncProviderPayment(replay.providerPaymentId)
  }

  await ledger.atomicClaimActivePayment({
    provider: "mercado_pago",
    businessObjectId: business.id,
    idempotencyKey,
    amount: quote.amount,
    currency: quote.currency
  })

  const created = await provider.createPayment({
    tokenizedPaymentData: input,
    amount: quote.amount,
    currency: quote.currency,
    externalReference: business.id,
    idempotencyKey
  })

  await ledger.attachProviderResult(created)

  if (created.status === "approved") {
    return syncProviderPayment(created.id)
  }

  return normalize(created)
}

async function syncProviderPayment(providerPaymentId) {
  const providerPayment = await provider.getPayment(providerPaymentId)
  const business = await loadBusinessObject(providerPayment.externalReference)
  const quote = await pricing.authoritativeQuote(business)

  assert(providerPayment.amount === quote.amount)
  assert(providerPayment.currency === quote.currency)
  assert(providerPayment.externalReference === business.id)

  const transaction = await ledger.upsert(normalize(providerPayment))

  if (transaction.status === "approved") {
    await domain.applyApprovedPaymentIdempotently(business.id, transaction)
  }

  return transaction
}
```

---

## 24. Source-of-truth priority

When evidence conflicts, prefer:

```text
direct provider resource read-back
  >
verified provider webhook + provider read-back
  >
application persisted transaction
  >
application logs
  >
browser UI
  >
monitoring dashboard visualization
```

Provider monitoring UI can be operationally useful, but it is not a substitute for direct resource truth when validating one specific transaction.

---

## 25. Versioning rule

Mercado Pago SDKs and webhook documentation evolve.

Therefore:

- pin application dependencies deliberately;
- keep provider-specific code behind an adapter;
- re-check official provider docs before major SDK upgrades;
- re-run webhook, idempotency and TEST-provider gates after an upgrade;
- do not treat this document as a substitute for the current Mercado Pago API reference.

