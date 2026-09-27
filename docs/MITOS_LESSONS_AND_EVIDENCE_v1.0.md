# MitoS → Mercado Pago — Lessons and Evidence v1.0

Status: **Provenance record**
Purpose: explain why the generic integration rules exist and which MitoS executions support them.

---

## 1. Repository and execution lineage

Repository:

`thradexIT/bookcars`

Relevant branches:

```text
feature/mitos-rental-completion
cert/mitos-r2-mercado-pago-runtime
cert/mitos-r2b-mercado-pago-sandbox
cert/mitos-r3-browser-e2e
cert/mitos-r3-payment-brick-browser-v2
feature/mitos-custom-secure-checkout
feature/mitos-flexible-reservation-payment
```

Important historical evidence lives under:

`docs/mitos/evidence/`

A broader execution journal was also created on the payment work lineage at:

`docs/mitos/knowledge/MITOS_EXECUTION_KNOWLEDGE_BASE_v1.0.md`

This document does not replace that history. It extracts the payment-specific reusable lessons.

---

## 2. Lesson: browser success cannot be payment authority

The MitoS payment boundary was designed so that:

```text
Browser
  = intent + provider tokenized data

MitoS backend
  = authoritative booking + amount + currency + state transitions

Mercado Pago
  = provider transaction truth
```

When payment creation reported `approved`, MitoS did not immediately trust the browser or only the create response.

It re-read the provider payment resource and verified:

- `external_reference`;
- amount;
- currency;
- provider payment id;
- provider status.

Reusable rule:

> Domain confirmation must be driven from verified provider truth, not from redirect/query params or client-rendered success.

---

## 3. Lesson: client price is display data, not authority

MitoS exposed a backend quote derived from persisted booking data.

At payment creation, the backend recalculated the charge again.

The frontend service intentionally omitted client-side `amount` and `currency` from the payment command.

Observed R2A behavior included:

- wrong quote session rejected;
- wrong payment session rejected;
- browser-supplied amount/currency unable to override backend authority;
- payer mismatch rejected.

Reusable rule:

> The client may display a quote but the server must independently own the financial amount and currency sent to the provider.

---

## 4. Lesson: provider idempotency is necessary but not sufficient

MitoS required `X-Idempotency-Key`.

Same-key replay semantics were validated:

```text
same booking
same idempotency key
=> same logical/provider payment
=> no second provider create
```

However, a different failure remained possible:

```text
same booking
different keys
concurrent requests
```

This exposed the difference between:

1. provider-level same-request replay protection;
2. application-level "only one active payment per business object" protection.

Reusable rule:

> Design both idempotency layers explicitly.

---

## 5. Lesson: read-before-write duplicate checks fail under concurrency

A sequential guard originally checked whether an active payment already existed.

Under concurrent requests, both requests could observe no active payment before either had persisted its own state.

Historical failing evidence:

```text
providerCreateCalls = 2
responses           = 201 / 201
activeTransactions  = 2
reservationStatus   = awaiting_payment
```

Classification:

`PRODUCT CONCURRENCY DEFECT`

The correction used a deterministic key:

```text
activeKey = mercado_pago:<bookingId>
```

and a unique sparse MongoDB index.

The active PaymentTransaction claim was persisted atomically **before provider I/O**.

Certified corrected result:

```text
providerCreateCalls = 1
responses           = 201 / 409
activeTransactions  = 1
reservationStatus   = awaiting_payment
```

Reusable rule:

> Serialize financial mutation at the shared datastore boundary, not in process memory.

---

## 6. Lesson: an in-memory mutex was deliberately rejected

The payment flow may run on more than one process or instance.

An in-memory mutex only coordinates callers that happen to land on one runtime.

MitoS therefore used the database unique constraint as the cross-instance serialization point.

Reusable rule:

> Any lock protecting provider payment creation must survive horizontal scaling and process restarts.

---

## 7. Lesson: terminal failures must release the active-payment claim

Preventing duplicate active payments must not permanently block legitimate retries.

MitoS retained `activeKey` while payment state was active:

```text
pending
approved
```

and released it on terminal non-active states such as:

```text
rejected
refunded
failed
```

A terminal retry was explicitly proven:

```text
first payment       rejected
activeKey           released
new key             accepted
second payment      pending
activeTransactions  1
```

Reusable rule:

> Duplicate-payment prevention needs a lifecycle, not a permanent lock.

---

## 8. Lesson: webhook authenticity must be checked before processing

The MitoS webhook path required:

- webhook secret;
- `x-signature`;
- `x-request-id`;
- notification `data.id`.

Tampered signatures were rejected before provider synchronization.

The signature implementation used HMAC SHA-256 and constant-time comparison.

Reusable rule:

> A webhook is an untrusted internet request until its provider authenticity has been validated.

Current Mercado Pago documentation should always be re-checked before copying a manual signature implementation.

---

## 9. Lesson: webhook payload and provider resource have different roles

The webhook tells the application that something changed.

The provider API tells the application what the current transaction truth is.

MitoS used the notification's payment id to perform provider read-back.

Reusable flow:

```text
verified notification
  -> provider payment id
  -> GET provider resource
  -> verify business reference/amount/currency
  -> persist normalized state
  -> apply idempotent domain transition
```

Reusable rule:

> Treat the webhook primarily as a synchronization trigger when provider read-back is available.

---

## 10. Lesson: webhooks need a recovery path

The real Mercado Pago TEST-provider certification proved a provider payment and direct provider read-back, but it explicitly did **not** prove real inbound webhook delivery.

The provider resource observed during that certification had:

`notification_url: null`

Therefore MitoS kept explicit reconciliation.

Reusable rule:

> A payment system should remain recoverable even when no webhook arrives.

---

## 11. Lesson: reconciliation is privileged financial mutation

An early MitoS implementation allowed a normal customer token to call reconciliation.

That was classified as:

`PRODUCT AUTHORIZATION DEFECT`

The correction restricted reconciliation to backoffice authority.

Reusable rule:

> Reconciliation is not a normal customer endpoint. It can mutate financial/domain truth and requires explicit operational authorization.

---

## 12. Lesson: side effects need their own idempotency

MitoS payment approval could trigger:

- booking paid state;
- reservation confirmation;
- customer transactional email events.

Webhook replays and reconciliation could encounter the same approved payment again.

Therefore approval application and email delivery were designed to be idempotent.

Reusable rule:

> Payment idempotency does not automatically make emails, inventory, invoice generation or other downstream effects idempotent.

---

## 13. Real Mercado Pago TEST-provider proof

Branch:

`cert/mitos-r2b-mercado-pago-sandbox`

Historical certified execution commit:

`eb5eb297e30062d8b917c7af6745591577543ad9`

Workflow:

`mitos-r2b-sandbox`

Run:

`33454472309`

Evidence artifact:

`mitos-r2b-provider-evidence-33454472309`

Observed sanitized proof included:

```text
quote                  90 PEN
reservation            awaiting_payment
CardToken generated    true
CardToken persisted    false
provider live_mode     false
provider status        approved
payment                approved
reservation            confirmed
booking                paid
same-key replay        same provider payment
second active key      HTTP 409
Admin reconciliation   HTTP 200
```

Provider Payment ID used in the historical test:

`1328015420`

The real provider resource was independently read back and observed as:

```text
status              approved
status_detail       accredited
live_mode           false
currency_id         PEN
transaction_amount  90
captured            true
```

The `external_reference` matched the MitoS booking identity.

This proved the real TEST provider boundary, not production.

---

## 14. Explicit nonclaims from the R2B proof

The certification did not establish:

```text
Payment Brick browser rendering/input       NOT CERTIFIED by R2B
Full browser checkout E2E                   NOT CERTIFIED by R2B
Real inbound Mercado Pago webhook           NOT CERTIFIED by R2B
Production credentials                      NOT USED
Real-money payment                          NOT PERFORMED
Production readiness                        NOT CLAIMED
```

Reusable rule:

> Separate "provider sandbox payment works" from browser, webhook and production-readiness claims.

---

## 15. Browser E2E history: harness failures are not payment failures

The R3 browser work exposed multiple non-provider defects:

- Mongo IPv6 startup/environment issue;
- frontend readiness issue;
- date-field automation mismatch;
- hidden input click interception;
- incorrect assumption about rendered MUI controls.

Several failing runs never reached:

- checkout API;
- provider tokenization;
- provider payment creation.

Reusable rule:

> Before classifying a payment test failure, determine whether execution actually crossed the provider boundary.

---

## 16. Product design lesson: test friction can reveal irrelevant requirements

Browser automation difficulty around a birth-date field led to a more important question:

Why was birth date required in payment checkout?

No authoritative payment requirement justified it.

The field was suppressed from the checkout surface, while broader domain cleanup remained separate.

Reusable rule:

> Do not overfit the test harness around a field that lacks business authority. Revisit the product requirement first.

---

## 17. Monitoring UI is weaker evidence than provider resource truth

During R2B, a Mercado Pago monitoring UI showed zero requests for the selected period while direct provider resource read-back proved the payment existed and was approved.

This was classified as:

`PROVIDER UI / TELEMETRY DISCREPANCY`

Reusable rule:

> When validating one transaction, direct provider resource truth is stronger than an aggregated monitoring screen.

---

## 18. Sensitive-data handling proven in MitoS

The R2B test generated a fresh one-time TEST CardToken.

Evidence recorded only whether token generation succeeded.

The raw token was not persisted.

Credentials were consumed as externally configured secrets.

No evidence artifact contained:

- Access Token;
- Public Key value;
- CardToken;
- CVV;
- password;
- JWT;
- session cookie.

Reusable rule:

> Evidence must prove behavior without becoming a secret store.

---

## 19. MitoS source patterns worth reusing conceptually

Relevant implementation files on the payment lineage included:

```text
backend/src/models/PaymentTransaction.ts
backend/src/middlewares/mercadoPagoPaymentGuard.ts
backend/src/controllers/mercadoPagoController.ts
backend/src/services/paymentStateService.ts
backend/src/routes/mercadoPagoRoutes.ts
frontend/src/services/MercadoPagoService.ts
backend/__tests__/mercadoPagoWebhook.test.ts
backend/__tests__/paymentStateService.test.ts
```

These are references, not templates to copy blindly.

The reusable value is in the invariants:

- authoritative pricing;
- same-key replay;
- atomic active claim;
- provider read-back;
- webhook verification;
- explicit normalized states;
- idempotent domain transitions;
- protected reconciliation.

---

## 20. Transfer rule

When applying this knowledge to another product:

Keep:

```text
trust boundaries
idempotency semantics
atomic concurrency claim
provider adapter
provider read-back
webhook authenticity
reconciliation
state normalization
evidence discipline
```

Replace:

```text
Booking
ReservationState
rental pricing
MitoS routes
MitoS UI
MitoS email events
Mongo-specific implementation if another datastore is used
```

The architecture survives even when the domain does not.
