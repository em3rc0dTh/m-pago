# Operación y recuperación v0.2.0

## Reglas de estado

| Estado normalizado | ¿Retiene claim? | Significado |
|---|---|---|
| `creating` | Sí | POST pendiente o resultado incierto |
| `pending` | Sí | pending/in_process/authorized; no entregar |
| `approved` | Sí | Read-back validado; genera evento de aprobación |
| `partially_refunded` | Sí | approved con monto reembolsado > 0 |
| `in_mediation` | Sí | Disputa; requiere política del producto |
| `refunded` | Sí | Reembolso observado; no reabrir cobro automáticamente |
| `charged_back` | Sí | Contracargo, separado de reembolso |
| `unknown` | Sí | Estado nuevo/no reconocido; nunca equivale a fallo cobrable de nuevo |
| `rejected` / `cancelled` | No | Resultado terminal comprobado por GET; admite intento nuevo |

Los errores HTTP, incluidos 4xx, se tratan de forma conservadora como ambiguos. No hay reintentos automáticos de POST, TTL de claim ni endpoint que libere una claim manualmente.

Se usa `date_last_updated` del proveedor para ordenar snapshots, no el orden de llegada de webhooks. Snapshots anteriores no sobrescriben; misma fecha con contenido financiero contradictorio exige atención. Regresiones desde aprobación a pendiente/rechazo, reducción del reembolso o reversión de estados terminales son rechazadas. Transiciones no previstas requieren revisión y prueba antes de modificar la política.

## Reconciliación programada

El host ejecuta un job privado con identidad de operador. No hay tareas programadas externas creadas por el paquete.

```js
let after = '';
do {
  const page = await service.reconcileBatch(operatorContext, { after, limit: 100 });
  // registrar únicamente id/status/error; alertar y reintentar errores con backoff
  after = page.nextCursor;
} while (after);
await service.dispatchEvents(operatorContext, consumeEvent);
```

Programa barridos periódicos completos; nuevos UUID pueden caer antes de un cursor anterior. El batch aísla errores y limita filas por página. Ajusta frecuencia y backoff al volumen y límites de la cuenta. Revisa pagos aprobados también: pueden cambiar a reembolso/disputa después. El outbox entrega en orden global; un evento fallido bloquea los siguientes hasta resolverse y requiere alerta. La lease dura 60 s; el consumidor debe terminar antes o tolerar ejecución concurrente por deduplicación transaccional.

## Resultado incierto / caída de proceso

1. Mantener el intento y su claim; no cobrar con otra clave.
2. Si existe `providerId`, GET y validación completa.
3. Si falta, buscar por `external_reference = UUID del intento`.
4. Un único resultado se relee por ID y valida antes de aceptar.
5. Cero resultados permanece `creating`: ausencia en búsqueda no prueba que el cobro no exista.
6. Varios resultados, diferencia de monto/cuenta/moneda o referencia: no modificar dominio; investigar con acceso de operador y evidencia saneada.

Una caída entre claim y POST puede dejar el intento bloqueado sin cobro. Se prefiere esa indisponibilidad a cobrar de nuevo sin certeza. La versión actual no automatiza su liberación: requiere investigación y un procedimiento de reparación específico del producto. No borres filas ni cambies claves para forzar una recuperación. No dependas de una ventana indefinida de idempotencia del proveedor.

## Webhooks

Configura en la aplicación de Mercado Pago el tópico `payment` y la URL HTTPS del handler. Conserva query string `data.id`, `x-request-id` y `x-signature` a través del proxy. La firma no autentica el cuerpo completo; el handler lo ignora y consulta el recurso firmado.

Política local deliberadamente estricta: HMAC SHA-256 v1, todos los campos presentes, sin duplicados, secreto de al menos 16 caracteres, timestamp ±5 min. Acepta representaciones de timestamp de 10 y 13 dígitos conservando el texto original para firmar. El servicio solo procesa IDs numéricos de Payments API. Mantén el reloj sincronizado.

Solo responde 200 tras completar la sincronización durable. Una firma válida para otro pago del mismo comerciante, sin intento local, se ignora con 200. Un fallo de firma o de sincronización no se reconoce como éxito. Si un reintento del proveedor conserva una firma fuera de ventana, se rechazará; el barrido de reconciliación cubre ese caso. No se declara entrega real de webhooks hasta verificarla con el proveedor.

## Persistencia, despliegue y alertas

SQLite usa WAL, `synchronous=FULL`, `BEGIN IMMEDIATE` y restricciones UNIQUE. Una DB por cuenta/entorno/moneda; múltiples procesos deben abrir **el mismo archivo local**. Permisos restrictivos del directorio y cifrado/backups corresponden al host. Usa el backup API de SQLite o detén escrituras de forma controlada: copiar solo el archivo principal activo puede perder el WAL. Prueba restauración antes de producción.

No usar este store sobre NFS, discos efímeros ni réplicas con archivos independientes. SQLite síncrono puede bloquear el event loop bajo carga; medir volumen, latencia y contención antes de elegirlo. Los registros y eventos se retienen; definir archivo/retención sin romper deduplicación e idempotencia.

Alertar sobre: `creating` envejecidos; `unknown`; mismatches; `PROVIDER_UNAVAILABLE`; `STATE_REGRESSION`; errores/bloqueo del outbox; retraso de reconciliación; disco lleno; fallos de autenticación. Los errores públicos están saneados. El host debe evitar registrar request bodies, headers Authorization, tokens y respuestas crudas del proveedor.
