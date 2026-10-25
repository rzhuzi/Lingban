import { CotConfigurationError } from './errors';

const reserved = new Set(['model', 'messages', 'stream', 'maxtokens', 'streamoptions', 'apikey', 'baseurl', 'url', 'headers', 'authorization', 'signal']);

/** Extra body fields may configure a provider, never replace transport, credentials or chat history. */
export function safeRequestParameters(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  let size = 0;
  const fail = () => { throw new CotConfigurationError('原生参数包含不允许的字段或格式，请检查配置。'); };
  function visit(item: unknown, depth: number): unknown {
    if (depth > 16) return fail();
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') return Number.isFinite(item) ? item : fail();
    if (typeof item === 'string') { size += item.length; if (size > 65536) return fail(); return item; }
    if (Array.isArray(item)) { if (item.length > 1000) return fail(); return item.map((entry) => visit(entry, depth + 1)); }
    if (!item || typeof item !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return fail();
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(item)) {
      size += key.length;
      if (size > 65536 || ['__proto__', 'constructor', 'prototype'].includes(key) ||
          (depth === 0 && reserved.has(key.toLowerCase().replace(/[-_]/g, '')))) return fail();
      result[key] = visit(entry, depth + 1);
    }
    return result;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return visit(value, 0) as Record<string, unknown>;
}
