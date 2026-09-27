# m-pago

Núcleo reusable de integración con **Mercado Pago Payments API `/v1/payments`**, con ledger durable, idempotencia, webhook autenticado y recuperación. Conserva el conocimiento extraído de Mitos/BookCars, pero su código no depende de alquileres ni de ese repositorio.

**Estado: implementación de referencia v0.3.0 con tarjeta + Yape; certificación Mercado Pago TEST real pendiente.** No es un SDK oficial de Mercado Pago ni una integración universal ya certificada.

## Ejecutar ahora

Requiere **Node.js 24+**. No tiene dependencias npm de ejecución ni de pruebas.

```bash
git clone https://github.com/em3rc0dTh/m-pago.git
cd m-pago
npm ci
npm run check
npm test
npm run demo
```

El demo es completamente offline: usa el adapter real con transporte simulado y dos bases SQLite temporales. Prueba cobro → read-back → replay → outbox → una intención de fulfillment. No requiere credenciales ni realiza pagos.

## Qué resuelve

- Precio, moneda e identidad del pagador derivados por el backend.
- Una claim transaccional por entidad cobrable, compartida entre procesos.
- Idempotencia local con fingerprint; UUID del intento como `X-Idempotency-Key` del proveedor.
- Entorno Mercado Pago declarado explícitamente (`test|live`); LIVE requiere opt-in y no se infiere por prefijo del token.
- Read-back antes de aceptar el estado: verifica ID, referencia, monto, moneda, método de pago, cuenta y `live_mode`.
- Resultado incierto permanece bloqueado; recuperación mediante búsqueda y GET, sin otro POST.
- Firma HMAC, comparación constante, timestamp y recurso de la URL firmado.
- Estados desconocidos, reembolsos parciales, contracargos y eventos fuera de orden.
- Ledger y outbox en una transacción; entrega **al menos una vez** con deduplicación a cargo del consumidor.
- Handlers Fetch `Request`/`Response`, autorización obligatoria y reconciliación privilegiada.

## Integrarlo en otro sistema

Empieza por [la guía de integración](docs/INTEGRATION.md) y [el ensamblaje del backend](examples/wire-backend.js). El producto implementa tres hooks: `resolveQuote`, `authenticate` y `authorizeOperator`; además consume eventos con deduplicación transaccional.

Para instalar desde un checkout revisado:

```bash
# Dentro de m-pago:
npm pack
# Dentro de tu backend Node.js:
npm install /ruta/m-pago/em3rc0d-m-pago-0.3.0.tgz
```

Importación: `import { PaymentService, MercadoPagoAdapter, SQLitePaymentStore } from '@em3rc0d/m-pago'`.
El paquete está marcado `private` para impedir publicación accidental a npm. Se distribuye por checkout/tarball; no está publicado en npm.

| Parte | Implementación incluida | Responsabilidad del producto |
|---|---|---|
| Backend | Núcleo JavaScript ESM y handlers HTTP | Sesión, permisos, CSRF, rate limits, rutas |
| Precio | Snapshot de monto entero y moneda | Cálculo, impuestos, conversión y congelación de cotización |
| Ledger | SQLite WAL, transacciones y restricciones UNIQUE | Disco local durable, permisos, backups |
| UI | Contrato tokenizado + helper Yape (`@em3rc0d/m-pago/yape`) | SDK/experiencia visual del checkout |
| Negocio | Outbox durable | Aplicar evento y deduplicarlo en una sola transacción |
| Operación | Reconciliación paginada y dispatch | Scheduler, alertas y atención de casos inciertos |

SQLite soporta varios procesos **en un mismo host/disco local**. Réplicas en distintos servidores, serverless y volúmenes efímeros requieren otro store compartido; véase [contrato de persistencia](docs/STORE_CONTRACT.md). Un backend Java/Python puede usar este núcleo detrás de un servicio privado diseñado por el producto; no existe un SDK nativo para esos runtimes.

## Métodos incluidos

| Método | Backend | Frontend reusable | Certificación real |
|---|---|---|---|
| Tarjeta tokenizada | ✅ Payments API | contrato de token | ⏳ C2/C3 pendiente |
| Yape | ✅ `payment_method_id=yape`, 1 cuota, PEN | ✅ `createYapeInstrument` | ⏳ C2/C3 pendiente |

Para Yape consulta [`docs/YAPE.md`](docs/YAPE.md). Celular y OTP se usan únicamente para generar el token con Mercado Pago JS; no llegan al backend.

## Alcance y evidencia

Incluye pagos únicos tokenizados mediante Payments API. **No incluye** Orders API `/v1/orders`, Checkout Pro/preferences, suscripciones recurrentes, marketplaces/OAuth, captura manual ni comandos para emitir reembolsos. Sí sincroniza estados de reembolsos y contracargos observados en el proveedor.

La compatibilidad del país/cuenta/método y la UI real se validan por producto. No se afirma que cualquier cuenta de Mercado Pago acepte este flujo.

- [Contrato y arranque de integración](docs/INTEGRATION.md)
- [Yape — Checkout API](docs/YAPE.md)
- [Operación y recuperación](docs/OPERATIONS.md)
- [Contrato para otros stores](docs/STORE_CONTRACT.md)
- [Evidencia y gates](docs/VALIDATION.md)
- [Fuentes oficiales y decisiones](docs/PROVIDER_SOURCES.md)
- [Seguridad](SECURITY.md)

## Conocimiento histórico

- [Playbook genérico v1](docs/GENERIC_INTEGRATION_PLAYBOOK_v1.0.md)
- [Lecciones y provenance Mitos](docs/MITOS_LESSONS_AND_EVIDENCE_v1.0.md)
- [Handoff ASTRA WORK v1](docs/ASTRA_WORK_HANDOFF_v1.0.md)

Los documentos históricos contienen afirmaciones sobre ejecuciones externas a este repositorio. Esta entrega no las recertifica. Para comportamiento ejecutable prevalecen `src/`, sus pruebas y la documentación v0.2.0; la evidencia Mitos no certifica automáticamente este paquete.
