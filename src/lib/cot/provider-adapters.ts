import type { ModelRecord } from '../db/types';

import { CotConfigurationError } from './errors';

type ThinkingModel = Pick<ModelRecord, 'provider' | 'baseUrl' | 'apiModel'>;
export type OfficialThinkingTarget = { baseUrl: string; requestParameters: Record<string, unknown> };

const INVALID_JSON = '原生参数必须是有效的 JSON 对象。';
const INVALID_PARAMETERS = '原生参数包含不支持的字段或取值，请检查配置。';
const UNKNOWN_OFFICIAL = '当前端点或型号的官方思考前缀尚未接入，请选择第三方指令或普通提示词。';
const reserved = new Set(['model', 'messages', 'stream', 'max_tokens', 'max_completion_tokens', 'stream_options',
  'headers', 'body', 'method', 'url', 'baseurl', 'base_url', 'endpoint', 'signal', 'timeout', 'timeoutms',
  'fetch', 'fetchimpl', 'api_key', 'apikey', 'authorization', 'password', 'access_token', 'tools', 'tool_choice', 'n']);
const prototypeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const deepseekModels = new Set(['deepseek-flash', 'deepseek-v4-pro']);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fail(): never { throw new CotConfigurationError(INVALID_PARAMETERS); }
function safeTree(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => safeTree(item, depth + 1));
  if (!object(value)) return true;
  return Object.entries(value).every(([key, item]) => !prototypeKeys.has(key.toLowerCase()) && safeTree(item, depth + 1));
}
function parseParameters(rawJson: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(rawJson); } catch { throw new CotConfigurationError(INVALID_JSON); }
  if (!object(value)) throw new CotConfigurationError(INVALID_JSON);
  if (!safeTree(value) || Object.keys(value).some((key) => reserved.has(key.toLowerCase()))) fail();
  return value;
}
function only(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key))) fail();
}
function thinking(value: unknown): Record<string, unknown> {
  if (!object(value)) fail();
  only(value, ['type']);
  if (value.type !== undefined && (typeof value.type !== 'string' || !['enabled', 'disabled'].includes(value.type))) fail();
  return { type: 'enabled', ...value };
}
function officialUrl(model: ThinkingModel): URL | null {
  try {
    const url = new URL(model.baseUrl.trim());
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch { return null; }
}
function officialEndpoint(model: ThinkingModel): boolean {
  const url = officialUrl(model);
  if (!url) return false;
  const path = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  return model.provider === 'deepseek' && url.hostname === 'api.deepseek.com' && ['', '/v1', '/beta'].includes(path);
}

function officialParameters(rawJson: string): Record<string, unknown> {
  const input = parseParameters(rawJson);
  only(input, ['thinking', 'reasoning_effort']);
  if (input.reasoning_effort !== undefined && (typeof input.reasoning_effort !== 'string'
    || !['none', 'low', 'high', 'max'].includes(input.reasoning_effort))) fail();
  return { ...input, thinking: thinking(input.thinking === undefined ? { type: 'enabled' } : input.thinking) };
}

/** Only this documented official protocol accepts a user-authored reasoning prefix. */
export function resolveOfficialTarget(model: ThinkingModel, rawJson: string): OfficialThinkingTarget {
  if (!officialEndpoint(model) || !deepseekModels.has(model.apiModel)) throw new CotConfigurationError(UNKNOWN_OFFICIAL);
  const requestParameters = officialParameters(rawJson);
  if (!object(requestParameters.thinking) || requestParameters.thinking.type !== 'enabled' || requestParameters.reasoning_effort === 'none') {
    throw new CotConfigurationError('官方思考前缀需要开启思考，请移除关闭思考的冲突参数。');
  }
  return { baseUrl: 'https://api.deepseek.com/beta', requestParameters };
}
