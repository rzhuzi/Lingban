import type { AppSettings, ModelRecord, PersonaRecord, RoleConfiguration, RoleModelConfiguration } from '../../lib/db/types';
import { buildRequestMessages } from '../../lib/cot/inject';
import { copyModelThinkingConfig, createModelThinkingConfig, getModelThinkingConfig, templateMatchesMode, THINKING_CONTENT_MODES } from './thinking-config';
import type { CompanionData, PromptVariable, ThinkingConfig, ThinkingDraft } from './types';

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const reserved = new Set(['persona', 'date', 'user_name']);

export function createRoleConfiguration(settings?: Pick<AppSettings, 'contextWindow' | 'streamOutput'>, variables: PromptVariable[] = []): RoleConfiguration {
  return { version: 1, confirmed: false, currentModelId: null, models: {},
    variables: clone(variables.filter((item) => !reserved.has(item.name))),
    chatSettings: { contextWindow: settings?.contextWindow ?? 20, streamOutput: settings?.streamOutput ?? true } };
}

export function getRoleConfiguration(persona: Pick<PersonaRecord, 'configuration'>, settings?: Pick<AppSettings, 'contextWindow' | 'streamOutput'>, variables: PromptVariable[] = []): RoleConfiguration {
  return clone(persona.configuration ?? createRoleConfiguration(settings, variables));
}

export function getRoleModelConfiguration(config: RoleConfiguration, modelId: string): RoleModelConfiguration {
  return clone(Object.hasOwn(config.models, modelId) ? config.models[modelId] : { mode: 'off', thinking: createModelThinkingConfig() });
}

/** Copy the effective old template, not a potentially stale inline cache. */
export function createRoleModelConfiguration(model: ModelRecord, globalThinking: ThinkingConfig): RoleModelConfiguration {
  const thinking = copyModelThinkingConfig(getModelThinkingConfig(model));
  let blockedReason: string | undefined;
  const snapshot = (draft: ThinkingDraft, mode: typeof THINKING_CONTENT_MODES[number], active: boolean): ThinkingDraft => {
    if (!draft.templateId) return clone(draft);
    const template = globalThinking.templates.find((item) => item.id === draft.templateId);
    if (active && (!template || template.enabled === false || !templateMatchesMode(template, mode))) {
      blockedReason = '旧配置的模板已停用、丢失或用途不符，请检查后保存角色配置。';
    }
    return { ...draft, text: template?.prompt ?? draft.text, templateId: null };
  };
  for (const mode of THINKING_CONTENT_MODES) {
    const slot = thinking[mode];
    slot.draft = snapshot(slot.draft, mode, false);
    if (slot.applied) slot.applied = snapshot(slot.applied, mode, model.cotMode === mode);
    if (model.cotMode === mode && !slot.applied) blockedReason = '旧配置尚未应用或绑定已失效，请检查后保存角色配置。';
  }
  return { mode: model.cotMode, thinking, ...(blockedReason ? { blockedReason } : {}) };
}

export function assertRoleConfiguration(value: unknown): asserts value is RoleConfiguration {
  const object = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item);
  if (!object(value) || value.version !== 1 || typeof value.confirmed !== 'boolean'
    || !(value.currentModelId === null || typeof value.currentModelId === 'string') || !object(value.models)
    || !Array.isArray(value.variables) || !object(value.chatSettings)
    || !Number.isInteger(value.chatSettings.contextWindow) || Number(value.chatSettings.contextWindow) < 1 || Number(value.chatSettings.contextWindow) > 100
    || typeof value.chatSettings.streamOutput !== 'boolean') throw new Error('角色配置格式异常，已有内容尚未覆盖。');
  const variables = value.variables as PromptVariable[];
  if (variables.some((item) => !object(item) || typeof item.id !== 'string' || typeof item.name !== 'string' || !item.name.trim()
    || /[{}\s]/u.test(item.name) || reserved.has(item.name) || typeof item.value !== 'string')
    || new Set(variables.map((item) => item.name)).size !== variables.length) throw new Error('角色变量格式无效或名称重复。');
  for (const binding of Object.values(value.models)) {
    if (!object(binding) || !['off', 'official', 'instruction', 'persona'].includes(String(binding.mode))
      || (binding.blockedReason !== undefined && typeof binding.blockedReason !== 'string')) throw new Error('角色模型配置格式异常。');
    copyModelThinkingConfig(binding.thinking as RoleModelConfiguration['thinking']);
    for (const mode of THINKING_CONTENT_MODES) {
      const state = (binding.thinking as RoleModelConfiguration['thinking'])[mode];
      if (state.draft.templateId !== null || state.applied?.templateId != null) throw new Error('角色配置需复制模板内容，不能保留共享绑定。');
    }
  }
  if (value.confirmed && (!value.currentModelId || !Object.hasOwn(value.models, value.currentModelId))) throw new Error('请为角色选择模型并保存。');
}

export function assertRoleBaseline(current: PersonaRecord | undefined, baseline: PersonaRecord | null | undefined) {
  if (baseline === undefined) return;
  if (baseline === null) {
    if (current) throw new Error('角色已存在，请重新打开后编辑。');
    return;
  }
  if (!current) throw new Error('角色已删除，请重新创建。');
  const content = (persona: PersonaRecord) => JSON.stringify({ profile: persona.profile, memories: persona.memories,
    interests: persona.interests, configuration: persona.configuration });
  if (content(current) !== content(baseline)) throw new Error('角色配置已在其他页面更新，请重新打开后编辑。当前内容尚未覆盖。');
}

/** One coherent role snapshot supplies every setting used by a request. */
export function resolveRoleRuntime(persona: PersonaRecord, models: ModelRecord[], globalThinking: ThinkingConfig, settings: AppSettings) {
  const configuration = getRoleConfiguration(persona, settings, globalThinking.variables);
  assertRoleConfiguration(configuration);
  if (!configuration.confirmed || !configuration.currentModelId) throw new Error('请先为这个角色确认模型和思维配置。');
  const storedModel = models.find((item) => item.id === configuration.currentModelId);
  if (!storedModel) throw new Error('这个角色使用的模型已不存在，请重新选择模型。');
  const binding = getRoleModelConfiguration(configuration, storedModel.id);
  if (binding.mode !== 'off' && binding.blockedReason) throw new Error(binding.blockedReason);
  const model: ModelRecord = { ...clone(storedModel), cotMode: binding.mode, thinkingConfig: binding.thinking, cotPresetId: null };
  const data: CompanionData = { schemaVersion: 2, profile: clone(persona.profile), memories: clone(persona.memories), interests: clone(persona.interests),
    thinking: { ...clone(globalThinking), mode: binding.mode, templates: [], variables: [...clone(configuration.variables),
      { id: 'builtin-user-name', name: 'user_name', value: settings.userName }] } };
  return { personaId: persona.id, model, data, settings: { ...settings, ...configuration.chatSettings } };
}

export function validateRoleForSave(persona: PersonaRecord, models: ModelRecord[], globalThinking: ThinkingConfig, settings: AppSettings) {
  if (!persona.configuration?.confirmed) throw new Error('请为角色选择模型并完成配置。');
  const resolved = resolveRoleRuntime(persona, models, globalThinking, settings);
  buildRequestMessages(resolved.model, resolved.data, [{ role: 'user', content: '配置校验' }]);
}
