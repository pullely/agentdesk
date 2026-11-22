import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { D1Binding } from "@saas/db/d1";
import { D1ApiAdapter } from "@saas/db/runner";

const splitStatements = D1ApiAdapter.splitStatements;

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

function migrationDirs(): string[] {
  return readdirSync(MIGRATIONS_ROOT)
    .filter((d) => existsSync(join(MIGRATIONS_ROOT, d, "up.sql")))
    .sort();
}

/** A D1 binding backed by an in-memory SQLite database. */
export function d1Over(db: DatabaseSync): D1Binding {
  return {
    prepare(query: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bound = values;
          return statement;
        },
        all<T>() {
          const prepared = db.prepare(query);
          const rows = prepared.all(...(bound as never[])) as T[];
          return Promise.resolve({ results: rows, success: true });
        },
      };
      return statement;
    },
    // D1's batch is one implicit transaction: every statement applies or none
    // does. Mirrored with a real SQLite transaction, so the suite proves the
    // rollback rather than assuming it.
    async batch(statements: Array<{ all(): Promise<unknown> }>) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        db.exec("COMMIT");
        return results;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  } as unknown as D1Binding;
}

export function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const dir of migrationDirs()) {
    const sql = readFileSync(join(MIGRATIONS_ROOT, dir, "up.sql"), "utf8");
    for (const statement of splitStatements(sql)) db.exec(statement);
  }
  return db;
}
