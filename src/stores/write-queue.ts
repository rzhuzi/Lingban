type SnapshotWrite = {
  key: string;
  write: () => Promise<void>;
  onSuccess: () => void;
  onFailure: (error: unknown) => void;
  retry: boolean;
};

/** Keeps persistence ordered while replacing an unsaved snapshot with its newest edit. */
export function createWriteQueue() {
  const pending: SnapshotWrite[] = [];
  let draining: Promise<void> | null = null;
  let nextOperation = 0;
  let requestedRevision = 0;

  function flush(): Promise<void> {
    requestedRevision += 1;
    if (draining) return draining;
    let finishedRevision = requestedRevision;
    // Start on a microtask so edits from the same event can coalesce before I/O.
    draining = Promise.resolve().then(async () => {
      while (pending.length) {
        const operation = pending.shift()!;
        try {
          await operation.write();
          operation.onSuccess();
        } catch (error) {
          operation.onFailure(error);
          if (operation.retry) {
            // A newer edit for this channel supersedes the failed snapshot.
            if (!pending.some((item) => item.key === operation.key)) pending.unshift(operation);
            // Imperative callers cannot wait on a retry that only a future edit may trigger.
            // Keep snapshots ordered, but cancel every operation that did not execute.
            const blocked = new Error('本地配置尚未保存，本次操作未执行。请重试保存后再次操作。');
            for (let index = pending.length - 1; index >= 0; index -= 1) {
              if (!pending[index].retry) pending.splice(index, 1)[0].onFailure(blocked);
            }
            break;
          }
        }
      }
      finishedRevision = requestedRevision;
    }).finally(() => {
      draining = null;
      // A caller can enqueue after the loop ends but before this finally runs.
      // Resume only that fresh request; a failed autosave still waits for an explicit retry.
      if (pending.length && requestedRevision !== finishedRevision) void flush();
    });
    return draining;
  }

  return {
    save(key: string, write: () => Promise<void>, callbacks: Pick<SnapshotWrite, 'onSuccess' | 'onFailure'>) {
      const replaced = pending.findIndex((item) => item.key === key);
      if (replaced !== -1) pending.splice(replaced, 1);
      // Reappend, rather than replace in place: another channel may share a field.
      pending.push({ key, write, ...callbacks, retry: true });
      void flush();
    },
    run<T>(write: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        nextOperation += 1;
        pending.push({
          key: `operation:${nextOperation}`, retry: false,
          write: async () => { resolve(await write()); },
          onSuccess: () => {}, onFailure: reject,
        });
        void flush();
      });
    },
    flush,
  };
}
