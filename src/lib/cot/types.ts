import type { LegacyThinkingMode, ThinkingMode } from '../../features/companion/types';
import type { ModelRecord } from '../db/types';

/** User-authored request configuration captured before sending, never a credential or provider reply. */
type AuditDetails = {
  templateId: string | null;
  templateName: string | null;
  renderedPrefix: string;
  warnings: string[];
  nativeParameters: Record<string, unknown> | null;
  modelName: string;
  provider: ModelRecord['provider'];
  apiModel: string;
  baseUrl: string;
};

/** Historic modes retain their original meanings when displayed or exported. */
export type CotAuditV1 = AuditDetails & { version: 1; requestedMode: LegacyThinkingMode; effectiveMode: LegacyThinkingMode };
export type LegacyCotSnapshot = {
  cotMode: LegacyThinkingMode; cotPresetId: string | null; modelId: string | null; audit: CotAuditV1 | null;
};
export type CotAuditTarget = 'none' | 'reasoning_content' | 'system-start' | 'user-prefix' | 'system-end';
/** One flat first-attempt snapshot, never a recursively growing retry history. */
export type CotAttemptSnapshot = AuditDetails & {
  version: 2; requestedMode: ThinkingMode; effectiveMode: ThinkingMode; target: CotAuditTarget; modelId: string | null;
};
export type CotAuditV2 = AuditDetails & {
  version: 2; requestedMode: ThinkingMode; effectiveMode: ThinkingMode; target: CotAuditTarget;
  legacySnapshot?: LegacyCotSnapshot | null;
  originalAttempt?: CotAttemptSnapshot | null;
};
export type CotAudit = CotAuditV1 | CotAuditV2;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const legacyMode = (value: unknown) => typeof value === 'string' && ['off', 'native', 'prefill', 'persona'].includes(value);
const mode = (value: unknown) => typeof value === 'string' && ['off', 'official', 'instruction', 'persona'].includes(value);
const nullableString = (value: unknown) => value === null || typeof value === 'string';

function details(audit: Record<string, unknown>): boolean {
  return nullableString(audit.templateId) && nullableString(audit.templateName)
    && typeof audit.renderedPrefix === 'string' && Array.isArray(audit.warnings)
    && audit.warnings.every((warning) => typeof warning === 'string')
    && (audit.nativeParameters === null || (typeof audit.nativeParameters === 'object' && !Array.isArray(audit.nativeParameters)))
    && typeof audit.modelName === 'string' && typeof audit.apiModel === 'string' && typeof audit.baseUrl === 'string'
    && typeof audit.provider === 'string' && ['deepseek', 'moonshot', 'dashscope', 'zhipu', 'custom'].includes(audit.provider);
}
export function isCotAuditV1(value: unknown): value is CotAuditV1 {
  return record(value) && value.version === 1 && legacyMode(value.requestedMode) && legacyMode(value.effectiveMode) && details(value);
}
export function isLegacyCotSnapshot(value: unknown): value is LegacyCotSnapshot {
  return record(value) && legacyMode(value.cotMode) && nullableString(value.cotPresetId) && nullableString(value.modelId)
    && (value.audit === null || (isCotAuditV1(value.audit) && !('legacySnapshot' in value.audit)));
}
const attemptFields = new Set(['version', 'requestedMode', 'effectiveMode', 'target', 'modelId', 'templateId', 'templateName',
  'renderedPrefix', 'warnings', 'nativeParameters', 'modelName', 'provider', 'apiModel', 'baseUrl']);
export function isCotAttemptSnapshot(value: unknown): value is CotAttemptSnapshot {
  if (!record(value) || Object.keys(value).some((key) => !attemptFields.has(key)) || !nullableString(value.modelId)
    || !isCurrentAudit(value) || String(value.renderedPrefix).length > 32768
    || (value.warnings as string[]).length > 128 || (value.warnings as string[]).some((warning) => warning.length > 4096)
    || [value.modelId, value.modelName, value.apiModel, value.baseUrl, value.templateId, value.templateName]
      .some((field) => typeof field === 'string' && field.length > 8192)) return false;
  try { return JSON.stringify(value.nativeParameters).length <= 65536 && JSON.stringify(value).length <= 131072; }
  catch { return false; }
}
function isCurrentAudit(value: Record<string, unknown>): boolean {
  if (value.version !== 2 || !mode(value.requestedMode) || !mode(value.effectiveMode)
    || value.requestedMode !== value.effectiveMode || !details(value)) return false;
  return value.effectiveMode === 'off' ? value.target === 'none'
    : value.effectiveMode === 'official' ? value.target === 'reasoning_content'
      : value.effectiveMode === 'persona' ? value.target === 'system-end'
        : value.target === 'system-start' || value.target === 'user-prefix';
}
export function captureCotAttempt(audit: CotAuditV2, modelId: string | null): CotAttemptSnapshot {
  return { version: 2, requestedMode: audit.requestedMode, effectiveMode: audit.effectiveMode, target: audit.target, modelId,
    templateId: audit.templateId, templateName: audit.templateName, renderedPrefix: audit.renderedPrefix,
    warnings: [...audit.warnings], nativeParameters: audit.nativeParameters === null ? null : JSON.parse(JSON.stringify(audit.nativeParameters)),
    modelName: audit.modelName, provider: audit.provider, apiModel: audit.apiModel, baseUrl: audit.baseUrl };
}
export function isCotAudit(value: unknown): value is CotAudit {
  if (isCotAuditV1(value)) return true;
  return record(value) && isCurrentAudit(value) && (value.legacySnapshot == null || isLegacyCotSnapshot(value.legacySnapshot))
    && (value.originalAttempt == null || isCotAttemptSnapshot(value.originalAttempt));
}
