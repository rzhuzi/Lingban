import type { CredentialStorage } from './secure-types';

export const credentialStorageMode = 'session' as const;
const credentials = new Map<string, string>();

/** Browser previews keep keys in this page's memory; no local/session storage fallback. */
export const credentialStorage: CredentialStorage = {
  async get(key) { return credentials.get(key) ?? null; },
  async set(key, value) { credentials.set(key, value); },
  async remove(key) { credentials.delete(key); },
};
