import AsyncStorage from '@react-native-async-storage/async-storage';
import { openDatabaseSync } from 'expo-sqlite';

import { createSqlRepository } from './sql-repository';
import type { SqlDatabase } from './sql';
import type { AppRepository } from './types';

export const repository: AppRepository = createSqlRepository(() => {
  // Open lazily so launch errors are caught by the startup gate and can be retried.
  const db = openDatabaseSync('lingban.db');
  const adapter: SqlDatabase = {
    execSync: (sql) => db.execSync(sql),
    runSync: (sql, params = []) => db.runSync(sql, params),
    getAllSync: <T,>(sql: string, params = []) => db.getAllSync<T>(sql, params),
    getFirstSync: <T,>(sql: string, params = []) => db.getFirstSync<T>(sql, params),
  };
  return adapter;
}, AsyncStorage);
