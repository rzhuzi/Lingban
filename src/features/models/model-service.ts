import type { ModelRecord } from '@/lib/db/types';
import { useModelStore } from '@/stores/app-stores';

import { modelCredentials } from './model-credentials';

export { credentialStorageMode } from '@/lib/secure';
export { modelKeyAlias } from './model-configuration';

/** Resolves only after the ordered write and public store update have completed. */
export const saveModelConfiguration = (model: ModelRecord, newApiKey?: string, thinkingBaseline?: Pick<ModelRecord, 'cotMode' | 'thinkingConfig'>) =>
  useModelStore.getState().saveModelConfiguration(model, newApiKey, thinkingBaseline);
export const deleteModelConfiguration = (id: string) => useModelStore.getState().deleteModelConfiguration(id);
export const retryCredentialCleanup = () => useModelStore.getState().retryCredentialCleanup();
export const getModelApiKey = (alias: string | null) => modelCredentials.getApiKey(alias);
export const getModelKeySummary = (alias: string | null) => modelCredentials.getKeySummary(alias);
