# Seguridad

Este paquete procesa datos tokenizados de pagos; el integrador conserva la responsabilidad de autenticación, autorización, configuración y operación del producto.

- Mantener Access Token y webhook secret exclusivamente en el backend; separar TEST/LIVE y cuentas.
- La Public Key corresponde a la tokenización cliente; no permite confirmar pagos.
- No enviar PAN, CVV ni OTP al backend; para Yape, celular + OTP existen solo en la tokenización navegador → Mercado Pago. No registrar instrumentos, tokens, documentos, payloads completos ni headers de autorización.
- Los tokens Yape son efímeros/de un solo uso: no guardarlos en localStorage, logs, analytics, capturas ni ledger.
- Configurar sesiones verificadas, CSRF cuando corresponda, TLS, rate limiting y acceso privado a operaciones.
- Almacenar ledger en disco durable con permisos y backups controlados. El paquete no cifra la DB.
- No liberar claims por edad o timeout; no tratar redirects como prueba de pago.
- El parámetro `fetch` inyectable está destinado a pruebas/transporte confiable del backend. No aceptar transporte/configuración desde el cliente.
- Aplicar políticas de elegibilidad/freeze de la obligación en el dominio y deduplicación transaccional del consumidor de eventos.

No adjuntar credenciales ni datos de clientes en issues/PRs. Para reportar una vulnerabilidad, utilizar el canal privado habilitado por el propietario del repositorio; si no hay uno, solicitar contacto privado sin publicar el detalle explotable.

No se certifica cumplimiento PCI ni producción por pasar la suite local. Revisar los gates de `docs/VALIDATION.md` para cada despliegue.
