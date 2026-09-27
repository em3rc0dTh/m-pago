# Validación m-pago v0.2.0

Fecha: 2026-09-27. Rama: `feat/reusable-payment-core`.
Base revisada: `b581d7b4e0d3b2acb56f9fbe7d769fe58bd16d8d`.
Runtime local: Node.js 24.19.0, SQLite 3.53.3.

## Resultado ejecutado

| Comando / comprobación | Resultado |
|---|---|
| `npm ci --ignore-scripts --no-audit --no-fund` | Correcto, cero dependencias externas |
| `npm run check` | Parseo sintáctico de JS correcto; no es typecheck TypeScript |
| `npm test` | **61 pruebas, 61 aprobadas, 0 fallidas, 0 omitidas** |
| `npm run demo` | OFFLINE_SIMULATION, un POST, replay del mismo pago y una intención de fulfillment |
| `npm pack` + instalación en consumidor temporal | Importación, SQLite y demo del paquete instalado correctos |
| `git diff --check` | Correcto |
| Revisión de literales de credenciales | Sin credenciales reales identificadas; fixtures etiquetados, `.env.example` vacío |

La suite no necesita Internet ni secretos. Se simula la superficie externa del proveedor; servicio, handlers, SQLite, transacciones, procesos y recuperación son ejecutados.

## Escenarios relevantes

- Veinte llamadas concurrentes con distintas claves: un único create del proveedor simulado.
- Seis procesos Node independientes y un archivo SQLite: una aprobación y cinco conflictos; exactamente un POST HTTP al proveedor local simulado.
- Muerte de proceso con exit 23 después de aceptación del POST, antes de persistir provider ID: un nuevo servicio recupera por referencia y GET; ningún segundo POST.
- Inserción de outbox forzada a fallar mediante trigger SQLite: rollback del estado; reconciliación posterior confirma estado y evento juntos.
- Snapshot aprobado lento que llega después de reembolso: no revierte el estado nuevo.
- Evento consumido sin ack / lease expirada: redelivery con mismo ID; consumidor deduplica.
- Autorización de creación/replay/consulta/operación, aislamiento de tenants y binding de cuenta/entorno.
- Monto/currency/reference/collector/live-mode/ID/timestamp erróneos: ningún evento de aprobación ni liberación de claim.
- Timeout, 4xx, 429, 5xx y JSON inválido: error saneado, sin POST automático adicional.
- Firmas alteradas, campos duplicados/ausentes, timestamp viejo/futuro y recurso adulterado: rechazo.
- Body de webhook falsificado: se consulta exclusivamente el ID firmado de URL.
- Rechazo/cancelación, unknown, reembolsos parciales/totales, contracargos y snapshots contradictorios.
- Revisión de archivos SQLite/WAL del escenario de caída: sin token de tarjeta ni email fixture persistidos.

## Gates y límites

| Gate | Estado de esta entrega |
|---|---|
| C0 — checks y tests | PASS local |
| C1 — aplicación de referencia | PASS local para core/handlers/SQLite; auth y dominio reales del producto aún deben validarse |
| C2 — Mercado Pago TEST real | PENDIENTE: no se suministraron ni usaron credenciales TEST reales |
| C3 — browser E2E | PENDIENTE: no hay checkout frontend real incluido |
| C4 — webhook real | PENDIENTE: no se desplegó URL HTTPS ni se recibió entrega real del proveedor |
| C5 — producción | PENDIENTE: revisión de producto, infraestructura, carga, backups, alertas y gates anteriores |

La documentación de Mitos se conserva como provenance importada, no como evidencia ejecutada en este runtime. Tampoco se afirma certificación de otro DB, framework, país, método de pago o proveedor. El workflow incluido repite los checks sin credenciales; su ejecución remota debe comprobarse en el PR.

## Siguiente certificación por producto

Con una integración de dominio real y credenciales TEST cargadas de forma segura en su entorno:

1. Crear pago usando la tokenización real del país/método elegidos.
2. Verificar `live_mode=false`, cuenta, monto, moneda, referencia y GET.
3. Repetir intento, inducir timeout controlado y comprobar recuperación sin duplicado.
4. Validar controles de sesión/tenant/pagador y eventos en la base del producto.
5. Completar checkout navegador y entrega de webhook HTTPS con firma válida.
6. Probar reconciliación cuando no llega el webhook y consumo de eventos tras reinicio.

No pegar secretos en issues, PRs, capturas ni reportes. Registrar solo IDs operativos y evidencia saneada.
