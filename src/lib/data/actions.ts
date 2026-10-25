import { applyAppSnapshot, runAppMaintenance } from '../../stores/app-stores';
import { withChatMaintenance } from '../chat/engine';
import { repository } from '../db/repository';
import { exportAllChats } from './export-chats';
import { DataResetError } from './reset-core';
import { localDataReset } from './reset-service';

export async function exportAllLocalChats(): Promise<void> {
  const snapshot = await withChatMaintenance(() => runAppMaintenance(() => repository.initialize()));
  // The immutable exported snapshot no longer needs to hold the editor lock during sharing.
  await exportAllChats(snapshot);
}

export async function resetAllLocalData(): Promise<boolean> {
  let cleanupError: DataResetError | null = null;
  let didReset = false;
  await withChatMaintenance(() => runAppMaintenance(async () => {
    try {
      const result = await localDataReset.reset();
      didReset = result.didReset;
      if (didReset) applyAppSnapshot(result.snapshot);
    }
    catch (error) {
      if (!(error instanceof DataResetError) || !error.committed) throw error;
      didReset = error.didReset;
      if (didReset && error.snapshot) applyAppSnapshot(error.snapshot);
      cleanupError = error;
    }
  }), { stop: true, discardUnsaved: () => didReset });
  if (cleanupError) throw cleanupError;
  return didReset;
}
