import { modelWithDefault, modelsAfterDelete, modelsAfterSave } from '../../lib/db/model-defaults';
import { createSerialQueue } from '../../lib/db/sql';
import type { AppRepository, ModelRecord } from '../../lib/db/types';
import type { CredentialStorage, ModelKeySummary } from '../../lib/secure-types';
import { copyModelThinkingConfig, getModelThinkingConfig } from '../companion/thinking-config';

const TRANSACTION_KEY = 'lingban_model_pending';
const SAVE_ERROR = '模型配置保存失败，原有配置未覆盖。请重试。';
const KEY_ERROR = 'API Key 操作失败，请重试。';
export const CREDENTIAL_CLEANUP_ERROR = '配置已更新，但安全记录清理失败。请重试清理。';

type PendingCredential = {
  alias: string; previousKey: string | null; modelId: string;
  operation: 'save' | 'delete'; revision: string;
};
export type ModelConfigurationResult = { models: ModelRecord[]; cleanupPending: boolean };
type ModelRepository = Pick<AppRepository, 'initialize' | 'saveModel' | 'deleteModel'>;

export function modelKeyAlias(id: string) {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('模型标识无效，请重新创建模型。');
  return `model_${id}`;
}

function keyAliasValid(alias: string) {
  if (!/^model_[A-Za-z0-9._-]+$/.test(alias)) throw new Error('API Key 标识无效，请重新配置。');
}

function record(input: ModelRecord): ModelRecord {
  // Whitelist every field: an accidentally spread password can never reach a DAO or Zustand.
  return {
    id: input.id, name: input.name, provider: input.provider, baseUrl: input.baseUrl,
    apiModel: input.apiModel, apiKeyAlias: input.apiKeyAlias, isDefault: input.isDefault,
    cotMode: input.cotMode, cotPresetId: input.cotPresetId,
    createdAt: input.createdAt, updatedAt: input.updatedAt,
    thinkingConfig: copyModelThinkingConfig(getModelThinkingConfig(input)),
  };
}

function endpoint(value: string) { return value.trim().replace(/\/+$/, ''); }

/** Secure storage is compensated around a single atomic model DAO write. */
export function createModelConfigurationService(repository: ModelRepository, storage: CredentialStorage) {
  const enqueue = createSerialQueue();
  const credentials: CredentialStorage = {
    async get(key) { try { return await storage.get(key); } catch { throw new Error(KEY_ERROR); } },
    async set(key, value) { try { await storage.set(key, value); } catch { throw new Error(KEY_ERROR); } },
    async remove(key) { try { await storage.remove(key); } catch { throw new Error(KEY_ERROR); } },
  };

  async function restore(pending: PendingCredential) {
    if (pending.previousKey === null) await credentials.remove(pending.alias);
    else await credentials.set(pending.alias, pending.previousKey);
    await credentials.remove(TRANSACTION_KEY);
  }

  async function recover() {
    const raw = await credentials.get(TRANSACTION_KEY);
    if (raw === null) return;
    let pending: PendingCredential;
    try {
      pending = JSON.parse(raw) as PendingCredential;
      if (!pending || typeof pending.modelId !== 'string' || pending.alias !== modelKeyAlias(pending.modelId)
        || (pending.previousKey !== null && typeof pending.previousKey !== 'string')
        || !['save', 'delete'].includes(pending.operation) || typeof pending.revision !== 'string') throw new Error();
    } catch { throw new Error('安全操作记录异常，请重试或重新配置模型。'); }
    const models = (await repository.initialize()).models;
    const current = models.find((item) => item.id === pending.modelId);
    const committed = pending.operation === 'delete' ? !current : current?.updatedAt === pending.revision;
    if (committed) await credentials.remove(TRANSACTION_KEY);
    else await restore(pending);
  }

  async function cleanup() {
    try { await credentials.remove(TRANSACTION_KEY); return false; }
    catch { return true; }
  }

  async function compensate(pending: PendingCredential, message: string): Promise<never> {
    try { await restore(pending); }
    catch { throw new Error('本次操作未完成，API Key 恢复尚未完成。请重试后再使用模型。'); }
    throw new Error(message);
  }

  return {
    recover: () => enqueue(async () => {
      try { await recover(); } catch { throw new Error('安全操作恢复失败，请重试。'); }
    }),

    save: (input: ModelRecord, newApiKey?: string,
      commit?: (persisted: ModelRecord) => Promise<void>): Promise<ModelConfigurationResult> => enqueue(async () => {
      await recover();
      const models = (await repository.initialize()).models;
      const existing = models.find((item) => item.id === input.id);
      const alias = modelKeyAlias(input.id);
      if (existing?.apiKeyAlias && existing.apiKeyAlias !== alias) throw new Error('API Key 标识异常，请重新配置模型。');
      const previousKey = await credentials.get(alias);
      const configuredKey = existing?.apiKeyAlias ? previousKey : null;
      const changedTarget = existing && (existing.provider !== input.provider || endpoint(existing.baseUrl) !== endpoint(input.baseUrl));
      if (newApiKey === undefined && previousKey !== null && changedTarget) {
        throw new Error('服务商或接口地址已改变，请重新输入 API Key，或为自定义端点明确选择不使用密钥。');
      }
      if (newApiKey !== undefined && newApiKey !== '' && !newApiKey.trim()) throw new Error('API Key 不能为空白字符。');
      const nextKey = newApiKey === undefined ? configuredKey : newApiKey === '' ? null : newApiKey.trim();
      if (input.provider !== 'custom' && nextKey === null) throw new Error('请填写 API Key。');
      const previousTime = existing ? Date.parse(existing.updatedAt) : 0;
      const revision = new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString();
      const persisted = modelWithDefault(models, record({ ...input, apiKeyAlias: nextKey === null ? null : alias,
        createdAt: existing?.createdAt ?? input.createdAt, updatedAt: revision }));
      const changedKey = nextKey !== previousKey;
      const pending: PendingCredential = { alias, previousKey, modelId: input.id, operation: 'save', revision };
      if (changedKey) {
        try { await credentials.set(TRANSACTION_KEY, JSON.stringify(pending)); }
        catch { throw new Error(KEY_ERROR); }
        try {
          if (nextKey === null) await credentials.remove(alias);
          else await credentials.set(alias, nextKey);
        } catch { return compensate(pending, KEY_ERROR); }
      }
      // A role can commit its new model and complete configuration in one DB transaction.
      // Recovery still uses the model revision, which is committed with that same transaction.
      try { await (commit ? commit(persisted) : repository.saveModel(persisted)); }
      catch {
        if (changedKey) return compensate(pending, SAVE_ERROR);
        throw new Error(SAVE_ERROR);
      }
      return { models: modelsAfterSave(models, persisted), cleanupPending: changedKey ? await cleanup() : false };
    }),

    delete: (id: string): Promise<ModelConfigurationResult> => enqueue(async () => {
      await recover();
      const models = (await repository.initialize()).models;
      const existing = models.find((item) => item.id === id);
      const alias = modelKeyAlias(id);
      if (existing?.apiKeyAlias && existing.apiKeyAlias !== alias) throw new Error('API Key 标识异常，请重新配置模型。');
      // Also clear a deterministic orphan left by a previously interrupted create.
      const previousKey = await credentials.get(alias);
      const pending: PendingCredential = { alias, previousKey, modelId: id, operation: 'delete', revision: '' };
      if (previousKey !== null) {
        try { await credentials.set(TRANSACTION_KEY, JSON.stringify(pending)); }
        catch { throw new Error('删除模型失败，原有配置未覆盖。请重试。'); }
        try { await credentials.remove(alias); }
        catch { return compensate(pending, 'API Key 删除失败，模型仍保留。请重试删除。'); }
      }
      try { await repository.deleteModel(id); }
      catch {
        if (previousKey !== null) return compensate(pending, '删除模型失败，原有配置未覆盖。请重试。');
        throw new Error('删除模型失败，原有配置未覆盖。请重试。');
      }
      return { models: modelsAfterDelete(models, id), cleanupPending: previousKey !== null ? await cleanup() : false };
    }),

    getApiKey: (alias: string | null): Promise<string | null> => enqueue(async () => {
      if (alias === null) return null;
      keyAliasValid(alias);
      try { await recover(); return await credentials.get(alias); }
      catch { throw new Error('API Key 读取失败，请重试。'); }
    }),

    getKeySummary: (alias: string | null): Promise<ModelKeySummary> => enqueue(async () => {
      if (alias === null) return { configured: false, lastFour: '' };
      keyAliasValid(alias);
      try {
        await recover();
        const key = await credentials.get(alias);
        return { configured: key !== null, lastFour: key === null ? '' : key.slice(-4) };
      } catch { throw new Error('API Key 读取失败，请重试。'); }
    }),
  };
}
