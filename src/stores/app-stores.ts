import { create } from 'zustand';

import { createDefaultData, createId } from '@/features/companion/defaults';
import type { CompanionData, CompanionProfile, MemoryItem, ModelThinkingConfig, PromptTemplate, PromptVariable, ThinkingConfig, ThinkingContentMode, ThinkingMode } from '@/features/companion/types';
import { assertThinkingTemplateBindings, copyModelThinkingConfig, getModelThinkingConfig, reconcileThinkingTemplates, templateMatchesMode, THINKING_CONTENT_MODES } from '@/features/companion/thinking-config';
import { renameModelThinkingVariable } from '@/features/companion/thinking-variables';
import { createRoleConfiguration, getRoleConfiguration } from '@/features/companion/role-config';
import { CREDENTIAL_CLEANUP_ERROR } from '@/features/models/model-configuration';
import { modelCredentials } from '@/features/models/model-credentials';
import { useChatRuntimeStore } from '@/lib/chat/runtime';
import { localDataReset } from '@/lib/data/reset-service';
import { repository } from '@/lib/db/repository';
import { DEFAULT_SETTINGS, type AppSettings, type AppSnapshot, type MessageRecord, type ModelRecord, type PersonaRecord, type RoleConfiguration, type SessionRecord } from '@/lib/db/types';

import { createWriteQueue } from './write-queue';
import { useThinkingEditorStore } from './thinking-editor-store';

type PersistedState = { ready: boolean; saveError: string | null };
type PersonaState = PersistedState & {
  personas: PersonaRecord[]; activePersonaId: string; busy: boolean;
  profile: CompanionProfile; memories: MemoryItem[]; interests: string[];
  updateProfile: (patch: Partial<CompanionProfile>) => void;
  addMemory: (input: Pick<MemoryItem, 'text' | 'icon'>) => void;
  updateMemory: (id: string, patch: Partial<Pick<MemoryItem, 'text' | 'icon'>>) => void;
  deleteMemory: (id: string) => void;
  setInterests: (interests: string[]) => void;
  retrySave: () => void;
  createPersona: (name: string) => Promise<void>;
  switchPersona: (id: string) => Promise<void>;
  deletePersona: (id: string) => Promise<void>;
  renamePersona: (id: string, name: string) => Promise<void>;
  saveRole: (persona: PersonaRecord, baseline?: PersonaRecord | null, pendingModel?: { model: ModelRecord; apiKey?: string }) => Promise<void>;
};
type CotState = PersistedState & {
  thinking: ThinkingConfig;
  updateThinking: (patch: Partial<ThinkingConfig>) => void;
  renameThinkingVariable: (oldName: string, newName: string, variables: PromptVariable[]) => Promise<void>;
  retrySave: () => void;
};
type SettingsState = PersistedState & {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  retrySave: () => void;
};
type ModelState = PersistedState & {
  models: ModelRecord[];
  credentialCleanupPending: boolean;
  saveModel: (model: ModelRecord) => Promise<void>;
  saveThinkingConfiguration: (id: string, config: ModelThinkingConfig, mode?: ThinkingMode, editedMode?: ThinkingContentMode) => Promise<void>;
  deleteModel: (id: string) => Promise<void>;
  saveModelConfiguration: (model: ModelRecord, newApiKey?: string, thinkingBaseline?: Pick<ModelRecord, 'cotMode' | 'thinkingConfig'>) => Promise<void>;
  deleteModelConfiguration: (id: string) => Promise<void>;
  retryCredentialCleanup: () => Promise<void>;
};
type ChatState = PersistedState & {
  sessions: SessionRecord[]; messages: MessageRecord[]; activeSessionId: string | null;
  searchSessions: (query: string) => Promise<SessionRecord[]>;
};

const defaults = createDefaultData();
const writes = createWriteQueue();
let initialization: Promise<void> | null = null;
let persistedTemplateIds = new Set<string>();
const SAVE_ERROR = '保存失败，当前修改仍保留在本次会话中。请重试。';
const isReady = () => usePersonaStore.getState().ready && useCotStore.getState().ready;
export const useAppMaintenanceStore = create<{ active: boolean }>()(() => ({ active: false }));
export const useAppRecoveryStore = create<{ notice: string | null; dismissNotice: () => void;
  migrationNotice: AppSnapshot['migrationNotice']; migrationError: string | null; migrationBusy: boolean;
  dismissMigrationNotice: () => Promise<void> }>()((set, get) => ({
  notice: null,
  dismissNotice: () => set({ notice: null }),
  migrationNotice: null, migrationError: null, migrationBusy: false,
  dismissMigrationNotice: async () => {
    const notice = get().migrationNotice;
    if (!notice || get().migrationBusy || isAppMaintenanceActive()) return;
    set({ migrationBusy: true, migrationError: null });
    try {
      await writes.run(async () => {
        if (!repository.dismissMigrationNotice) throw new Error('无法保存提示状态，请重试。');
        await repository.dismissMigrationNotice(notice.id);
      });
      set({ migrationNotice: null, migrationError: null });
    } catch { set({ migrationError: '提示状态保存失败，点关闭可重试。' }); }
    finally { set({ migrationBusy: false }); }
  },
}));
export const isAppMaintenanceActive = () => useAppMaintenanceStore.getState().active;
const editableCompanion = () => isReady() && !usePersonaStore.getState().busy && !isAppMaintenanceActive();
const requireWritable = () => {
  if (isAppMaintenanceActive()) throw new Error('正在处理本地数据，请稍后重试。');
};

function companionSnapshot(): CompanionData {
  const { profile, memories, interests } = usePersonaStore.getState();
  return { schemaVersion: 2, profile, memories, interests, thinking: useCotStore.getState().thinking };
}

function snapshotPersonas(snapshot: AppSnapshot): PersonaRecord[] {
  if (snapshot.personas?.length) return snapshot.personas.map((persona) => ({ ...persona,
    configuration: getRoleConfiguration(persona, snapshot.settings, snapshot.companion.thinking.variables) }));
  const { profile, memories, interests } = snapshot.companion;
  return [{ id: 'persona-default', profile, memories, interests, isActive: true,
    configuration: createRoleConfiguration(snapshot.settings, snapshot.companion.thinking.variables) }];
}

function applyPersonaSnapshot(snapshot: AppSnapshot) {
  const personas = snapshotPersonas(snapshot);
  const active = personas.find((persona) => persona.isActive) ?? personas[0];
  usePersonaStore.setState({ personas, activePersonaId: active.id,
    profile: active.profile, memories: active.memories, interests: active.interests,
    ready: true, saveError: null });
}

/** Resolve a session's owner explicitly; never fall back to another person's memories. */
export function getCompanionForPersona(id?: string | null): { data: CompanionData; personaId: string; configuration: RoleConfiguration } {
  const state = usePersonaStore.getState();
  const owner = state.personas.find((persona) => persona.id === (id ?? state.activePersonaId));
  if (!owner) throw new Error('此会话的人设已删除，请创建新会话。');
  return { personaId: owner.id, configuration: getRoleConfiguration(owner, useSettingsStore.getState().settings, useCotStore.getState().thinking.variables), data: { schemaVersion: 2,
    profile: owner.profile, memories: owner.memories, interests: owner.interests,
    thinking: useCotStore.getState().thinking } };
}

/** Hydrate a completed reset/startup snapshot; maintenance ownership stays with its caller. */
export function applyAppSnapshot(snapshot: AppSnapshot): void {
  useAppRecoveryStore.setState({ notice: snapshot.notice, migrationNotice: snapshot.migrationNotice ?? null, migrationError: null, migrationBusy: false });
  applyPersonaSnapshot(snapshot);
  usePersonaStore.setState({ busy: false });
  useCotStore.setState({ thinking: snapshot.companion.thinking, ready: true, saveError: null });
  useSettingsStore.setState({ settings: snapshot.settings, ready: true, saveError: null });
  persistedTemplateIds = new Set(snapshot.companion.thinking.templates.map((template) => template.id));
  useModelStore.setState({ models: snapshot.models, ready: true, saveError: null, credentialCleanupPending: false });
  useChatStore.setState({ sessions: [...snapshot.sessions].sort(newestSessionFirst), messages: [...snapshot.messages]
    .sort(oldestMessageFirst), activeSessionId: null, ready: true, saveError: null });
}

/** Lock immediately, then wait behind already queued writes before exporting/resetting data. */
export async function runAppMaintenance<T>(work: () => Promise<T>): Promise<T> {
  requireWritable();
  useAppMaintenanceStore.setState({ active: true });
  try {
    await initializeStores();
    return await writes.run(work);
  } finally { useAppMaintenanceStore.setState({ active: false }); }
}

function companionError(saveError: string | null) {
  usePersonaStore.setState({ saveError });
  useCotStore.setState({ saveError });
}

function reconcileModelBindings(templates: PromptTemplate[]) {
  const templateIds = new Set(templates.map((template) => template.id));
  persistedTemplateIds = templateIds;
  useModelStore.setState((state) => {
    let changed = false;
    const models = state.models.map((model) => {
      const current = getModelThinkingConfig(model);
      const thinkingConfig = reconcileThinkingTemplates(current, templates);
      const cotPresetId = model.cotPresetId !== null && !templateIds.has(model.cotPresetId) ? null : model.cotPresetId;
      if (cotPresetId === model.cotPresetId && JSON.stringify(current) === JSON.stringify(thinkingConfig)) return model;
      changed = true;
      return { ...model, cotPresetId, thinkingConfig };
    });
    return changed ? { models } : state;
  });
  useThinkingEditorStore.setState((state) => ({ sessions: Object.fromEntries(Object.entries(state.sessions).map(([id, session]) => [id,
    { model: { ...session.model, thinkingConfig: reconcileThinkingTemplates(getModelThinkingConfig(session.model), templates),
      cotPresetId: session.model.cotPresetId && !templateIds.has(session.model.cotPresetId) ? null : session.model.cotPresetId } }])) }));
}

function saveCompanion() {
  if (!isReady()) return;
  const snapshot = companionSnapshot();
  const ownerId = usePersonaStore.getState().activePersonaId;
  usePersonaStore.setState((state) => ({ personas: state.personas.map((persona) => persona.id === ownerId
    ? { ...persona, profile: snapshot.profile, memories: snapshot.memories, interests: snapshot.interests } : persona) }));
  const userNameVariable = snapshot.thinking.variables.find((variable) => variable.name === 'user_name');
  if (userNameVariable) {
    useSettingsStore.setState((state) => state.settings.userName === userNameVariable.value ? state
      : { settings: { ...state.settings, userName: userNameVariable.value } });
  }
  writes.save('companion', () => repository.saveCompanion(snapshot, ownerId), {
    onSuccess: () => {
      // Match the FK cleanup performed by this committed snapshot, not a newer draft.
      reconcileModelBindings(snapshot.thinking.templates);
      companionError(null);
    },
    onFailure: () => companionError(SAVE_ERROR),
  });
}

function saveSettings() {
  if (!useSettingsStore.getState().ready) return;
  const snapshot = useSettingsStore.getState().settings;
  writes.save('settings', () => repository.saveSettings(snapshot), {
    onSuccess: () => useSettingsStore.setState({ saveError: null }),
    onFailure: () => useSettingsStore.setState({ saveError: SAVE_ERROR }),
  });
}

function retryCompanionSave() {
  if (isAppMaintenanceActive() || usePersonaStore.getState().busy) return;
  if (!isReady()) { void initializeStores().catch(() => {}); return; }
  saveCompanion();
}

export const usePersonaStore = create<PersonaState>()((set, get) => ({
  personas: [{ id: 'persona-default', profile: defaults.profile, memories: defaults.memories, interests: defaults.interests, isActive: true }],
  activePersonaId: 'persona-default', busy: false,
  profile: defaults.profile, memories: defaults.memories, interests: defaults.interests,
  ready: false, saveError: null,
  updateProfile: (patch) => {
    if (!editableCompanion()) return;
    set({ profile: { ...get().profile, ...patch } });
    saveCompanion();
  },
  addMemory: (input) => {
    if (!editableCompanion() || !input.text.trim()) return;
    const now = new Date().toISOString();
    set({ memories: [{ ...input, id: createId(), createdAt: now, updatedAt: now }, ...get().memories] });
    saveCompanion();
  },
  updateMemory: (id, patch) => {
    if (!editableCompanion() || (patch.text !== undefined && !patch.text.trim())) return;
    set({ memories: get().memories.map((item) => item.id === id
      ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item) });
    saveCompanion();
  },
  deleteMemory: (id) => {
    if (!editableCompanion()) return;
    set({ memories: get().memories.filter((item) => item.id !== id) });
    saveCompanion();
  },
  setInterests: (interests) => {
    if (!editableCompanion()) return;
    set({ interests });
    saveCompanion();
  },
  retrySave: retryCompanionSave,
  saveRole: async (input, baseline, pendingModel) => {
    requireWritable();
    if (get().busy) throw new Error('正在处理角色，请稍后重试。');
    const persona: PersonaRecord = JSON.parse(JSON.stringify(input));
    const capturedBaseline = baseline === undefined ? undefined : baseline === null ? null : JSON.parse(JSON.stringify(baseline)) as PersonaRecord;
    const capturedModel = pendingModel ? { model: JSON.parse(JSON.stringify(pendingModel.model)) as ModelRecord, apiKey: pendingModel.apiKey } : undefined;
    set({ busy: true, saveError: null });
    try {
      await initializeStores();
      requireWritable();
      await writes.run(async () => {
        requireWritable();
        let snapshot: AppSnapshot | null = null;
        let cleanupPending = false;
        if (capturedModel) {
          const result = await modelCredentials.save(capturedModel.model, capturedModel.apiKey, async (persisted) => {
            snapshot = await repository.saveRole(persona, capturedBaseline, persisted);
          });
          cleanupPending = result.cleanupPending;
        } else {
          await modelCredentials.recover();
          snapshot = await repository.saveRole(persona, capturedBaseline);
        }
        if (!snapshot) throw new Error('角色保存未完成，请重试。');
        const committed = snapshot as AppSnapshot;
        applyPersonaSnapshot(committed);
        useModelStore.setState({ models: committed.models, credentialCleanupPending: cleanupPending,
          saveError: cleanupPending ? CREDENTIAL_CLEANUP_ERROR : null });
      });
    } catch (error) {
      set({ saveError: error instanceof Error ? error.message : '角色保存失败，编辑内容仍保留。请重试。' });
      throw error;
    } finally { set({ busy: false }); }
  },
  createPersona: async (name) => {
    requireWritable();
    if (get().busy) throw new Error('正在切换人设，请稍后重试。');
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 24) throw new Error('请填写 1 至 24 个字符的人设名称。');
    set({ busy: true });
    try {
      await initializeStores();
      requireWritable();
      await writes.run(async () => {
        const snapshot = await repository.savePersona({ id: createId(),
          profile: { name: trimmed, description: '', coverUri: null, avatarUri: null, traits: [] },
          memories: [], interests: [], isActive: true });
        applyPersonaSnapshot(snapshot);
      });
    } catch { set({ saveError: '新增人设失败，请先保存现有修改后重试。' }); throw new Error('新增人设失败，请先保存现有修改后重试。'); }
    finally { set({ busy: false }); }
  },
  switchPersona: async (id) => {
    requireWritable();
    if (get().busy) throw new Error('正在切换人设，请稍后重试。');
    if (id === get().activePersonaId) return;
    set({ busy: true });
    try {
      await initializeStores();
      requireWritable();
      await writes.run(async () => applyPersonaSnapshot(await repository.setActivePersona(id)));
    } catch { set({ saveError: '切换人设失败，当前人设和修改仍保留。请重试。' }); throw new Error('切换人设失败，当前人设和修改仍保留。请重试。'); }
    finally { set({ busy: false }); }
  },
  deletePersona: async (id) => {
    requireWritable();
    if (useChatRuntimeStore.getState().isSending) throw new Error('请先停止生成，再删除人设。');
    if (get().busy) throw new Error('正在处理人设，请稍后重试。');
    if (get().personas.length < 2) throw new Error('至少保留一个人设。');
    set({ busy: true });
    try {
      await initializeStores();
      requireWritable();
      await writes.run(async () => {
        applyPersonaSnapshot(await repository.deletePersona(id));
        useChatStore.setState((state) => ({ sessions: state.sessions.map((session) => session.personaId === id
          ? { ...session, personaId: null } : session) }));
      });
    } catch { set({ saveError: '删除人设失败，已有内容仍保留。请重试。' }); throw new Error('删除人设失败，已有内容仍保留。请重试。'); }
    finally { set({ busy: false }); }
  },
  renamePersona: async (id, name) => {
    requireWritable();
    if (get().busy) throw new Error('正在处理人设，请稍后重试。');
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 24) throw new Error('请填写 1 至 24 个字符的人设名称。');
    set({ busy: true });
    try {
      await initializeStores();
      requireWritable();
      await writes.run(async () => {
        const persona = get().personas.find((item) => item.id === id);
        if (!persona) throw new Error('人设已不存在。');
        applyPersonaSnapshot(await repository.savePersona({ ...persona, profile: { ...persona.profile, name: trimmed } }));
      });
    } catch { set({ saveError: '修改名称失败，已有内容仍保留。请重试。' }); throw new Error('修改名称失败，已有内容仍保留。请重试。'); }
    finally { set({ busy: false }); }
  },
}));

export const useCotStore = create<CotState>()((set, get) => ({
  thinking: defaults.thinking, ready: false, saveError: null,
  updateThinking: (patch) => {
    if (!editableCompanion()) return;
    const thinking = { ...get().thinking, ...patch };
    set({ thinking });
    if (patch.variables !== undefined) {
      const userNameVariable = thinking.variables.find((variable) => variable.name === 'user_name');
      if (userNameVariable) {
        useSettingsStore.setState((state) => ({ settings: { ...state.settings, userName: userNameVariable.value } }));
      }
    }
    saveCompanion();
  },
  renameThinkingVariable: async (oldName, newName, variables) => {
    requireWritable();
    useThinkingEditorStore.setState({ locked: true });
    try {
      await runAppMaintenance(async () => {
        if (!repository.renameThinkingVariable) throw new Error('无法更新变量，请重试。');
        // Validate every temporary form before committing the database transaction.
        const sessions = Object.fromEntries(Object.entries(useThinkingEditorStore.getState().sessions).map(([id, session]) => [id,
          { model: { ...session.model, thinkingConfig: renameModelThinkingVariable(getModelThinkingConfig(session.model), oldName, newName) } }]));
        await modelCredentials.recover();
        const snapshot = await repository.renameThinkingVariable(oldName, newName, variables);
        set({ thinking: snapshot.companion.thinking, saveError: null });
        useModelStore.setState({ models: snapshot.models, saveError: null, credentialCleanupPending: false });
        useSettingsStore.setState({ settings: snapshot.settings });
        // A form may have unmounted during I/O; do not resurrect its session.
        useThinkingEditorStore.setState((state) => ({ sessions: Object.fromEntries(Object.keys(state.sessions)
          .filter((id) => sessions[id]).map((id) => [id, sessions[id]])) }));
      });
    } finally { useThinkingEditorStore.setState({ locked: false }); }
  },
  retrySave: retryCompanionSave,
}));

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  settings: { ...DEFAULT_SETTINGS }, ready: false, saveError: null,
  updateSettings: (patch) => {
    if (!get().ready || isAppMaintenanceActive()) return;
    const settings = { ...get().settings, ...patch };
    set({ settings });
    if (patch.userName !== undefined) {
      useCotStore.setState((state) => ({ thinking: {
        ...state.thinking,
        variables: state.thinking.variables.map((variable) => variable.name === 'user_name'
          ? { ...variable, value: settings.userName } : variable),
      } }));
    }
    saveSettings();
  },
  retrySave: () => {
    if (isAppMaintenanceActive()) return;
    if (!get().ready) { void initializeStores().catch(() => {}); return; }
    saveSettings();
  },
}));

export const useModelStore = create<ModelState>()((set, get) => ({
  models: [], ready: false, saveError: null, credentialCleanupPending: false,
  saveModel: (model) => get().saveModelConfiguration(model),
  saveThinkingConfiguration: async (id, input, mode, editedMode) => {
    requireWritable();
    const captured = copyModelThinkingConfig(input);
    await initializeStores();
    try {
      await writes.run(async () => {
        requireWritable();
        // Resolve secure-storage transactions before advancing the model revision.
        await modelCredentials.recover();
        set({ credentialCleanupPending: false });
        const latest = get().models.find((item) => item.id === id);
        if (!latest) throw new Error('模型已删除，请重新选择。');
        const config = copyModelThinkingConfig(getModelThinkingConfig(latest));
        for (const slot of THINKING_CONTENT_MODES) {
          if (!editedMode || editedMode === slot) config[slot].draft = captured[slot].draft;
        }
        // Draft writes queued before/after an Apply never roll back the committed snapshot.
        if (mode && mode !== 'off') config[mode].applied = captured[mode].applied;
        const templates = useCotStore.getState().thinking.templates;
        assertThinkingTemplateBindings(config, templates);
        const cotMode = mode ?? latest.cotMode;
        if (!['off', 'official', 'instruction', 'persona'].includes(cotMode)) throw new Error('模式无效。');
        if (mode && mode !== 'off') {
          const applied = config[mode].applied;
          if (!applied) throw new Error('请先填写并应用配置。');
          const template = applied.templateId ? templates.find((item) => item.id === applied.templateId) : null;
          if (applied.templateId && (!template || template.enabled === false || !templateMatchesMode(template, mode))) throw new Error('模板不可用，请重新选择。');
          if (!(template?.prompt ?? applied.text).trim()) throw new Error('配置内容不能为空。');
        }
        const stamp = mode === undefined ? latest.updatedAt
          : new Date(Math.max(Date.now(), (Date.parse(latest.updatedAt) || 0) + 1)).toISOString();
        const updated: ModelRecord = { ...latest, thinkingConfig: config, cotMode,
          cotPresetId: cotMode === 'off' ? null : config[cotMode].applied?.templateId ?? null, updatedAt: stamp };
        await repository.saveModel(updated);
        const snapshot = await repository.initialize();
        set({ models: snapshot.models, saveError: null });
      });
    } catch (error) { set({ saveError: '思维配置保存失败，请重试。' }); throw error; }
  },
  deleteModel: (id) => get().deleteModelConfiguration(id),
  saveModelConfiguration: async (input, newApiKey, thinkingBaseline) => {
    requireWritable();
    const model = { ...input, ...(input.thinkingConfig ? { thinkingConfig: copyModelThinkingConfig(input.thinkingConfig) } : {}) };
    const baseline = thinkingBaseline ? { cotMode: thinkingBaseline.cotMode, thinkingConfig: copyModelThinkingConfig(getModelThinkingConfig(thinkingBaseline)) } : null;
    await initializeStores();
    requireWritable();
    try {
      await writes.run(async () => {
        const latest = get().models.find((item) => item.id === model.id);
        if (latest) {
          if (baseline) {
            if (latest.cotMode !== baseline.cotMode || JSON.stringify(getModelThinkingConfig(latest)) !== JSON.stringify(baseline.thinkingConfig)) {
              throw new Error('此模型的思维配置已更新，请重新打开模型页面后再保存。');
            }
          } else {
            // Ordinary model edits and default-model switches preserve queued thinking writes.
            model.cotMode = latest.cotMode;
            model.cotPresetId = latest.cotPresetId;
            model.thinkingConfig = copyModelThinkingConfig(getModelThinkingConfig(latest));
          }
        }
        if (model.thinkingConfig) assertThinkingTemplateBindings(model.thinkingConfig, useCotStore.getState().thinking.templates);
        // A queued editor may still hold a binding removed by an earlier companion save.
        const persisted = model.cotPresetId !== null && !persistedTemplateIds.has(model.cotPresetId)
          ? { ...model, cotPresetId: null } : model;
        const result = await modelCredentials.save(persisted, newApiKey);
        set({ models: result.models, credentialCleanupPending: result.cleanupPending,
          saveError: result.cleanupPending ? CREDENTIAL_CLEANUP_ERROR : null });
      });
    } catch (error) { set({ saveError: '模型配置保存失败，请重试。' }); throw error; }
  },
  deleteModelConfiguration: async (id) => {
    requireWritable();
    await initializeStores();
    requireWritable();
    try {
      await writes.run(async () => {
        const owners = usePersonaStore.getState().personas.filter((persona) => persona.configuration?.currentModelId === id);
        if (owners.length) throw new Error(`此模型正由 ${owners.map((persona) => persona.profile.name).join('、')} 使用，请先为这些角色选择其他模型。`);
        const result = await modelCredentials.delete(id);
        set({ models: result.models, credentialCleanupPending: result.cleanupPending,
          saveError: result.cleanupPending ? CREDENTIAL_CLEANUP_ERROR : null });
        useChatStore.setState((state) => ({ sessions: state.sessions.map((session) =>
          session.modelId === id ? { ...session, modelId: null } : session) }));
      });
    } catch (error) { set({ saveError: '删除模型失败，请重试。' }); throw error; }
  },
  retryCredentialCleanup: async () => {
    requireWritable();
    await initializeStores();
    requireWritable();
    if (!get().credentialCleanupPending) return;
    try {
      await writes.run(() => modelCredentials.recover());
      set({ saveError: null, credentialCleanupPending: false });
    } catch { set({ saveError: CREDENTIAL_CLEANUP_ERROR }); throw new Error(CREDENTIAL_CLEANUP_ERROR); }
  },
}));

const newestSessionFirst = (a: SessionRecord, b: SessionRecord) => b.updatedAt.localeCompare(a.updatedAt);
const oldestMessageFirst = (a: MessageRecord, b: MessageRecord) => a.createdAt.localeCompare(b.createdAt);

export const useChatStore = create<ChatState>()(() => ({
  sessions: [], messages: [], activeSessionId: null, ready: false, saveError: null,
  searchSessions: async (query) => {
    requireWritable();
    await initializeStores();
    try { return await repository.searchSessions(query); }
    catch { throw new Error('搜索会话失败，请重试。'); }
  },
}));

/** The root startup gate awaits this before mounting any editable route. */
export function initializeStores(): Promise<void> {
  if (initialization) return initialization;
  initialization = Promise.resolve().then(async () => {
    await localDataReset.recover();
    return repository.initialize();
  }).then(async (snapshot) => {
    // Resolve an interrupted credential write before any model can be selected or used.
    await modelCredentials.recover();
    applyAppSnapshot(snapshot);
  }).catch((error: unknown) => {
    const saveError = error instanceof Error ? error.message : '读取本地配置失败，已有内容尚未覆盖。请重试。';
    companionError(saveError);
    useSettingsStore.setState({ saveError });
    useModelStore.setState({ saveError });
    useChatStore.setState({ saveError });
    initialization = null;
    throw error;
  });
  return initialization;
}
