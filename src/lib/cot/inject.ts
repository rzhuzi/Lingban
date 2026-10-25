import type { CompanionData, ThinkingDraft } from '../../features/companion/types';
import { assertModelThinkingConfig, getModelThinkingConfig, templateMatchesMode } from '../../features/companion/thinking-config';
import type { ChatMessage } from '../api/stream';
import type { ModelRecord } from '../db/types';
import { CotConfigurationError } from './errors';
import { buildPersonaSystem } from './persona';
import { resolveOfficialTarget } from './provider-adapters';
import { safeRequestParameters } from './request-parameters';
import { renderTemplate, templateValues } from './template';
import type { CotAuditV2, CotAuditTarget } from './types';

export type BuiltChatRequest = {
  baseUrl: string; messages: ChatMessage[]; requestParameters: Record<string, unknown>;
  audit: CotAuditV2;
};

/** Capture once per send. Configuration edits during generation affect only the next turn. */
export function buildRequestMessages(model: ModelRecord, data: CompanionData, history: ChatMessage[], date = new Date()): BuiltChatRequest {
  const mode = model.cotMode;
  if (!['off', 'official', 'instruction', 'persona'].includes(mode)) throw new CotConfigurationError('此配置使用已停用的旧模式，请重新应用思维配置。');
  let renderedPrefix = '';
  let templateId: string | null = null;
  let templateName: string | null = null;
  const warnings: string[] = [];
  let target: CotAuditTarget = 'none';
  const config = getModelThinkingConfig(model);
  let applied: ThinkingDraft | null = null;
  if (mode !== 'off') {
    try { assertModelThinkingConfig(config); } catch { throw new CotConfigurationError('模型思维配置格式异常，请重新应用。'); }
    applied = config[mode].applied;
    if (!applied) throw new CotConfigurationError('此模式尚未应用或绑定已失效，请重新应用到当前模型。');
    const bindingId = applied.templateId;
    const template = bindingId === null ? undefined : data.thinking.templates.find((item) => item.id === bindingId);
    if (bindingId !== null && !template) throw new CotConfigurationError('绑定的模板已不存在，请重新选择。');
    if (template?.enabled === false) throw new CotConfigurationError('绑定的模板已停用，请启用模板或重新选择。');
    if (template && !templateMatchesMode(template, mode)) throw new CotConfigurationError('绑定模板的用途与当前模式不匹配，请重新应用配置。');
    const rendered = renderTemplate(template?.prompt ?? applied.text, templateValues(data, date));
    if (!rendered.text.trim() || rendered.text.length > 32768) throw new CotConfigurationError('提示词不能为空，渲染后最多 32768 个字符。');
    renderedPrefix = rendered.text;
    templateId = template?.id ?? null;
    templateName = template?.name ?? null;
    warnings.push(...rendered.warnings);
  }
  const system = buildPersonaSystem(data, mode === 'persona' ? renderedPrefix : '');
  if (system.length > 131072) throw new CotConfigurationError('人设与记忆内容过长，请精简后再发送。');
  const messages: ChatMessage[] = [{ role: 'system', content: system },
    ...history.filter((message) => message.role !== 'system').map(({ role, content }) => ({ role, content }))];
  let baseUrl = model.baseUrl;
  let requestParameters: Record<string, unknown> = {};
  if (mode === 'official' && applied) {
    const official = resolveOfficialTarget(model, applied.parametersJson);
    baseUrl = official.baseUrl;
    requestParameters = safeRequestParameters(official.requestParameters);
    messages.push({ role: 'assistant', content: '', reasoning_content: renderedPrefix, prefix: true });
    target = 'reasoning_content';
    warnings.push('官方协议已按文档接入，真实账号兼容性尚未验证。');
  } else if (mode === 'instruction' && applied) {
    if (applied.placement === 'system-start') messages[0] = { ...messages[0], content: `${renderedPrefix}\n\n${messages[0].content}` };
    else if (applied.placement === 'user-prefix' && messages.at(-1)?.role === 'user') {
      const last = messages.length - 1;
      messages[last] = { ...messages[last], content: `${renderedPrefix}\n\n${messages[last].content}` };
    } else throw new CotConfigurationError('当前提问或指令注入位置无效，请重新应用配置。');
    target = applied.placement;
  } else if (mode === 'persona') {
    target = 'system-end';
  }
  if (messages[0].content.length > 131072) throw new CotConfigurationError('人设与指令内容过长，请精简后再发送。');
  return { baseUrl, messages, requestParameters,
    audit: { version: 2, requestedMode: mode, effectiveMode: mode, target, legacySnapshot: null,
      templateId, templateName, renderedPrefix, warnings,
      nativeParameters: Object.keys(requestParameters).length ? requestParameters : null,
      modelName: model.name, provider: model.provider, apiModel: model.apiModel, baseUrl } };
}
