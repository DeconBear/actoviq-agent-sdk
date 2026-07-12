import { StorageUnavailableError } from './errors.js';

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...parameters: readonly unknown[]): SqliteRunResult;
  get(...parameters: readonly unknown[]): Record<string, unknown> | undefined;
  all(...parameters: readonly unknown[]): Record<string, unknown>[];
}

/**
 * Small synchronous surface intentionally kept separate from node:sqlite.
 * Alternate runtimes can provide their own adapter without changing contracts.
 */
export interface SqliteDriver {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T>(operation: () => T): T;
  close(): void;
}

export interface SqliteDriverFactory {
  open(filename: string): Promise<SqliteDriver>;
}

interface NodeDatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): NodeStatementSync;
  close(): void;
}

interface NodeStatementSync {
  run(...parameters: readonly unknown[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
  get(...parameters: readonly unknown[]): unknown;
  all(...parameters: readonly unknown[]): unknown[];
}

interface NodeSqliteModule {
  DatabaseSync: new (filename: string) => NodeDatabaseSync;
}

class NodeSqliteStatement implements SqliteStatement {
  constructor(private readonly statement: NodeStatementSync) {}

  run(...parameters: readonly unknown[]): SqliteRunResult {
    const result = this.statement.run(...parameters);
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  get(...parameters: readonly unknown[]): Record<string, unknown> | undefined {
    const row = this.statement.get(...parameters);
    return asRow(row);
  }

  all(...parameters: readonly unknown[]): Record<string, unknown>[] {
    return this.statement.all(...parameters).map((row) => {
      const normalized = asRow(row);
      if (!normalized) {
        throw new StorageUnavailableError('SQLite returned a non-object result row');
      }
      return normalized;
    });
  }
}

class NodeSqliteDriver implements SqliteDriver {
  constructor(private readonly database: NodeDatabaseSync) {}

  exec(sql: string): void {
    this.database.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    return new NodeSqliteStatement(this.database.prepare(sql));
  }

  transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the original operation failure.
      }
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }
}

export const nodeSqliteDriverFactory: SqliteDriverFactory = {
  async open(filename: string): Promise<SqliteDriver> {
    // Keep node:sqlite out of the module initialization path. Consumers on an
    // older Node can still import storage contracts or inject another driver.
    const moduleName = 'node:sqlite';
    let sqlite: NodeSqliteModule;
    try {
      sqlite = await import(moduleName) as unknown as NodeSqliteModule;
    } catch (error) {
      throw new StorageUnavailableError(
        'The built-in node:sqlite module is unavailable; use Node 22.13+ or inject a SqliteDriverFactory',
        { cause: error },
      );
    }

    try {
      return new NodeSqliteDriver(new sqlite.DatabaseSync(filename));
    } catch (error) {
      throw new StorageUnavailableError(`Could not open SQLite database at ${filename}`, {
        cause: error,
      });
    }
  },
};

function asRow(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StorageUnavailableError('SQLite returned a non-object result row');
  }
  return value as Record<string, unknown>;
}
