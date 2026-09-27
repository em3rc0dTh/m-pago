# ASTRA WORK — Mercado Pago Reuse Handoff v1.0

Mode: **WORK**
Goal: apply the proven Mercado Pago integration knowledge rapidly to a new product without dragging MitoS-specific assumptions into the implementation.

---

## 0. Invocation contract

ASTRA WORK receives:

```yaml
product:
repository: em3rc0dTh/m-pago
base_branch:
working_branch:
runtime:
  frontend:
  backend:
  database:
domain:
  payable_entity:
  domain_states:
payment:
  country:
  currency:
  methods:
  use_bricks:
  webhook_public_url_available:
credentials:
  test_public_key_available:
  test_access_token_available:
  webhook_secret_available:
constraints:
  deploy_allowed:
  production_credentials_allowed:
  real_money_allowed:
```

Unknown product facts must remain unknown.

Do not invent:

- business pricing rules;
- tax policy;
- deposit rules;
- refund policy;
- customer identity rules;
- production credentials.

---

## 1. Required reading

Before implementation, read:

1. `README.md`
2. `GENERIC_INTEGRATION_PLAYBOOK_v1.0.md`
3. `MITOS_LESSONS_AND_EVIDENCE_v1.0.md`

Then inspect the target product's:

- payment/domain models;
- pricing code;
- checkout routes;
- auth/session boundary;
- persistence constraints;
- existing payment providers;
- secret/config system;
- CI/testing structure.

---

## 2. Fast execution sequence

### WORK-01 — map authority

Produce a compact map:

```text
client-owned
server-owned
provider-owned
```

Identify the single server function that will own authoritative amount/currency.

Gate:

`NO PAYMENT CODE UNTIL FINANCIAL AUTHORITY IS IDENTIFIED`

### WORK-02 — introduce provider-independent payment ledger

Minimum fields:

```text
provider
payableEntityId
providerPaymentId
externalReference
idempotencyKey
activeKey
status
amount
currency
paymentMethodId
lastProviderSyncAt
approvedAt
processedApprovalAt
```

Required uniqueness:

```text
idempotencyKey
(provider, providerPaymentId) when present
activeKey when present
```

### WORK-03 — implement atomic active-payment claim

Deterministic key:

```text
mercado_pago:<payableEntityId>
```

Claim before provider I/O.

Prove with concurrency test:

```text
two concurrent different keys
=> one provider create
=> one accepted active transaction
=> loser receives conflict/no duplicate provider call
```

### WORK-04 — provider adapter

Implement Mercado Pago behind:

```ts
createPayment()
getPayment()
verifyWebhook()
```

Do not leak SDK response types throughout domain code.

### WORK-05 — payment command

Require:

- payable entity id;
- checkout/session proof;
- tokenized provider data;
- payer identity required by product/provider;
- `X-Idempotency-Key`.

Derive server-side:

- amount;
- currency;
- external reference;
- description/metadata.

### WORK-06 — same-key replay

Before creating another provider payment:

```text
same key + provider id exists
=> provider read-back
=> return normalized existing result
```

### WORK-07 — sync function

Create one canonical:

```text
syncMercadoPagoPayment(providerPaymentId)
```

It must:

1. GET provider payment.
2. resolve local payable entity from trusted reference.
3. recalculate authoritative amount/currency.
4. verify amount.
5. verify currency.
6. verify external reference.
7. normalize provider status.
8. upsert local ledger.
9. apply approved domain transition idempotently.
10. return normalized transaction.

### WORK-08 — webhook

Webhook path:

```text
verify signature
-> extract data.id
-> syncMercadoPagoPayment(data.id)
-> acknowledge
```

Never authorize a payment from the notification body alone.

### WORK-09 — reconciliation

Add privileged operational reconciliation using the same sync function.

Customer auth must not be enough to call it.

### WORK-10 — frontend

Use Mercado Pago's supported tokenization/Brick/Core-Methods surface appropriate to the product.

Frontend submits tokenized payment data.

Do not send raw PAN/CVV through normal application inputs.

Do not let the client own amount/currency.

---

## 3. Mandatory tests

ASTRA WORK must add or preserve tests for:

```text
status mapping
unknown provider state fails closed
valid webhook signature
tampered webhook signature
missing webhook metadata
wrong checkout/session
payer mismatch when applicable
missing X-Idempotency-Key
client amount/currency ignored
same-key replay
different-key sequential duplicate
different-key concurrent race
terminal retry after rejection
provider amount mismatch
provider currency mismatch
provider external-reference mismatch
approved replay
reconciliation authorization
```

---

## 4. Certification stages

### C0 — static/build

```text
compile
lint/typecheck
unit tests
secret literal scan
```

### C1 — application boundary

Real:

- routes;
- middleware;
- database;
- domain services.

Stub only provider external calls.

### C2 — real TEST provider

Use Mercado Pago TEST credentials only.

Evidence must prove:

```text
live_mode=false
provider payment exists
external reference matches
amount matches
currency matches
provider read-back succeeds
same-key replay safe
```

### C3 — browser

Prove the actual browser payment surface reaches the application and provider boundary.

### C4 — real inbound webhook

Requires a public HTTPS webhook URL and real provider delivery proof.

### C5 — production-readiness review

Do not infer C5 from C2/C3/C4.

---

## 5. Stop conditions

Stop and report rather than fabricate completion when:

```text
authoritative pricing cannot be identified
payment ownership/session boundary is undefined
database cannot enforce cross-instance uniqueness
TEST credentials are unavailable for provider gate
webhook URL is not publicly reachable for real webhook gate
product asks browser to decide approved state
provider amount/reference cannot be reconciled to local state
```

A blocked gate is valid engineering output.

---

## 6. Secret policy

Never commit:

```text
Access Token
webhook secret
raw card token
PAN
CVV
OTP
password
JWT
session cookie
```

TEST Public Key may be browser-visible by provider design, but avoid hard-coding environment-specific values into reusable documentation or source unless the project's configuration policy explicitly allows it.

---

## 7. Evidence receipt template

Each gate should emit:

```md
# Payment Gate Receipt

Repository:
Branch:
Commit:
Date:
Gate:

## What was executed

## Evidence

## Assertions

## Result

## Defects found

## Corrections applied

## Explicit nonclaims

## Secrets/data handling
```

Do not use "certified" for behavior the execution never reached.

---

## 8. Default implementation posture

Unless the target product already dictates otherwise:

```text
frontend               thin payment client
backend                financial authority
database               idempotency + concurrency authority
provider adapter       Mercado Pago-specific translation
provider read-back     final transaction synchronization
webhook                authenticated trigger
reconciliation         recovery mechanism
domain service         idempotent business transition
```

---

## 9. Definition of WORK complete

ASTRA WORK may declare the reusable implementation slice complete only when:

- payment architecture is mapped;
- provider-specific code is isolated;
- backend owns amount/currency;
- idempotency is implemented locally and sent to Mercado Pago;
- concurrent duplicate creation is prevented by shared persistence;
- payment truth can be re-read directly from Mercado Pago;
- webhook verification path exists;
- reconciliation path exists;
- normalized state mapping fails closed;
- tests cover replay and concurrency;
- evidence states exactly which certification gates were actually executed.

No deploy, merge, production credential use or real-money transaction is implied unless separately authorized.
