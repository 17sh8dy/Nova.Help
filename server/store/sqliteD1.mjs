/**
 * A D1-shaped driver over node:sqlite, for running and testing the Cloudflare adapters here.
 *
 * WHY THIS EXISTS. The D1 stores are the code that will run in production, so they must be
 * exercised against a real SQL engine long before anything is deployed — not against a mock
 * that agrees with whatever the adapter happens to do. Node 22.5+ ships SQLite in the runtime
 * as `node:sqlite`, which is the same engine D1 is built on, so the adapters can be driven
 * from `node --test` with no dependency added and no network involved.
 *
 * WHAT IT IS NOT. It is not D1. It does not replicate, it has no bookmarks, no row-read
 * accounting and no request boundary, and a query that is slow here may be refused there. It
 * reproduces the parts the adapters actually depend on:
 *
 *   - `prepare().bind().first()/.all()/.run()` with D1's return shape, including
 *     `meta.changes`, which is what every optimistic-concurrency check reads.
 *   - `batch()` as one transaction: the whole list commits or none of it does.
 *   - `exec()` for multi-statement DDL.
 *
 * THE ONE BEHAVIOUR TO KEEP IN MIND. `batch()` rolls back on a statement ERROR, not on a
 * statement that simply matched no rows. A conditional `UPDATE ... WHERE version = ?` that
 * matches nothing is a successful statement reporting `changes: 0`, and anything batched
 * alongside it still commits. Both this driver and D1 behave that way, and the ticket store
 * depends on knowing it.
 */
import { DatabaseSync } from 'node:sqlite';

/** D1 reports its own error strings; these are SQLite's, which is what D1 surfaces too. */
const wrap = (error, sql) => {
  const message = error?.message ?? String(error);
  const wrapped = new Error(`D1_ERROR: ${message}`);
  wrapped.cause = error;
  wrapped.sql = sql;
  return wrapped;
};

/** D1 returns booleans as 0/1 and has no BigInt in results; normalise what node:sqlite hands back. */
const normalizeRow = (row) => {
  if (!row) return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  return out;
};

/**
 * `undefined` is not a bindable value in either engine, and `true`/`false` are not SQLite
 * types. Converting here rather than at forty call sites keeps the adapters readable.
 */
const bindable = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value;
};

const meta = (changes = 0, lastRowId = 0, duration = 0) => ({
  changes,
  last_row_id: lastRowId,
  duration,
  rows_read: 0,
  rows_written: changes,
  served_by: 'node-sqlite',
});

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values) {
    return new Statement(this.db, this.sql, values.map(bindable));
  }

  /** The prepared node:sqlite statement, compiled once per SQL string and cached. */
  compiled() {
    let stmt = this.db.cache.get(this.sql);
    if (!stmt) {
      try {
        stmt = this.db.raw.prepare(this.sql);
      } catch (error) {
        throw wrap(error, this.sql);
      }
      this.db.cache.set(this.sql, stmt);
    }
    return stmt;
  }

  /** D1: the first row, or null. With a column name, that column's value or null. */
  async first(column) {
    const started = Date.now();
    let row;
    try {
      row = this.compiled().get(...this.params);
    } catch (error) {
      throw wrap(error, this.sql);
    }
    void started;
    if (row === undefined) return null;
    const normalized = normalizeRow(row);
    return column === undefined ? normalized : (normalized[column] ?? null);
  }

  async all() {
    const started = Date.now();
    try {
      const rows = this.compiled().all(...this.params).map(normalizeRow);
      return { success: true, results: rows, meta: meta(0, 0, Date.now() - started) };
    } catch (error) {
      throw wrap(error, this.sql);
    }
  }

  async run() {
    const started = Date.now();
    try {
      const result = this.compiled().run(...this.params);
      return {
        success: true,
        results: [],
        meta: meta(Number(result.changes), Number(result.lastInsertRowid), Date.now() - started),
      };
    } catch (error) {
      throw wrap(error, this.sql);
    }
  }

  /** Synchronous execution, used only by `batch` so a transaction never awaits mid-flight. */
  runSync() {
    const result = this.compiled().run(...this.params);
    return {
      success: true,
      results: [],
      meta: meta(Number(result.changes), Number(result.lastInsertRowid)),
    };
  }

  allSync() {
    return { success: true, results: this.compiled().all(...this.params).map(normalizeRow), meta: meta() };
  }
}

/** True for a statement D1 would treat as read-only, so `batch` returns rows for it. */
const isRead = (sql) => /^\s*(SELECT|WITH|EXPLAIN|PRAGMA)\b/i.test(sql);

export function createSqliteD1({ path = ':memory:' } = {}) {
  const raw = new DatabaseSync(path);
  /* Foreign keys are OFF by default in SQLite and ON in D1. Matching D1 here is the point:
     a cascade that works in production must work in the tests. */
  raw.exec('PRAGMA foreign_keys = ON');
  const db = { raw, cache: new Map() };

  return {
    prepare(sql) {
      return new Statement(db, sql);
    },

    /**
     * Run every statement in one transaction, in order. Rolls back on error.
     *
     * D1 guarantees the statements execute sequentially and non-concurrently and that a
     * failure aborts the sequence; that is exactly SQLite's own transaction, so this is a
     * literal BEGIN/COMMIT rather than an approximation.
     */
    async batch(statements) {
      const started = Date.now();
      raw.exec('BEGIN');
      try {
        const out = statements.map((statement) =>
          isRead(statement.sql) ? statement.allSync() : statement.runSync(),
        );
        raw.exec('COMMIT');
        return out.map((result) => ({ ...result, meta: { ...result.meta, duration: Date.now() - started } }));
      } catch (error) {
        try {
          raw.exec('ROLLBACK');
        } catch {
          // A rollback that fails leaves the original error the more useful one to report.
        }
        throw wrap(error, statements.map((s) => s.sql).join('; '));
      }
    },

    /** Multi-statement DDL. D1 accepts this for migrations; so does node:sqlite. */
    async exec(sql) {
      try {
        raw.exec(sql);
        return { count: sql.split(';').filter((s) => s.trim()).length, duration: 0 };
      } catch (error) {
        throw wrap(error, sql);
      }
    },

    /** Not part of the D1 interface — only the local driver has a file handle to release. */
    close() {
      db.cache.clear();
      raw.close();
    },
  };
}
