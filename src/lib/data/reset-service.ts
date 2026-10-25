import AsyncStorage from '@react-native-async-storage/async-storage';

import { createId } from '../../features/companion/defaults';
import { modelCredentials } from '../../features/models/model-credentials';
import { LEGACY_STORAGE_KEY } from '../db/legacy';
import { repository } from '../db/repository';
import { credentialStorage } from '../secure';
import { cleanupAppFiles, collectAppFiles } from './reset-cleanup';
import { createDataResetService } from './reset-core';

export const localDataReset = createDataResetService({
  repository, journal: AsyncStorage, credentials: credentialStorage,
  beforeReset: () => modelCredentials.recover(),
  cleanupLegacy: async () => {
    const keys = (await AsyncStorage.getAllKeys()).filter((key) => key === LEGACY_STORAGE_KEY || key.startsWith(`${LEGACY_STORAGE_KEY}/recovery/`));
    if (keys.length) await AsyncStorage.multiRemove(keys);
  },
  collectFiles: collectAppFiles, cleanupFiles: cleanupAppFiles, revision: createId,
});
