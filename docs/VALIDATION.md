# Validación m-pago v0.3.0 — Tarjeta + Yape

Fecha: 2026-09-27.  
Rama: `feat/yape-checkout-api`.  
Base: `main@ae3bd5bafbe7f79f274a2c0005fb533d4a4df02e`.

## Resultado ejecutado

GitHub Actions:

- workflow: `Payment core validation`
- run: `36353522589`
- job: `validate`
- Node.js: `24.21.0`
- resultado: **success**
- URL: https://github.com/em3rc0dTh/m-pago/actions/runs/36353522589

| Comando / comprobación | Resultado |
|---|---|
| `npm ci --ignore-scripts --no-audit --no-fund` | PASS |
| `npm run check` | PASS — todos los JS parsean |
| `npm test` | **78 pruebas, 78 aprobadas, 0 fallidas** |
| `npm run demo` | PASS — `OFFLINE_SIMULATION` |
| `npm pack --dry-run` | PASS — `@em3rc0d/m-pago@0.3.0` |

La suite no necesita Internet ni secretos de Mercado Pago. La frontera externa se simula; servicio, handlers, SQLite, transacciones, procesos, recuperación y helper Yape son ejecutados.

## Cobertura Yape añadida

- tokenización browser-side mediante un fake de la superficie oficial `MercadoPago(...).yape(...).create()`;
- celular y OTP llegan al SDK simulado pero no forman parte del instrumento devuelto al backend;
- errores del SDK/tokenización se saneán;
- request Payments API contiene token, `payment_method_id=yape`, `installments=1` y no contiene celular/OTP;
- Yape exige PEN;
- Yape rechaza cuotas distintas de 1;
- Yape rechaza `issuerId` aportado por el cliente;
- read-back exige que `payment_method_id` coincida con el intento persistido;
- Yape y tarjeta compiten por la misma claim de una obligación;
- replay Yape reutiliza el mismo intento;
- el token Yape no queda almacenado en el ledger;
- el boundary HTTP acepta el instrumento Yape sin celular ni OTP.

## Cobertura heredada del core

La misma ejecución vuelve a probar, entre otros:

- veinte requests concurrentes con distintas claves → un create del proveedor simulado;
- seis procesos Node independientes y un SQLite compartido → un único POST;
- caída tras aceptación del POST → recuperación por búsqueda/GET sin segundo cobro;
- rollback atómico si falla inserción de outbox;
- idempotencia y fingerprint;
- autorización de cliente y operador;
- tenant isolation;
- webhook firmado y replay seguro;
- reconciliación;
- read-back de monto, moneda, referencia, collector, entorno e ID;
- estados desconocidos, refund, chargeback y snapshots fuera de orden;
- outbox durable y redelivery.

## Gates

| Gate | Estado v0.3.0 |
|---|---|
| C0 — checks/tests/package | **PASS — GitHub Actions** |
| C1 — aplicación de referencia | **PASS con proveedor simulado**; auth/dominio real se valida por producto |
| C2 — Mercado Pago TEST real | **PENDIENTE** |
| C3 — navegador con Mercado Pago JS real | **PENDIENTE** |
| C4 — webhook HTTPS entregado por Mercado Pago | **PENDIENTE** |
| C5 — producción | **PENDIENTE** |

## No afirmaciones

Este receipt **no** afirma:

- que se haya enviado celular/OTP reales;
- que se haya generado un token real de Yape;
- que exista una transacción Mercado Pago TEST;
- que el checkout haya sido probado contra MercadoPago.js real;
- que un webhook haya llegado desde infraestructura Mercado Pago;
- readiness de producción.

La documentación oficial de Yape está registrada en `PROVIDER_SOURCES.md` y `YAPE.md`.

## Siguiente certificación

Con credenciales TEST configuradas fuera del repositorio:

1. cargar Mercado Pago JS real con Public Key TEST;
2. usar el celular/OTP de prueba documentado por Mercado Pago;
3. generar un token Yape real de TEST;
4. crear el pago con este mismo core;
5. verificar por GET `live_mode=false`, collector, PEN, referencia, monto y `payment_method_id=yape`;
6. probar replay/reconciliación sin duplicar POST;
7. certificar browser E2E y webhook HTTPS real por separado.

Nunca adjuntar Access Token, webhook secret, OTP, celular real ni token efímero en logs, issues o receipts.
