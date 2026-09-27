# Yape — Checkout API / Payments API

Estado del paquete: **soporte ejecutable local v0.3.0; certificación Mercado Pago TEST real pendiente**.

Este módulo usa la superficie **Checkout API vía Payments API `/v1/payments`**. No usa Checkout Pro ni Orders API.

Fuente oficial principal:

- https://www.mercadopago.com.pe/developers/es/docs/checkout-api-payments/integration-configuration/yape

## Límite de seguridad

```text
Navegador
  celular + OTP
       |
       v
Mercado Pago JS
  mp.yape({ phoneNumber, otp }).create()
       |
       v
token Yape de un solo uso
       |
       v
backend del producto
       |
       v
m-pago -> /v1/payments
```

El **celular y el OTP no deben enviarse al backend de tu aplicación**. El backend recibe únicamente el token de un solo uso y el identificador fijo del método.

El paquete exporta un entrypoint de navegador independiente para no arrastrar SQLite ni módulos Node:

```js
import { createYapeInstrument } from '@em3rc0d/m-pago/yape';

const instrument = await createYapeInstrument({
  publicKey: import.meta.env.VITE_MP_PUBLIC_KEY,
  phoneNumber: form.phone.value,
  otp: form.otp.value,
});

// instrument:
// {
//   token: '...',
//   paymentMethodId: 'yape',
//   installments: 1
// }
```

También puedes ver `examples/yape-browser.js`.

## Enviar el pago al backend

El navegador envía:

```http
POST /api/payments
Content-Type: application/json
X-Idempotency-Key: <clave lógica del intento>
```

```json
{
  "payableId": "order-123",
  "instrument": {
    "token": "TOKEN_YAPE_DE_UN_SOLO_USO",
    "paymentMethodId": "yape",
    "installments": 1
  }
}
```

No incluyas:

- celular;
- OTP;
- monto;
- moneda;
- estado del pago;
- email autoritativo;
- Access Token.

El backend resuelve monto, moneda y pagador mediante `resolveQuote`.

## Reglas que hace cumplir m-pago

Para Yape:

- moneda de la cuenta: `PEN`;
- `paymentMethodId === "yape"`;
- `installments === 1`;
- no se acepta `issuerId` enviado por el cliente;
- el token no se guarda en el ledger;
- la misma claim evita que Yape y tarjeta cobren simultáneamente la misma obligación;
- el GET de Mercado Pago debe devolver también `payment_method_id: "yape"` antes de aceptar la aprobación;
- monto, moneda, referencia, collector y `live_mode` siguen verificándose como en tarjeta.

El request del adapter a Mercado Pago contiene conceptualmente:

```json
{
  "transaction_amount": 25,
  "token": "<token-yape>",
  "payment_method_id": "yape",
  "installments": 1,
  "payer": {
    "email": "<email-validado-por-backend>"
  },
  "description": "<descripción-del-producto>",
  "external_reference": "<payment-attempt-id>"
}
```

y envía `X-Idempotency-Key` usando el UUID durable del intento.

## Inicializar Mercado Pago JS

La documentación oficial usa MercadoPago.js v2:

```html
<script src="https://sdk.mercadopago.com/js/v2"></script>
```

y una Public Key en el navegador:

```js
const mp = new MercadoPago('YOUR_PUBLIC_KEY');
```

`createYapeInstrument` recibe el constructor `MercadoPago` global por defecto, o puedes inyectarlo desde tu bundler/tests.

## TEST

Mercado Pago documenta OTP `123456` y números de prueba para simular resultados. Ejemplos publicados:

| Celular | Resultado esperado |
|---|---|
| `111111111` | aprobado |
| `111111112` | rechazo: autorización |
| `111111113` | rechazo: fondos insuficientes |
| `111111114` | otro rechazo |
| `111111115` | tipo de tarjeta no permitido |
| `111111116` | máximo de intentos |
| `111111117` | código de seguridad inválido |
| `111111118` | error de formulario |

Usa siempre las credenciales de prueba indicadas por Mercado Pago para la cuenta correspondiente. Este repositorio **todavía no declara C2 aprobado**: la suite actual simula la frontera externa.

## Gates pendientes

```text
C0 core/tests/package             PASS — 78/78, GitHub Actions run 36353522589
C1 integración de referencia      cubierto sin proveedor real
C2 Mercado Pago TEST real         PENDIENTE
C3 browser E2E con SDK real       PENDIENTE
C4 webhook HTTPS real             PENDIENTE
C5 producción                     PENDIENTE
```

No promociones a producción basándote solo en los tests simulados.
