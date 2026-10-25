import type { AppRepository, AppSnapshot } from '../db/types';
import { createSerialQueue } from '../db/sql';
import type { CredentialStorage } from '../secure-types';

export const DATA_RESET_JOURNAL = '@lingban/data-reset-pending/v1';
type ResetJournal = { version: 1; revision: string; aliases: string[]; files: string[] };
type ResetDependencies = {
  repository: Pick<AppRepository, 'initialize' | 'resetData' | 'hasDataReset'>;
  journal: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void>; removeItem(key: string): Promise<void> };
  credentials: Pick<CredentialStorage, 'remove'>;
  beforeReset: () => Promise<void>;
  cleanupLegacy: () => Promise<void>;
  collectFiles: () => Promise<string[]>;
  cleanupFiles: (files: string[]) => Promise<void>;
  revision: () => string;
};

export class DataResetError extends Error {
  readonly snapshot?: AppSnapshot;
  constructor(readonly committed: boolean, readonly didReset = false, snapshot?: AppSnapshot) {
    super(committed ? '本地数据已清空，部分密钥或缓存尚未清理。请重试清理。' : '清空未完成，请重试。');
    this.name = 'DataResetError';
    // Safe UI recovery can use the committed snapshot; error serialization never includes private data.
    Object.defineProperty(this, 'snapshot', { value: snapshot, enumerable: false });
  }
}

function readJournal(raw: string): ResetJournal {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 ||
        !('revision' in value) || typeof value.revision !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(value.revision) ||
        !('aliases' in value) || !Array.isArray(value.aliases) || value.aliases.length > 10000 ||
        value.aliases.some((alias) => typeof alias !== 'string' || !/^model_[A-Za-z0-9._-]+$/.test(alias)) ||
        !('files' in value) || !Array.isArray(value.files) || value.files.length > 20000 ||
        value.files.some((uri) => typeof uri !== 'string' || !uri || uri.length > 4096)) throw new Error();
    return value as ResetJournal;
  } catch { throw new Error('数据清理记录异常，请重试。已有内容尚未覆盖。'); }
}

/** The journal contains only key aliases. A committed DB revision makes cleanup resumable without wiping again. */
export function createDataResetService(deps: ResetDependencies) {
  const enqueue = createSerialQueue();
  async function recover(): Promise<AppSnapshot | null> {
    const raw = await deps.journal.getItem(DATA_RESET_JOURNAL);
    if (raw === null) return null;
    const pending = readJournal(raw);
    if (!await deps.repository.hasDataReset(pending.revision)) {
      await deps.journal.removeItem(DATA_RESET_JOURNAL);
      return null;
    }
    try {
      for (const alias of pending.aliases) await deps.credentials.remove(alias);
      await deps.cleanupLegacy();
      await deps.cleanupFiles(pending.files);
      const snapshot = await deps.repository.initialize();
      await deps.journal.removeItem(DATA_RESET_JOURNAL);
      return snapshot;
    } catch { throw new DataResetError(true); }
  }
  return {
    recover: () => enqueue(async () => !!await recover()),
    reset: () => enqueue(async (): Promise<{ snapshot: AppSnapshot; didReset: boolean }> => {
      let committed = false;
      let cleared: AppSnapshot | undefined;
      try {
        // A retry after a committed wipe only completes its cleanup, preserving any newer edits.
        const recovered = await recover();
        if (recovered) return { snapshot: recovered, didReset: false };
        await deps.beforeReset();
        const snapshot = await deps.repository.initialize();
        const aliases = [...new Set(snapshot.models.flatMap((model) => [model.apiKeyAlias, `model_${model.id}`]))]
          .filter((alias): alias is string => alias !== null);
        if (aliases.some((alias) => !/^model_[A-Za-z0-9._-]+$/.test(alias))) throw new DataResetError(false);
        const pending: ResetJournal = { version: 1, revision: deps.revision(), aliases, files: await deps.collectFiles() };
        readJournal(JSON.stringify(pending));
        await deps.journal.setItem(DATA_RESET_JOURNAL, JSON.stringify(pending));
        try { cleared = await deps.repository.resetData(pending.revision); committed = true; }
        catch {
          // If deleting this non-secret record also fails, startup sees the uncommitted revision and drops it.
          try { await deps.journal.removeItem(DATA_RESET_JOURNAL); } catch { /* original keys remain intact */ }
          throw new DataResetError(false);
        }
        await recover();
        return { snapshot: cleared, didReset: true };
      } catch (error) {
        if (committed) throw new DataResetError(true, true, cleared);
        if (error instanceof DataResetError) throw error;
        throw new DataResetError(false);
      }
    }),
  };
}
