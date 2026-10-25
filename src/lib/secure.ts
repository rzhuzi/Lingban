import * as SecureStore from 'expo-secure-store';

import type { CredentialStorage } from './secure-types';

export const credentialStorageMode = 'device' as const;

const options: SecureStore.SecureStoreOptions = {
  keychainService: 'lingban.models',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** Secrets have one native storage boundary; native error messages never escape it. */
export const credentialStorage: CredentialStorage = {
  async get(key) {
    try { return await SecureStore.getItemAsync(key, options); }
    catch { throw new Error('无法读取安全存储，请重试。'); }
  },
  async set(key, value) {
    try { await SecureStore.setItemAsync(key, value, options); }
    catch { throw new Error('无法保存 API Key，请重试。'); }
  },
  async remove(key) {
    try { await SecureStore.deleteItemAsync(key, options); }
    catch { throw new Error('无法删除 API Key，请重试。'); }
  },
};
