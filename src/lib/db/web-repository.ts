import { normalizeCompanion } from '../../features/companion/normalize';
import { createDefaultData } from '../../features/companion/defaults';
import { isCotAudit } from '../cot/types';
import { assertModelThinkingConfig, assertThinkingTemplateBindings, copyModelThinkingConfig, createModelThinkingConfig, legacyModelThinkingConfig, reconcileThinkingTemplates } from '../../features/companion/thinking-config';
import { renameCompanionThinkingVariable, renameModelThinkingVariable } from '../../features/companion/thinking-variables';
import { assertRoleBaseline, createRoleConfiguration, validateRoleForSave } from '../../features/companion/role-config';

import { readLegacyCompanion } from './legacy';
import { modelWithDefault, modelsAfterDelete, modelsAfterSave } from './model-defaults';
import { withAuditRecoveryNotice } from './recovery';
import { legacyModeDisabled, THINKING_MIGRATION_NOTICE } from './thinking-migration';
import { assertMessageTransition } from './message-transition';
import { createSerialQueue } from './sql';
import type { KeyValueStorage } from './sql';
import { assertAppSettings, assertPersonaRecord, assertResetRevision, DEFAULT_SETTINGS } from './types';
import type { AppRepository, AppSnapshot, PersonaRecord } from './types';

export const WEB_STORAGE_KEY = '@lingban/app/web/v1';
type WebDocument = { schemaVersion: 3; snapshot: AppSnapshot; resetRevision?: string };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: Record<string, unknown>, keys: string[]) => keys.every((key) => typeof value[key] === 'string');
const nullableStrings = (value: Record<string, unknown>, keys: string[]) =>
  keys.every((key) => value[key] === null || typeof value[key] === 'string');
const modeValid = (value: unknown) => typeof value === 'string' && ['off', 'official', 'instruction', 'persona'].includes(value);
const legacyModeValid = (value: unknown) => typeof value === 'string' && ['off', 'native', 'prefill', 'persona'].includes(value);
const sameJson = (left: unknown, right: unknown) => {
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
    : isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])])) : value;
  return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
};

function modelValid(value: unknown) {
  return isRecord(value) && strings(value, ['id', 'name', 'baseUrl', 'apiModel', 'createdAt', 'updatedAt'])
    && nullableStrings(value, ['apiKeyAlias', 'cotPresetId']) && typeof value.isDefault === 'boolean'
    && typeof value.provider === 'string' && ['deepseek', 'moonshot', 'dashscope', 'zhipu', 'custom'].includes(value.provider)
    && modeValid(value.cotMode);
}

function sessionValid(value: unknown) {
  return isRecord(value) && strings(value, ['id', 'title', 'createdAt', 'updatedAt'])
    && nullableStrings(value, ['modelId', 'personaId']) && typeof value.pinned === 'boolean';
}

function messageValid(value: unknown) {
  return isRecord(value) && strings(value, ['id', 'sessionId', 'content', 'reasoning', 'createdAt'])
    && nullableStrings(value, ['error', 'cotPresetId', 'modelId']) && legacyModeValid(value.cotMode)
    && (value.thinkingMode == null || modeValid(value.thinkingMode))
    && (value.cotAudit == null || isCotAudit(value.cotAudit))
    && typeof value.role === 'string' && ['system', 'user', 'assistant'].includes(value.role)
    && typeof value.status === 'string' && ['pending', 'streaming', 'done', 'aborted', 'error'].includes(value.status);
}

function parseDocument(raw: string): { document: WebDocument; needsPersist: boolean } {
  const value: unknown = JSON.parse(raw);
  if (isRecord(value) && typeof value.schemaVersion === 'number' && value.schemaVersion > 3) {
    throw new Error('网页本地数据库来自较新版本，请更新应用后重试。已有数据尚未覆盖。');
  }
  if (!isRecord(value) || typeof value.schemaVersion !== 'number' || ![1, 2, 3].includes(value.schemaVersion) || !isRecord(value.snapshot)) {
    throw new Error('网页本地数据格式异常，已有内容尚未覆盖。');
  }
  const snapshot = value.snapshot;
  const settings = snapshot.settings;
  if (!isRecord(settings) || !['system', 'light', 'dark'].includes(String(settings.theme))
    || typeof settings.userName !== 'string' || typeof settings.contextWindow !== 'number'
    || !Number.isFinite(settings.contextWindow) || settings.contextWindow < 1
    || typeof settings.streamOutput !== 'boolean'
    || !Array.isArray(snapshot.models) || !Array.isArray(snapshot.sessions) || !Array.isArray(snapshot.messages)
    || (snapshot.notice !== null && typeof snapshot.notice !== 'string')) {
    throw new Error('网页本地数据格式异常，已有内容尚未覆盖。');
  }
  assertAppSettings(settings as AppSnapshot['settings']);
  const normalized = normalizeCompanion(snapshot.companion);
  if (normalized.recovered) throw new Error('网页本地配置格式异常，已有内容尚未覆盖。');
  const migrated = value.schemaVersion !== 3;
  let recoveredAudit = false;
  const models = snapshot.models.map((model: unknown) => {
    if (value.schemaVersion !== 1) return model;
    if (!isRecord(model) || !legacyModeValid(model.cotMode) || !modelValid({ ...model, cotMode: 'off' })) {
      throw new Error('网页本地记录格式异常，已有内容尚未覆盖。');
    }
    return { ...model, cotMode: model.cotMode === 'persona' ? 'persona' : 'off',
      thinkingConfig: legacyModelThinkingConfig(String(model.cotMode), model.cotPresetId as string | null, normalized.data.thinking) };
  });
  const migrationNotice = snapshot.migrationNotice;
  if (migrationNotice != null && (!isRecord(migrationNotice) || migrationNotice.id !== 'thinking-v2'
    || typeof migrationNotice.message !== 'string')) throw new Error('网页迁移通知格式异常。');
  if (value.schemaVersion === 1 && (legacyModeDisabled(normalized.data.thinking.legacyMode)
    || snapshot.models.some((model) => isRecord(model) && legacyModeDisabled(model.cotMode)))) snapshot.migrationNotice = THINKING_MIGRATION_NOTICE;
  else snapshot.migrationNotice ??= null;
  for (const model of models) {
    if (!modelValid(model) || !isRecord(model)) throw new Error('网页本地记录格式异常，已有内容尚未覆盖。');
    assertModelThinkingConfig(model.thinkingConfig);
  }
  snapshot.models = models;
  snapshot.companion = normalized.data;
  const messages = snapshot.messages.map((message: unknown) => {
    if (!isRecord(message)) return message;
    const canonical: Record<string, unknown> = { ...message, thinkingMode: message.thinkingMode ?? null };
    if (message.cotAudit == null || isCotAudit(message.cotAudit)) return canonical;
    const { cotAudit: ignoredAudit, ...retained } = canonical;
    void ignoredAudit;
    recoveredAudit = true;
    return retained;
  });
  // This version writes these complete records as one document; never replace a damaged document with defaults.
  if (!models.every(modelValid) || !snapshot.sessions.every(sessionValid) || !messages.every(messageValid)) {
    throw new Error('网页本地记录格式异常，已有内容尚未覆盖。');
  }
  snapshot.messages = messages;
  if (snapshot.personas === undefined) {
    snapshot.personas = [{ id: 'persona-default', profile: normalized.data.profile, memories: normalized.data.memories,
      interests: normalized.data.interests, isActive: true }];
  }
  if (!Array.isArray(snapshot.personas) || !snapshot.personas.length) throw new Error('网页人设记录异常，已有内容尚未覆盖。');
  const personas = snapshot.personas as PersonaRecord[];
  for (const persona of personas) {
    if (persona.configuration === undefined) {
      if (!migrated) throw new Error('网页角色配置缺失，已有内容尚未覆盖。');
      persona.configuration = createRoleConfiguration(settings as AppSnapshot['settings'], normalized.data.thinking.variables);
    }
  }
  personas.forEach(assertPersonaRecord);
  if (new Set(personas.map((persona) => persona.id)).size !== personas.length || personas.filter((persona) => persona.isActive).length !== 1) {
    throw new Error('网页活动人设记录异常，已有内容尚未覆盖。');
  }
  const memoryIds = personas.flatMap((persona) => persona.memories.map((memory) => memory.id));
  if (new Set(memoryIds).size !== memoryIds.length) throw new Error('记忆标识与其他人设冲突，已有内容尚未覆盖。');
  const active = personas.find((persona) => persona.isActive)!;
  if (!sameJson(active.profile, normalized.data.profile) || !sameJson(active.memories, normalized.data.memories)
    || !sameJson(active.interests, normalized.data.interests)) throw new Error('网页人设数据不一致，已有内容尚未覆盖。');
  if (value.resetRevision !== undefined) assertResetRevision(value.resetRevision as string);
  if (recoveredAudit) snapshot.notice = withAuditRecoveryNotice(snapshot.notice as string | null);
  value.schemaVersion = 3;
  return { document: value as unknown as WebDocument, needsPersist: recoveredAudit || migrated };
}

function syncCompanion(snapshot: AppSnapshot) {
  const active = snapshot.personas.find((persona) => persona.isActive);
  if (!active) throw new Error('活动人设已不存在。');
  snapshot.companion = { ...snapshot.companion, profile: clone(active.profile), memories: clone(active.memories), interests: clone(active.interests) };
}

function assertMemoryOwners(snapshot: AppSnapshot, persona: PersonaRecord) {
  const otherIds = new Set(snapshot.personas.filter((item) => item.id !== persona.id).flatMap((item) => item.memories.map((memory) => memory.id)));
  if (persona.memories.some((memory) => otherIds.has(memory.id))) throw new Error('记忆标识与其他人设冲突，已有内容尚未覆盖。');
}

function initialSnapshot(companion = createDefaultData(), notice: string | null = null): AppSnapshot {
  const settings = { ...DEFAULT_SETTINGS, userName: companion.thinking.variables.find((item) => item.name === 'user_name')?.value ?? DEFAULT_SETTINGS.userName };
  assertAppSettings(settings);
  return { companion, settings, personas: [{ id: 'persona-default', profile: clone(companion.profile), memories: clone(companion.memories),
    interests: clone(companion.interests), isActive: true, configuration: createRoleConfiguration(settings, companion.thinking.variables) }], models: [], sessions: [], messages: [], notice, migrationNotice: null };
}

/** Browser preview fallback: no SQLite wasm or cross-origin isolation setup is required. */
export function createWebRepository(storage: KeyValueStorage): AppRepository {
  const enqueue = createSerialQueue();
  let document: WebDocument | null = null;

  async function prepare(): Promise<WebDocument> {
    if (document) return document;
    const raw = await storage.getItem(WEB_STORAGE_KEY);
    if (raw !== null) {
      const { document: next, needsPersist } = parseDocument(raw);
      let recovered = needsPersist;
      next.snapshot.messages = next.snapshot.messages.map((message) => {
        if (message.role !== 'assistant' || !['pending', 'streaming'].includes(message.status)) return message;
        recovered = true;
        return { ...message, status: 'aborted', error: '上次生成已中断，可重试。' };
      });
      if (recovered) await storage.setItem(WEB_STORAGE_KEY, JSON.stringify(next));
      document = next;
      return document;
    }
    const legacy = await readLegacyCompanion(storage);
    const next: WebDocument = {
      schemaVersion: 3,
      snapshot: initialSnapshot(legacy.data, legacy.notice),
    };
    next.snapshot.migrationNotice = legacy.migrationNotice ?? null;
    // A single atomic key is also the import marker. The old companion key is never changed or removed.
    await storage.setItem(WEB_STORAGE_KEY, JSON.stringify(next));
    document = next;
    return next;
  }

  const mutate = (update: (snapshot: AppSnapshot) => void) => enqueue(async () => {
    const next = clone(await prepare());
    update(next.snapshot);
    await storage.setItem(WEB_STORAGE_KEY, JSON.stringify(next));
    document = next;
  });
  const mutateSnapshot = (update: (snapshot: AppSnapshot) => void) => enqueue(async () => {
    const next = clone(await prepare());
    update(next.snapshot);
    await storage.setItem(WEB_STORAGE_KEY, JSON.stringify(next));
    document = next;
    return clone(next.snapshot);
  });

  return {
    renameThinkingVariable: (oldName, newName, variables) => mutateSnapshot((snapshot) => {
      snapshot.companion = renameCompanionThinkingVariable(snapshot.companion, oldName, newName, variables);
      snapshot.models = snapshot.models.map((model) => ({ ...model,
        thinkingConfig: renameModelThinkingVariable(model.thinkingConfig!, oldName, newName) }));
    }),
    dismissMigrationNotice: (id) => mutate((snapshot) => {
      if (id !== 'thinking-v2') throw new Error('迁移通知标识无效。');
      snapshot.migrationNotice = null;
    }),
    initialize: () => enqueue(async () => clone((await prepare()).snapshot)),
    saveCompanion: (data, personaId) => mutate((snapshot) => {
      if (data.schemaVersion !== 2 || !modeValid(data.thinking.mode)) throw new Error('思维配置版本或模式无效。');
      const id = personaId ?? snapshot.personas.find((item) => item.isActive)!.id;
      const owner = snapshot.personas.find((item) => item.id === id);
      if (!owner) throw new Error('保存的人设已不存在，草稿未写入其他人设。');
      const nextPersona = { ...owner, id, profile: clone(data.profile), memories: clone(data.memories), interests: clone(data.interests), isActive: owner.isActive };
      assertPersonaRecord(nextPersona);
      assertMemoryOwners(snapshot, nextPersona);
      snapshot.personas = snapshot.personas.map((item) => item.id === id ? nextPersona : item);
      snapshot.companion = { ...snapshot.companion, thinking: clone(data.thinking) };
      syncCompanion(snapshot);
      const userName = data.thinking.variables.find((item) => item.name === 'user_name');
      if (userName) {
        assertAppSettings({ ...snapshot.settings, userName: userName.value });
        snapshot.settings.userName = userName.value;
      }
      const ids = new Set(data.thinking.templates.map((item) => item.id));
      snapshot.models = snapshot.models.map((item) => item.cotPresetId && !ids.has(item.cotPresetId)
        ? { ...item, cotPresetId: null } : item);
      snapshot.models = snapshot.models.map((item) => ({ ...item,
        thinkingConfig: reconcileThinkingTemplates(item.thinkingConfig ?? createModelThinkingConfig(), data.thinking.templates) }));
    }),
    savePersona: (persona) => mutateSnapshot((snapshot) => {
      assertPersonaRecord(persona);
      assertMemoryOwners(snapshot, persona);
      const existing = snapshot.personas.find((item) => item.id === persona.id);
      const nextPersona = { ...clone(persona), isActive: persona.isActive || Boolean(existing?.isActive),
        configuration: clone(persona.configuration ?? existing?.configuration ?? createRoleConfiguration(snapshot.settings, snapshot.companion.thinking.variables)) };
      snapshot.personas = snapshot.personas.map((item) => item.id === persona.id ? nextPersona
        : persona.isActive ? { ...item, isActive: false } : item);
      if (!existing) snapshot.personas.push(nextPersona);
      syncCompanion(snapshot);
    }),
    saveRole: (persona, baseline, model) => mutateSnapshot((snapshot) => {
      assertPersonaRecord(persona);
      const existing = snapshot.personas.find((item) => item.id === persona.id);
      assertRoleBaseline(existing, baseline);
      assertMemoryOwners(snapshot, persona);
      if (model && persona.configuration?.currentModelId !== model.id) throw new Error('新增模型与角色选择不一致，请重新选择模型。');
      if (model) {
        const thinkingConfig = model.thinkingConfig ?? createModelThinkingConfig();
        assertThinkingTemplateBindings(thinkingConfig, snapshot.companion.thinking.templates);
        snapshot.models = modelsAfterSave(snapshot.models, modelWithDefault(snapshot.models, clone({ ...model, thinkingConfig })));
      }
      validateRoleForSave(persona, snapshot.models, snapshot.companion.thinking, snapshot.settings);
      const nextPersona = { ...clone(persona), isActive: persona.isActive || Boolean(existing?.isActive) };
      snapshot.personas = snapshot.personas.map((item) => item.id === persona.id ? nextPersona
        : persona.isActive ? { ...item, isActive: false } : item);
      if (!existing) snapshot.personas.push(nextPersona);
      syncCompanion(snapshot);
    }),
    setActivePersona: (id) => mutateSnapshot((snapshot) => {
      if (!snapshot.personas.some((item) => item.id === id)) throw new Error('选择的人设已不存在。');
      snapshot.personas = snapshot.personas.map((item) => ({ ...item, isActive: item.id === id }));
      syncCompanion(snapshot);
    }),
    deletePersona: (id) => mutateSnapshot((snapshot) => {
      const persona = snapshot.personas.find((item) => item.id === id);
      if (!persona) throw new Error('选择的人设已不存在。');
      if (snapshot.personas.length <= 1) throw new Error('至少需要保留一个人设。');
      snapshot.personas = snapshot.personas.filter((item) => item.id !== id);
      if (persona.isActive) snapshot.personas[0].isActive = true;
      snapshot.sessions = snapshot.sessions.map((item) => item.personaId === id ? { ...item, personaId: null } : item);
      syncCompanion(snapshot);
    }),
    resetData: (revision) => enqueue(async () => {
      assertResetRevision(revision);
      const current = await prepare();
      if (current.resetRevision === revision) return clone(current.snapshot);
      const next: WebDocument = { schemaVersion: 3, snapshot: initialSnapshot(), resetRevision: revision };
      await storage.setItem(WEB_STORAGE_KEY, JSON.stringify(next));
      document = next;
      return clone(next.snapshot);
    }),
    hasDataReset: (revision) => enqueue(async () => {
      assertResetRevision(revision);
      return (await prepare()).resetRevision === revision;
    }),
    saveSettings: (settings) => mutate((snapshot) => {
      assertAppSettings(settings);
      snapshot.settings = clone(settings);
      snapshot.companion.thinking.variables = snapshot.companion.thinking.variables.map((item) => item.name === 'user_name'
        ? { ...item, value: settings.userName } : item);
    }),
    saveModel: (model) => mutate((snapshot) => {
      if (model.cotPresetId && !snapshot.companion.thinking.templates.some((item) => item.id === model.cotPresetId)) {
        throw new Error('选择的思维链模板已不存在。');
      }
      if (!modeValid(model.cotMode)) throw new Error('思维链模式无效，请重新选择。');
      const thinkingConfig = model.thinkingConfig ?? snapshot.models.find((item) => item.id === model.id)?.thinkingConfig ?? createModelThinkingConfig();
      assertThinkingTemplateBindings(thinkingConfig, snapshot.companion.thinking.templates);
      snapshot.models = modelsAfterSave(snapshot.models, modelWithDefault(snapshot.models, clone({ ...model,
        thinkingConfig: copyModelThinkingConfig(thinkingConfig) })));
    }),
    deleteModel: (id) => mutate((snapshot) => {
      const owners = snapshot.personas.filter((persona) => persona.configuration?.currentModelId === id);
      if (owners.length) throw new Error(`此模型正由 ${owners.map((persona) => persona.profile.name).join('、')} 使用，请先为这些角色选择其他模型。`);
      snapshot.models = modelsAfterDelete(snapshot.models, id);
      snapshot.sessions = snapshot.sessions.map((item) => item.modelId === id ? { ...item, modelId: null } : item);
    }),
    saveSession: (session) => mutate((snapshot) => {
      if (session.modelId && !snapshot.models.some((item) => item.id === session.modelId)) {
        throw new Error('选择的模型已不存在。');
      }
      if (session.personaId && !snapshot.personas.some((item) => item.id === session.personaId)) throw new Error('选择的人设已不存在。');
      snapshot.sessions = snapshot.sessions.filter((item) => item.id !== session.id);
      snapshot.sessions.push(clone(session));
      snapshot.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }),
    deleteSession: (id) => mutate((snapshot) => {
      snapshot.sessions = snapshot.sessions.filter((item) => item.id !== id);
      snapshot.messages = snapshot.messages.filter((item) => item.sessionId !== id);
    }),
    saveMessage: (message) => mutate((snapshot) => {
      if (message.cotAudit != null && !isCotAudit(message.cotAudit)) throw new Error('消息配置快照格式异常。');
      if (!snapshot.sessions.some((item) => item.id === message.sessionId)) throw new Error('所属会话已不存在。');
      const previous = snapshot.messages.find((item) => item.id === message.id) ?? null;
      assertMessageTransition(previous, message);
      snapshot.messages = snapshot.messages.filter((item) => item.id !== message.id);
      snapshot.messages.push(clone({ ...message, cotMode: previous?.cotMode ?? message.cotMode, thinkingMode: message.thinkingMode ?? null }));
      snapshot.messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }),
    getMessages: (sessionId) => enqueue(async () => clone((await prepare()).snapshot.messages.filter((item) => item.sessionId === sessionId))),
    saveChatTurn: (session, messages) => enqueue(async () => {
      if (messages.some((message) => message.cotAudit != null && !isCotAudit(message.cotAudit))) throw new Error('消息配置快照格式异常。');
      const next = clone(await prepare());
      const snapshot = next.snapshot;
      const modelId = snapshot.models.some((item) => item.id === session.modelId) ? session.modelId : null;
      const existing = snapshot.sessions.find((item) => item.id === session.id);
      const persisted = existing ? { ...existing, modelId, updatedAt: session.updatedAt }
        : { ...session, modelId, personaId: session.personaId ?? snapshot.personas.find((item) => item.isActive)!.id };
      if (!existing && persisted.personaId && !snapshot.personas.some((item) => item.id === persisted.personaId)) throw new Error('发送时的人设已不存在，会话未写入其他人设。');
      if (messages.some((item) => item.sessionId !== session.id)) throw new Error('消息所属会话不一致。');
      snapshot.sessions = [...snapshot.sessions.filter((item) => item.id !== session.id), persisted]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const ids = new Set(messages.map((item) => item.id));
      const savedMessages = messages.map((message) => {
        const previous = snapshot.messages.find((item) => item.id === message.id) ?? null;
        assertMessageTransition(previous, message);
        return { ...message, cotMode: previous?.cotMode ?? message.cotMode, thinkingMode: message.thinkingMode ?? null };
      });
      snapshot.messages = [...snapshot.messages.filter((item) => !ids.has(item.id)), ...clone(savedMessages)]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      await storage.setItem(WEB_STORAGE_KEY, JSON.stringify(next));
      document = next;
      return clone(persisted);
    }),
    finishChatTurn: (sessionId, message, updatedAt) => enqueue(async () => {
      if (message.cotAudit != null && !isCotAudit(message.cotAudit)) throw new Error('消息配置快照格式异常。');
      const next = clone(await prepare());
      const existing = next.snapshot.sessions.find((item) => item.id === sessionId);
      if (!existing || message.sessionId !== sessionId) throw new Error('所属会话已不存在。');
      const previous = next.snapshot.messages.find((item) => item.id === message.id) ?? null;
      assertMessageTransition(previous, message);
      const session = { ...existing, updatedAt };
      next.snapshot.sessions = next.snapshot.sessions.map((item) => item.id === sessionId ? session : item)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      next.snapshot.messages = [...next.snapshot.messages.filter((item) => item.id !== message.id),
        clone({ ...message, cotMode: previous?.cotMode ?? message.cotMode, thinkingMode: message.thinkingMode ?? null })]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      await storage.setItem(WEB_STORAGE_KEY, JSON.stringify(next));
      document = next;
      return clone(session);
    }),
    searchSessions: (query) => enqueue(async () => {
      const snapshot = (await prepare()).snapshot;
      const value = query.trim().toLocaleLowerCase();
      return clone(snapshot.sessions.filter((session) => session.title.toLocaleLowerCase().includes(value)
        || snapshot.messages.some((message) => message.sessionId === session.id && message.content.toLocaleLowerCase().includes(value)))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    }),
  };
}
