export type SqlValue = string | number | null;

/** The synchronous subset shared by Expo SQLite and the real SQLite test adapter. */
export interface SqlDatabase {
  execSync(sql: string): void;
  runSync(sql: string, params?: SqlValue[]): unknown;
  getAllSync<T>(sql: string, params?: SqlValue[]): T[];
  getFirstSync<T>(sql: string, params?: SqlValue[]): T | null;
}

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export function transaction<T>(db: SqlDatabase, work: () => T): T {
  // No await inside a transaction: another queued operation cannot join it accidentally.
  db.execSync('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.execSync('COMMIT');
    return result;
  } catch (error) {
    db.execSync('ROLLBACK');
    throw error;
  }
}

export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T> | T): Promise<T> => {
    const result = tail.then(work);
    tail = result.catch(() => undefined);
    return result;
  };
}
