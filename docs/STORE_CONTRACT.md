# Contrato de persistencia v0.2.0

El store incluido es SQLite durable, de referencia, para un host. El servicio espera estos métodos; admite retornos directos o Promises. Un store PostgreSQL/MongoDB debe implementar las mismas garantías y repetir la suite con su motor real antes de declararse compatible. No se incluye ni se certifica un adapter para esos motores.

| Método | Garantía |
|---|---|
| `bindAccount(account)` | Persistir y comparar binding cuenta/modo/moneda/exponente; rechazar reutilización incompatible |
| `claim(candidate)` | Transacción: buscar `requestKey`, comparar fingerprint o insertar; adquirir UNIQUE activeKey antes de I/O; retorna `{created, record}` |
| `get(id)` / `getByProviderId(id)` | Registro durable o null |
| `attachProviderId(id, providerId)` | Transacción y binding inmutable, UNIQUE providerId |
| `apply(id, snapshot, now?)` | Leer estado actual bajo lock; verificar versión/transición; actualizar ledger y crear outbox atómicamente |
| `list({after,limit})` | Paginación por ID estable; límite 1–1000; registros completos |
| `leaseEvent({now,leaseMs}?)` | Lease exclusiva con fencing token y recuperación por vencimiento; respetar orden |
| `ackEvent(id,token)` | Marcar entrega solo para propietario vigente de la lease |
| `retryEvent(id,token,retryAt)` | Reprogramar sin sobrescribir lease de otro worker |
| `close()` | Liberar recursos |

Campos e índices reales están en `src/sqlite-store.js`. Payload de intento: UUID, tenant, actor, entidad cobrable, hashes de requestKey/activeKey/fingerprint, monto menor, moneda/exponente, versión de cotización, ID/estado del proveedor, versión local, indicadores de aprobación y timestamps. No incluye token, email, documento ni credenciales. Un hash de fingerprint no debe tratarse como mecanismo para almacenar secretos de baja entropía: el request completo tampoco se registra fuera del ledger.

`requestKey = hash(tenant, user, clientKey)`; `activeKey = hash(tenant, payableId)`; cuenta/entorno están aislados por binding del store. `external_reference` y clave del proveedor son el UUID del intento, no el ID del pedido. La correlación con el dominio queda en el ledger. Los constraints deben arbitrar entre todos los procesos; no sustituirlos por mutex local.

Nunca ejecutar I/O del proveedor dentro de una transacción SQL. La claim se confirma primero. Ante error ambiguo, conservarla. `apply` solo libera activeKey para rechazo/cancelación verificados; no para unknown, timeout, devolución o contracargo. El control de snapshots se vuelve a ejecutar dentro de la transacción después del GET para evitar sobrescritura concurrente.

Outbox: evento único por `paymentId:version`. Estado y evento se confirman juntos. Las leases no hacen exactamente una vez: tras vencer puede haber dos consumidores ejecutándose. El consumidor deduplica en su DB con una restricción única y transacción que incluya el cambio de negocio. Sin esa implementación, no está terminada la integración del producto.

Pruebas mínimas al reemplazar el store: carreras entre procesos distintos, keys iguales/distintas, caída tras claim/tras POST/tras commit, duplicados de proveedor, rollback del evento y estado, snapshots fuera de orden, lease vencida, restart, backup/restore y permisos del operador.
