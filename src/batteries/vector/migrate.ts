/**
 * Knex-style migration runner for the vector battery.
 *
 * @module @nhtio/adk/batteries/vector/migrate
 */

import { isError } from '@nhtio/adk/guards'
import { E_VECTOR_STORE_MIGRATION_FAILED } from './exceptions'
import type { VectorSchemaBuilder } from './schema'

/** The context passed to each migration's `up`/`down` — exposes the schema builder. */
export interface VectorMigrationContext {
  /** Schema facade for performing collection DDL within the migration. */
  schema: VectorSchemaBuilder
}

/** A single migration module: a name plus its forward (`up`) and reverse (`down`) steps. */
export interface VectorMigration {
  /** Unique migration name, used as its ledger key. */
  name: string
  /** Apply the migration. */
  up: (ctx: VectorMigrationContext) => Promise<void>
  /** Reverse the migration. */
  down: (ctx: VectorMigrationContext) => Promise<void>
}

/** Persistence for which migrations have run; backed by a store-provided implementation. */
export interface MigrationLedger {
  /** Resolve the names of migrations already applied, in application order. */
  applied(): Promise<string[]>
  /** Record `name` as applied. */
  record(name: string): Promise<void>
  /** Remove `name` from the applied set (on rollback). */
  remove(name: string): Promise<void>
}

/** Construction options for a {@link VectorMigrator}. */
export interface VectorMigrateOptions {
  /** The ordered set of migration modules. */
  migrations: VectorMigration[]
  /** Ledger tracking which migrations have run. */
  ledger: MigrationLedger
  /** Schema facade handed to each migration. */
  schema: VectorSchemaBuilder
}

/** Knex-style migration runner: applies pending migrations forward and rolls the last one back. */
export class VectorMigrator {
  readonly #migrations: VectorMigration[]
  readonly #ledger: MigrationLedger
  readonly #schema: VectorSchemaBuilder

  /**
   * @param opts - The migrations, ledger, and schema facade to run against.
   */
  constructor(opts: VectorMigrateOptions) {
    this.#migrations = opts.migrations
    this.#ledger = opts.ledger
    this.#schema = opts.schema
  }

  /**
   * Apply every not-yet-applied migration in order, recording each in the ledger.
   *
   * @returns The names of the migrations applied during this run.
   * @throws {@link @nhtio/adk/batteries!E_VECTOR_STORE_MIGRATION_FAILED} when a migration's `up` throws.
   */
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

  /**
   * Reverse the most recently applied migration and remove it from the ledger.
   *
   * @returns The name of the rolled-back migration, or `null` when nothing was applied.
   * @throws {@link @nhtio/adk/batteries!E_VECTOR_STORE_MIGRATION_FAILED} when the migration module is missing or
   *   its `down` throws.
   */
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
