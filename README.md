# m-pago

**Mercado Pago Integration Knowledge Base — ASTRA WORK v1**

Repositorio dedicado a preservar y reutilizar el conocimiento de integración con Mercado Pago obtenido durante el trabajo de MitoS / BookCars, separando las reglas genéricas del dominio original.

## Propósito

Este repositorio no es una copia de MitoS. Es una base de conocimiento de ingeniería para implementar Mercado Pago de forma robusta en distintos productos.

Principio central:

```text
Browser / App
  = intención del usuario + datos tokenizados por el proveedor

Backend
  = identidad de negocio + monto/moneda autoritativos + idempotencia + estado de dominio

Mercado Pago
  = verdad de la transacción

Webhook + reconciliación
  = mecanismos de sincronización
```

Un redirect, callback o mensaje de éxito en frontend **no** es autoridad suficiente para confirmar un pago.

## Documentos

- `docs/GENERIC_INTEGRATION_PLAYBOOK_v1.0.md`
- `docs/MITOS_LESSONS_AND_EVIDENCE_v1.0.md`
- `docs/ASTRA_WORK_HANDOFF_v1.0.md`

## Qué preserva

- server-owned amount/currency;
- `external_reference`;
- `X-Idempotency-Key`;
- replay seguro de la misma operación;
- protección contra pagos concurrentes con claves distintas;
- claim atómica persistida antes del I/O con el proveedor;
- verificación de webhook;
- provider read-back;
- reconciliación;
- estados normalizados;
- transiciones y side effects idempotentes;
- separación clara entre TEST provider, browser E2E, webhook real y production readiness.

## Provenance

Las reglas fueron extraídas de la integración real desarrollada y certificada en MitoS / BookCars, incluyendo:

- R2A — application boundary;
- R2B — Mercado Pago TEST provider real;
- defectos de autorización y concurrencia encontrados durante ejecución;
- evidencia de replay/idempotencia;
- trabajo R3 de browser E2E y sus límites.

La historia MitoS queda como evidencia; la arquitectura reusable no depende del dominio de alquiler de vehículos.

## Seguridad

Este repositorio no debe contener:

- Access Tokens;
- webhook secrets;
- PAN;
- CVV;
- OTP;
- raw card tokens;
- passwords;
- JWTs;
- session cookies.

TEST y producción deben mantenerse separados.

## Estado

`ASTRA WORK v1` — knowledge base inicial.
