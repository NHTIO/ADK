/**
 * Knex-style migration runner for the vector battery.
 *
 * @module @nhtio/adk/batteries/vector/migrate
 */

import { isError } from '@nhtio/adk/guards'
import { E_VECTOR_STORE_MIGRATION_FAILED } from './exceptions'
import type { VectorSchemaBuilder } from './schema'

// The context passed to each migration's up/down.
export interface VectorMigrationContext {
  schema: VectorSchemaBuilder
}

// A migration module shape.
export interface VectorMigration {
  name: string
  up: (ctx: VectorMigrationContext) => Promise<void>
  down: (ctx: VectorMigrationContext) => Promise<void>
}

// The ledger persists which migrations have run. Backed by a MigrationLedger the store provides.
export interface MigrationLedger {
  applied(): Promise<string[]>
  record(name: string): Promise<void>
  remove(name: string): Promise<void>
}

export interface VectorMigrateOptions {
  migrations: VectorMigration[]
  ledger: MigrationLedger
  schema: VectorSchemaBuilder
}

export class VectorMigrator {
  readonly #migrations: VectorMigration[]
  readonly #ledger: MigrationLedger
  readonly #schema: VectorSchemaBuilder

  constructor(opts: VectorMigrateOptions) {
    this.#migrations = opts.migrations
    this.#ledger = opts.ledger
    this.#schema = opts.schema
  }

  async latest(): Promise<string[]> {
    const applied = await this.#ledger.applied()
    const toApply = this.#migrations.filter((m) => !applied.includes(m.name))

    const appliedThisRun: string[] = []

    for (const migration of toApply) {
      try {
        await migration.up({ schema: this.#schema })
        await this.#ledger.record(migration.name)
        appliedThisRun.push(migration.name)
      } catch (err) {
        const msg = (value: unknown): string => (isError(value) ? value.message : String(value))
        throw new E_VECTOR_STORE_MIGRATION_FAILED([migration.name, msg(err)])
      }
    }

    return appliedThisRun
  }

  async rollback(): Promise<string | null> {
    const applied = await this.#ledger.applied()

    if (applied.length === 0) {
      return null
    }

    const lastApplied = applied[applied.length - 1]
    const migration = this.#migrations.find((m) => m.name === lastApplied)

    if (!migration) {
      throw new E_VECTOR_STORE_MIGRATION_FAILED([lastApplied, 'migration module not found'])
    }

    try {
      await migration.down({ schema: this.#schema })
      await this.#ledger.remove(lastApplied)
      return lastApplied
    } catch (err) {
      const msg = (value: unknown): string => (isError(value) ? value.message : String(value))
      throw new E_VECTOR_STORE_MIGRATION_FAILED([lastApplied, msg(err)])
    }
  }
}
