import { CotConfigurationError } from '../../lib/cot/errors';
import { resolveOfficialTarget } from '../../lib/cot/provider-adapters';
import { safeRequestParameters } from '../../lib/cot/request-parameters';
import type { ModelRecord } from '../../lib/db/types';

type NativeThinkingModel = Pick<ModelRecord, 'provider' | 'baseUrl' | 'apiModel'>;

function isEmptyObject(rawJson: string): boolean {
  try {
    const value: unknown = JSON.parse(rawJson);
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
  } catch { return false; }
}

/** The editor represents automatic defaults as a blank field, preserving every custom draft verbatim. */
export function editableNativeParameters(rawJson: string): string {
  return isEmptyObject(rawJson) ? '' : rawJson;
}

export type OfficialThinkingPreview = {
  state: 'no-model' | 'needs-prefix' | 'ready' | 'error';
  baseUrl: string | null;
  parameters: Record<string, unknown> | null;
  assistant: { role: 'assistant'; content: ''; prefix: true; reasoning_content: string } | null;
  message: string | null;
};

/** Preview uses the same official endpoint/parameter adapter as actual requests. */
export function previewOfficialThinking(model: NativeThinkingModel | undefined, prefix: string, rawJson: string): OfficialThinkingPreview {
  if (!model) return { state: 'no-model', baseUrl: null, parameters: null, assistant: null, message: '请先选择目标模型。' };
  try {
    const target = resolveOfficialTarget(model, rawJson);
    const parameters = safeRequestParameters(target.requestParameters);
    if (!prefix.trim()) return { state: 'needs-prefix', baseUrl: target.baseUrl, parameters, assistant: null,
      message: '请填写思考前缀，保存草稿不会启用此配置。' };
    return { state: 'ready', baseUrl: target.baseUrl, parameters,
      assistant: { role: 'assistant', content: '', prefix: true, reasoning_content: prefix }, message: null };
  } catch (error) {
    return { state: 'error', baseUrl: null, parameters: null, assistant: null,
      message: error instanceof CotConfigurationError ? error.message : '无法预览官方配置，请检查目标模型后重试。' };
  }
}
