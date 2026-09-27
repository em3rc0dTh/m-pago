# Integración v0.2.0

## 1. Contrato del producto

Una entidad cobrable debe tener un identificador único dentro del tenant. Si cobras anticipos, cuotas o adicionales, crea obligaciones distintas: `booking:123:deposit`, `booking:123:balance`. No cambies el precio de una obligación cuyo intento está activo.

Los contextos `{ tenantId, userId }` provienen de una sesión verificada por el backend. Nunca copies esos campos del JSON del cliente. `resolveQuote(context, payableId)` debe:

1. Cargar la entidad desde la base de datos del producto.
2. Verificar tenant, usuario, permiso para pagar y política del pagador.
3. Congelar de forma transaccional una cotización/obligación inmutable y su versión antes de devolverla. Las ediciones o cancelaciones del dominio deben respetar esa congelación, incluso durante la llamada externa.
4. Retornar el monto entero en unidades menores, moneda, exponente, descripción y datos de pagador obtenidos/validados por el backend.
5. Permitir consultar esa misma cotización para lecturas/replays autorizados después del pago; nunca recomputar un precio mutable para un pago histórico.

```js
return {
  amountMinor: 25000,       // PEN 250.00; nunca float 250.00 como autoridad
  currency: 'PEN',
  exponent: 2,
  version: 'quote-v1',
  description: 'Order 123',
  payer: {
    email: verifiedPayerEmail,
    // identification: { type: verifiedDocumentType, number: verifiedDocumentNumber }
  }
};
```

Cualquier conversión USD→PEN es política del producto: tasa aprobada, fecha, redondeo y total final congelados en su cotización. El paquete no inventa tasas ni impuestos. `amountMinor` debe ser entero positivo ≤ 10^12; exponentes 0–3 son configurables y deben coincidir con la moneda real de la cuenta.

## 2. Ensamblaje

Copia `.env.example` a un archivo local protegido e inyecta las variables en tu backend. No uses credenciales de producción para certificar TEST.

```js
import { PaymentService, MercadoPagoAdapter, SQLitePaymentStore,
  createPaymentHandlers } from '@em3rc0d/m-pago';

const provider = new MercadoPagoAdapter({
  accessToken: process.env.MP_ACCESS_TOKEN,  // TEST-… requerido en modo default
  collectorId: process.env.MP_COLLECTOR_ID, // cuenta receptora esperada
  currency: 'PEN', exponent: 2
});
const store = new SQLitePaymentStore('/var/lib/my-app/payments.sqlite');
const service = new PaymentService({
  store, provider, webhookSecret: process.env.MP_WEBHOOK_SECRET,
  resolveQuote,          // hook del producto descrito arriba
  authorizeOperator     // async (context, action) => boolean
});
const handlers = createPaymentHandlers({ service, authenticate });
```

`authenticate(request)` devuelve contexto verificado o rechaza la petición. Debe aplicar la política CSRF/Origin del producto si usa cookies. `authorizeOperator(context, action)` acepta exclusivamente identidades de operación verificadas; acciones: `reconcile` y `outbox`. Un cliente no puede autodeclararse operador. Las funciones de store y servicio son APIs internas del backend.

Cada archivo ledger queda vinculado a una sola combinación cuenta/entorno/moneda/exponente. Para múltiples comerciantes usa stores separados o implementa otro adapter; este paquete no administra OAuth ni credenciales por vendedor.

El modo LIVE requiere `liveMode: true, allowLive: true` explícitos y gates del producto completos. La verificación del prefijo TEST es una barrera local, no reemplaza comprobar credenciales/cuenta ni el `live_mode` de cada recurso.

## 3. Montar las rutas

| Ruta propuesta | Handler | Autorización |
|---|---|---|
| `POST /api/payments` | `handlers.create(request)` | Sesión + autorización sobre entidad |
| `GET /api/payables/:payableId/payments/:paymentId` | `handlers.get(request, {payableId, paymentId})` | Propietario original y tenant |
| `POST /api/payments/mercado-pago/webhook` | `handlers.webhook(request)` | Firma del proveedor |
| `POST /internal/payments/:paymentId/reconcile` | `handlers.reconcile(request, {paymentId})` | Operador |

Los handlers son funciones Fetch API; adapta tu framework. No se instala un servidor ni se crean rutas públicas automáticamente. Configura HTTPS, límite de conexiones, timeout de lectura del body, rate limit y manejo de errores en tu plataforma. El handler limita el JSON a 16 KiB; el webhook no consume el cuerpo.

```json
{
  "payableId": "order-123",
  "instrument": {
    "token": "TOKEN_EFIMERO_DEL_SDK",
    "paymentMethodId": "visa",
    "installments": 1
  }
}
```

Header obligatorio: `X-Idempotency-Key`, único por intento lógico. Identificadores de texto: 1–160 caracteres alfanuméricos o `_.:@/-`. `issuerId` es opcional y se envía como string. El core acepta la forma tokenizada indicada; no promete que todos los métodos/regiones utilicen esa forma.

Monto, moneda, pagador, referencia y estado del JSON exterior no se utilizan. El instrumento rechaza campos adicionales. PAN/CVV/OTP nunca deben llegar al backend; la UI usa el mecanismo de tokenización del proveedor con su Public Key. No persistas el token en localStorage ni en logs.

La misma clave + el mismo contenido relevante devuelve el intento existente; cambiar token, pagador, cotización o entidad produce `IDEMPOTENCY_CONFLICT`. Repetir mientras el resultado está incierto devuelve `creating` (HTTP 202), sin otro POST. Tras perder un token por recarga, consulta el estado por ID y usa recuperación operativa; no generes otra clave para salir de un timeout.

Respuestas con estado aprobado se basan en GET del proveedor. El estado local puede estar pendiente de un webhook/reconciliación. El frontend muestra el resultado del backend, no habilita la entrega por el redirect del proveedor.

## 4. Consumir eventos

```js
await service.dispatchEvents(operatorContext, async event => {
  await businessDatabase.transaction(async tx => {
    if (await tx.alreadyProcessed(event.id)) return;
    await tx.applyPaymentEvent(event); // validar tenant/entidad/monto y transición
    await tx.markProcessed(event.id);
  });
});
```

Ese fragmento es pseudocódigo de DB; [DemoDomain](../examples/domain-sqlite.js) implementa una versión ejecutable. Sus eventos no son correos ni mensajes al cliente: son sincronización interna. El paquete no manda notificaciones a personas.

`payment.approved` se emite una vez por intento al observar una aprobación íntegra. `payment.updated` incluye estados pendientes, cambios de disputa, reembolsos y resultados desconocidos. Implementa políticas de negocio para cada uno. Un pago observado por primera vez ya reembolsado no genera una aprobación retroactiva.

El evento contiene `{ id, type, payment, createdAt }`; `payment` contiene `id`, `tenantId`, `payableId`, `providerId`, `status`, `amountMinor`, `currency`, `refundedMinor`, `version`. Deduplica `event.id` en la misma transacción que la mutación de negocio. Para efectos externos crea otra intención durable y usa una clave idempotente; no asumas entrega exactamente una vez.

## 5. Gates por integración

Antes de salir de la simulación: validar país/cuenta/método, el adapter del dominio, autorización real, estrategia de almacenamiento y consumidor de eventos. Después: TEST con tokenización real, read-back, replay, UI, webhook HTTPS real y revisión de producción. Consulta `VALIDATION.md`.
