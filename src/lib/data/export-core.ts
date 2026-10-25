import type { CotAudit, CotAttemptSnapshot } from '../cot/types';
import type { AppSnapshot } from '../db/types';

export type ChatExportSnapshot = Pick<AppSnapshot, 'sessions' | 'messages'>;
const credentialFields = new Set(['key', 'apikey', 'apikeyalias', 'keyalias', 'alias', 'authorization', 'headers',
  'accesstoken', 'refreshtoken', 'token', 'password', 'secret', 'credentials', 'credential', 'keychainservice']);

/** Preserve JSON-compatible interface configuration while excluding structured credential fields. */
function exportParameters(value: unknown, depth = 0): unknown {
  if (depth > 16) return null;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((item) => exportParameters(item, depth + 1));
  if (!value || typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value).filter(([key]) => {
    const normalized = key.toLowerCase().replace(/[-_]/g, '');
    return !credentialFields.has(normalized) && !/(apikey|token|secret|password|credential|keyalias)$/.test(normalized)
      && !['__proto__', 'constructor', 'prototype'].includes(key);
  }).map(([key, item]) => [key, exportParameters(item, depth + 1)]));
}
function exportBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.toString();
  } catch { return ''; }
}
function exportAudit(audit: CotAudit | null | undefined): Record<string, unknown> | null {
  if (!audit) return null;
  const details = { version: audit.version, requestedMode: audit.requestedMode, effectiveMode: audit.effectiveMode,
    templateId: audit.templateId, templateName: audit.templateName, renderedPrefix: audit.renderedPrefix,
    warnings: [...audit.warnings], nativeParameters: exportParameters(audit.nativeParameters),
    modelName: audit.modelName, provider: audit.provider, apiModel: audit.apiModel, baseUrl: exportBaseUrl(audit.baseUrl) };
  if (audit.version === 1) return details;
  const legacy = audit.legacySnapshot;
  const original = audit.originalAttempt;
  return { ...details, target: audit.target, ...(original ? { originalAttempt: exportAttempt(original) } : {}), legacySnapshot: legacy ? { cotMode: legacy.cotMode,
    cotPresetId: legacy.cotPresetId, modelId: legacy.modelId, audit: exportAudit(legacy.audit) } : null };
}
function exportAttempt(attempt: CotAttemptSnapshot): Record<string, unknown> {
  // The same field whitelist and parameter filtering apply; unknown nested snapshots are never copied.
  return { version: 2, requestedMode: attempt.requestedMode, effectiveMode: attempt.effectiveMode, target: attempt.target,
    modelId: attempt.modelId, templateId: attempt.templateId, templateName: attempt.templateName,
    renderedPrefix: attempt.renderedPrefix, warnings: [...attempt.warnings], nativeParameters: exportParameters(attempt.nativeParameters),
    modelName: attempt.modelName, provider: attempt.provider, apiModel: attempt.apiModel, baseUrl: exportBaseUrl(attempt.baseUrl) };
}

/** Only these chat fields are exported; models, settings and persona records are never copied. */
export function buildChatExport(snapshot: ChatExportSnapshot, date = new Date()): string {
  const sessionIds = new Set(snapshot.sessions.map((session) => session.id));
  return JSON.stringify({ schemaVersion: 2, app: 'lingban', exportedAt: date.toISOString(),
    sessions: snapshot.sessions.map((session) => ({ id: session.id, title: session.title, modelId: session.modelId,
      personaId: session.personaId, pinned: session.pinned, createdAt: session.createdAt, updatedAt: session.updatedAt })),
    messages: snapshot.messages.filter((message) => sessionIds.has(message.sessionId)).map((message) => ({
      id: message.id, sessionId: message.sessionId, role: message.role, content: message.content, reasoning: message.reasoning,
      status: message.status, error: message.error, cotMode: message.cotMode, thinkingMode: message.thinkingMode ?? null, cotPresetId: message.cotPresetId,
      modelId: message.modelId, createdAt: message.createdAt, cotAudit: exportAudit(message.cotAudit),
    })),
  }, null, 2);
}

export function chatExportFilename(date = new Date()): string {
  return `lingban-chats-${date.toISOString().replace(/[:.]/g, '-')}.json`;
}
