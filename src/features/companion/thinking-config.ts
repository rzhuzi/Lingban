import type { ModelRecord } from '../../lib/db/types';
import type { ModelThinkingConfig, PromptTemplate, ThinkingConfig, ThinkingContentMode, ThinkingDraft } from './types';

export const THINKING_CONTENT_MODES: ThinkingContentMode[] = ['official', 'instruction', 'persona'];
export const THINKING_MODE_LABELS = { off: '关闭', official: '官方 API 配置', instruction: '第三方指令配置', persona: '普通提示词' } as const;

export function createThinkingDraft(text = ''): ThinkingDraft {
  return { text, templateId: null, parametersJson: '{}', placement: 'system-start' };
}
export function createModelThinkingConfig(personaText = ''): ModelThinkingConfig {
  return { version: 1,
    official: { draft: createThinkingDraft(), applied: null },
    instruction: { draft: createThinkingDraft(), applied: null },
    persona: { draft: createThinkingDraft(personaText), applied: null } };
}
export function getModelThinkingConfig(model: Pick<ModelRecord, 'thinkingConfig'>): ModelThinkingConfig {
  return model.thinkingConfig ?? createModelThinkingConfig();
}
export function templateMatchesMode(template: PromptTemplate, mode: ThinkingContentMode) {
  return template.kind === mode || ((template.kind === undefined || template.kind === 'unclassified') && mode === 'persona');
}
export function assertModelThinkingConfig(value: unknown): asserts value is ModelThinkingConfig {
  const object = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item);
  const draft = (item: unknown) => object(item) && typeof item.text === 'string'
    && (item.templateId === null || typeof item.templateId === 'string') && typeof item.parametersJson === 'string'
    && ['system-start', 'user-prefix'].includes(String(item.placement));
  if (!object(value) || value.version !== 1 || !THINKING_CONTENT_MODES.every((mode) => {
    const state = value[mode];
    return object(state) && draft(state.draft) && (state.applied === null || draft(state.applied));
  })) throw new Error('模型思维配置格式异常，已有内容尚未覆盖。');
}
export function copyModelThinkingConfig(value: ModelThinkingConfig): ModelThinkingConfig {
  assertModelThinkingConfig(value);
  const copyDraft = (draft: ThinkingDraft): ThinkingDraft => ({ text: draft.text, templateId: draft.templateId,
    parametersJson: draft.parametersJson, placement: draft.placement });
  const next = createModelThinkingConfig();
  for (const mode of THINKING_CONTENT_MODES) {
    next[mode] = { draft: copyDraft(value[mode].draft), applied: value[mode].applied ? copyDraft(value[mode].applied!) : null };
  }
  return next;
}
export function legacyModelThinkingConfig(mode: string, templateId: string | null, thinking: ThinkingConfig): ModelThinkingConfig {
  const config = createModelThinkingConfig(thinking.prompt);
  const template = thinking.templates.find((item) => item.id === templateId);
  config.persona.draft = { ...config.persona.draft, templateId, text: template?.prompt ?? thinking.prompt };
  if (mode === 'persona') config.persona.applied = { ...config.persona.draft };
  return config;
}
/** Missing template references are invalidated, never changed into executable inline text. */
export function reconcileThinkingTemplates(config: ModelThinkingConfig, templates: PromptTemplate[]): ModelThinkingConfig {
  const next = JSON.parse(JSON.stringify(config)) as ModelThinkingConfig;
  for (const mode of THINKING_CONTENT_MODES) {
    const state = next[mode];
    if (state.draft.templateId && !templates.some((item) => item.id === state.draft.templateId)) state.draft.templateId = null;
    if (state.applied?.templateId && !templates.some((item) => item.id === state.applied?.templateId && templateMatchesMode(item, mode))) state.applied = null;
  }
  return next;
}
export function assertThinkingTemplateBindings(config: ModelThinkingConfig, templates: PromptTemplate[]) {
  assertModelThinkingConfig(config);
  for (const mode of THINKING_CONTENT_MODES) {
    const applied = config[mode].applied;
    if (!applied?.templateId) continue;
    const template = templates.find((item) => item.id === applied.templateId);
    if (!template || !templateMatchesMode(template, mode)) throw new Error('绑定模板已删除或用途不匹配，请重新应用配置。');
    // Disabled bindings may be saved as drafts; the request path rejects their execution.
  }
}
