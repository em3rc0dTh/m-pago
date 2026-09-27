# Fuentes y decisiones — revisión 2026-09-27

## Documentación oficial consultada

- [Crear pago — Payments API](https://www.mercadopago.com.pe/developers/es/reference/online-payments/checkout-api-payments/create-payment/post): `/v1/payments`, Access Token y `X-Idempotency-Key` requerido. Se usa un UUID persistido por intento; no se reenvía un POST automáticamente después de un resultado incierto.
- [Obtener pago](https://www.mercadopago.com.pe/developers/es/reference/online-payments/checkout-api-payments/get-payment/get): recurso utilizado para la sincronización canónica.
- [Buscar pagos](https://www.mercadopago.com.pe/developers/es/reference/online-payments/checkout-api-payments/search-payments/get): recuperación por referencia externa. Una búsqueda vacía no se interpreta como permiso para cobrar otra vez.
- [Webhooks oficiales](https://www.mercadopago.com.pe/developers/es/docs/links-and-debts/additional-content/your-integrations/notifications/webhooks): configuración de firma, `x-signature`, `x-request-id`, `data.id` de query, tópico payment, confirmación HTTP y consulta posterior del recurso. La página es transversal; no implica que este paquete implemente Links y Deudas.
- [SDK Node oficial — verificador](https://github.com/mercadopago/sdk-nodejs/blob/59a1f91e7c072cbda4e394267b24e7383ea3b1f3/src/utils/webhook/index.ts) y [pruebas](https://github.com/mercadopago/sdk-nodejs/blob/59a1f91e7c072cbda4e394267b24e7383ea3b1f3/src/utils/webhook/webhook.spec.ts): contrastados con checkout local de ese commit. Se verificó el manifest HMAC y comparación constante; no se copió ni vendorizó el SDK.

- [Yape — Checkout API vía Payments API](https://www.mercadopago.com.pe/developers/es/docs/checkout-api-payments/integration-configuration/yape): tokenización con celular + OTP mediante Mercado Pago JS, token de un solo uso, `payment_method_id=yape`, `installments=1`, creación por `/v1/payments` y datos TEST publicados por Mercado Pago.

## Decisiones locales adicionales

El verificador del paquete impone campos completos, sin duplicados y ventana de cinco minutos. La implementación oficial contempla omitir campos ausentes y tolerancia opcional; aquí se rechazan deliberadamente esos mensajes incompletos. El SDK revisado conserva el caso de `dataId`, mientras ejemplos documentales indican minúsculas para IDs alfanuméricos. El servicio de este paquete solo acepta IDs **numéricos** de Payments API; no se declara compatibilidad de Orders API a partir del helper de firmas.

El SDK revisado interpreta segundos para tolerancia, mientras sus fixtures incluyen un timestamp de 13 dígitos. El helper local acepta 10/13 dígitos y preserva `ts` original en el HMAC. Son políticas de este paquete que todavía requieren comprobación con entregas TEST reales.

Payments API y Orders API son superficies distintas. La documentación actual muestra ambas; no se cambió silenciosamente `/v1/payments` a `/v1/orders`. La moneda se fija en configuración de cuenta y se comprueba en read-back; el adapter no envía un campo `currency_id` inventado en creación. El contrato de request también se contrastó con [tipos oficiales del SDK](https://github.com/mercadopago/sdk-nodejs/blob/59a1f91e7c072cbda4e394267b24e7383ea3b1f3/src/clients/payment/create/types.ts).

Las garantías de claim, frozen quote, outbox, permisos y retención ante incertidumbre son decisiones de ingeniería locales, no garantías delegadas al proveedor. Consultar fuentes no equivale a ejecutar una transacción real.


## Decisiones Yape

El frontend helper `@em3rc0d/m-pago/yape` devuelve únicamente `{ token, paymentMethodId: "yape", installments: 1 }`. El celular y OTP no cruzan al backend. El core restringe Yape a PEN, rechaza cuotas distintas de 1 e issuer inyectado, y exige que el read-back de Payments API confirme `payment_method_id=yape`. Estas restricciones son decisiones locales de defensa en profundidad alineadas con el contrato documentado del proveedor.


## Credenciales y ambiente

Mercado Pago documenta credenciales de prueba y producción por separado, pero también indica que el prefijo del Access Token de prueba **puede variar según la solución**. Por ello, `m-pago` no usa el prefijo del token como autoridad del entorno. El integrador debe declarar `environment: "test" | "live"`, y LIVE requiere además `allowLive: true`. El read-back mantiene la verificación de `live_mode` del recurso como control adicional.

Fuentes:
- https://www.mercadopago.com.pe/developers/es/docs/your-integrations/credentials
- https://www.mercadopago.com.pe/developers/es/docs/checkout-api-payments/prerequisites
