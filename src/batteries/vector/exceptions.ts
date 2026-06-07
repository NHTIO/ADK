/**
 * Battery-scoped exception constructors for vector store adapter failures.
 *
 * @module @nhtio/adk/batteries/vector/exceptions
 *
 * @remarks
 * Battery-scoped exception classes for the vector store battery. These exceptions are owned
 * by the battery (not the ADK core) and are minted via `createException` from
 * `@nhtio/adk/factories`. Re-exported from the battery's barrel.
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when the vector store configuration fails validation.
 * Fatal: config bugs fail loud at construction time.
 */
export const E_INVALID_VECTOR_STORE_CONFIG = createException<[string]>(
  'E_INVALID_VECTOR_STORE_CONFIG',
  'Invalid vector store config: %s',
  'E_INVALID_VECTOR_STORE_CONFIG',
  529,
  true
)

/**
 * Thrown when the vector store driver is unavailable.
 * Fatal: driver failures are critical.
 */
export const E_VECTOR_STORE_DRIVER_UNAVAILABLE = createException<[string]>(
  'E_VECTOR_STORE_DRIVER_UNAVAILABLE',
  'Vector store driver unavailable: %s',
  'E_VECTOR_STORE_DRIVER_UNAVAILABLE',
  503,
  true
)

/**
 * Thrown when the vector store adapter receives text input but has no encoder and no built-in encoding.
 * Fatal: encoding is required for vector operations.
 */
export const E_VECTOR_STORE_ENCODER_REQUIRED = createException<[string]>(
  'E_VECTOR_STORE_ENCODER_REQUIRED',
  'Vector store adapter "%s" received text input but has no encoder and no built-in encoding; supply an encoder or pass a precomputed vector',
  'E_VECTOR_STORE_ENCODER_REQUIRED',
  529,
  true
)

/**
 * Thrown when a vector's dimension does not match the expected dimension.
 * Fatal: dimension mismatch indicates incompatible data.
 */
export const E_VECTOR_STORE_DIMENSION_MISMATCH = createException<[number, number]>(
  'E_VECTOR_STORE_DIMENSION_MISMATCH',
  'Vector dimension mismatch: expected %d, got %d',
  'E_VECTOR_STORE_DIMENSION_MISMATCH',
  529,
  true
)

/**
 * Thrown when a filter operator/dialect is unsupported by the adapter.
 * Fatal: unsupported filter dialects cannot be processed.
 */
export const E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR = createException<[string, string]>(
  'E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR',
  'Filter operator/dialect unsupported by adapter "%s": %s',
  'E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR',
  529,
  true
)

/**
 * Thrown when an operation is unsupported by the adapter.
 * Fatal: unsupported operations cannot be performed.
 */
export const E_VECTOR_STORE_UNSUPPORTED_OPERATION = createException<[string, string]>(
  'E_VECTOR_STORE_UNSUPPORTED_OPERATION',
  'Operation "%s" is unsupported by adapter "%s"',
  'E_VECTOR_STORE_UNSUPPORTED_OPERATION',
  529,
  true
)

/**
 * Thrown when the query builder is in a conflicting state.
 * Fatal: conflicting state indicates programming errors.
 */
export const E_VECTOR_STORE_QUERY_CONFLICT = createException<[string]>(
  'E_VECTOR_STORE_QUERY_CONFLICT',
  'Conflicting query builder state: %s',
  'E_VECTOR_STORE_QUERY_CONFLICT',
  529,
  true
)

/**
 * Thrown when a read operation requires an explicit select projection.
 * Fatal: projection is required for read operations.
 */
export const E_VECTOR_STORE_PROJECTION_REQUIRED = createException<[]>(
  'E_VECTOR_STORE_PROJECTION_REQUIRED',
  'A read requires an explicit .select() projection',
  'E_VECTOR_STORE_PROJECTION_REQUIRED',
  529,
  true
)

/**
 * Thrown when the adapter does not support transactions.
 * Fatal: transaction support is required for the requested operation.
 */
export const E_VECTOR_STORE_TRANSACTIONS_UNSUPPORTED = createException<[string]>(
  'E_VECTOR_STORE_TRANSACTIONS_UNSUPPORTED',
  'Adapter "%s" does not support transactions',
  'E_VECTOR_STORE_TRANSACTIONS_UNSUPPORTED',
  529,
  true
)

/**
 * Thrown when the raw fragment placeholder count does not match the bindings length.
 * Fatal: binding mismatch indicates query construction errors.
 */
export const E_VECTOR_STORE_RAW_BINDING_MISMATCH = createException<[number, number]>(
  'E_VECTOR_STORE_RAW_BINDING_MISMATCH',
  'Raw fragment placeholder count (%d) does not match bindings length (%d)',
  'E_VECTOR_STORE_RAW_BINDING_MISMATCH',
  529,
  true
)

/**
 * Thrown when a vector record at a specific index is invalid.
 * Fatal: invalid records cannot be processed.
 */
export const E_INVALID_VECTOR_RECORD = createException<[number, string]>(
  'E_INVALID_VECTOR_RECORD',
  'Invalid vector record at index %d: %s',
  'E_INVALID_VECTOR_RECORD',
  529,
  true
)

/**
 * Thrown when a vector store operation cannot be confirmed with strong consistency within the bound.
 * Fatal: strong mode requires confirmation; timeout indicates a backend consistency issue.
 */
export const E_VECTOR_STORE_CONSISTENCY_TIMEOUT = createException<[string]>(
  'E_VECTOR_STORE_CONSISTENCY_TIMEOUT',
  'Strong consistency could not be confirmed within the bound: %s',
  'E_VECTOR_STORE_CONSISTENCY_TIMEOUT',
  504,
  false
)

/**
 * Thrown when a migration fails.
 * Non-fatal: migration failures are recoverable.
 */
export const E_VECTOR_STORE_MIGRATION_FAILED = createException<[string, string]>(
  'E_VECTOR_STORE_MIGRATION_FAILED',
  'Migration "%s" failed: %s',
  'E_VECTOR_STORE_MIGRATION_FAILED',
  502,
  false
)

/**
 * Thrown when a vector store connection fails.
 * Non-fatal: connection failures are recoverable.
 */
export const E_VECTOR_STORE_CONNECTION_FAILED = createException<[string]>(
  'E_VECTOR_STORE_CONNECTION_FAILED',
  'Vector store connection failed: %s',
  'E_VECTOR_STORE_CONNECTION_FAILED',
  502,
  false
)

/**
 * Thrown when a collection operation fails.
 * Non-fatal: collection operation failures are recoverable.
 */
export const E_VECTOR_STORE_COLLECTION_FAILED = createException<[string, string]>(
  'E_VECTOR_STORE_COLLECTION_FAILED',
  'Collection operation "%s" failed: %s',
  'E_VECTOR_STORE_COLLECTION_FAILED',
  502,
  false
)

/**
 * Thrown when a vector upsert fails.
 * Non-fatal: upsert failures are recoverable.
 */
export const E_VECTOR_STORE_UPSERT_FAILED = createException<[string]>(
  'E_VECTOR_STORE_UPSERT_FAILED',
  'Vector upsert failed: %s',
  'E_VECTOR_STORE_UPSERT_FAILED',
  502,
  false
)

/**
 * Thrown when a vector search fails.
 * Non-fatal: search failures are recoverable.
 */
export const E_VECTOR_STORE_SEARCH_FAILED = createException<[string]>(
  'E_VECTOR_STORE_SEARCH_FAILED',
  'Vector search failed: %s',
  'E_VECTOR_STORE_SEARCH_FAILED',
  502,
  false
)

/**
 * Thrown when a vector delete fails.
 * Non-fatal: delete failures are recoverable.
 */
export const E_VECTOR_STORE_DELETE_FAILED = createException<[string]>(
  'E_VECTOR_STORE_DELETE_FAILED',
  'Vector delete failed: %s',
  'E_VECTOR_STORE_DELETE_FAILED',
  502,
  false
)
