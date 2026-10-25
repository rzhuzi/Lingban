import { captureCotAttempt, isCotAudit } from '../cot/types';
import type { MessageRecord } from './types';

function sameJson(left: unknown, right: unknown): boolean {
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)])) : value;
  return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
}

/** The first pre-upgrade audit survives every later attempt, including final/disk saves. */
export function assertMessageTransition(previous: MessageRecord | null, next: MessageRecord) {
  if (!['off', 'native', 'prefill', 'persona'].includes(next.cotMode)
    || (next.thinkingMode != null && !['off', 'official', 'instruction', 'persona'].includes(next.thinkingMode))) {
    throw new Error('消息思维模式格式异常。');
  }
  if (next.cotAudit != null && !isCotAudit(next.cotAudit)) throw new Error('消息配置快照格式异常。');
  if ((next.cotAudit?.version === 2 && next.thinkingMode !== next.cotAudit.effectiveMode)
    || (next.cotAudit?.version === 1 && next.thinkingMode != null)) throw new Error('消息模式与配置快照版本不一致。');
  if (!previous) return;
  const oldAudit = previous.cotAudit;
  const nextAudit = next.cotAudit;
  if (oldAudit?.version === 2) {
    if (nextAudit?.version !== 2 || !sameJson(oldAudit.legacySnapshot ?? null, nextAudit.legacySnapshot ?? null)) {
      throw new Error('原始历史配置快照不可覆盖。');
    }
    const firstAttempt = oldAudit.originalAttempt;
    if (firstAttempt) {
      if (!sameJson(firstAttempt, nextAudit.originalAttempt)) throw new Error('首次回复配置快照不可覆盖。');
    } else if (nextAudit.originalAttempt != null) {
      if (!sameJson(nextAudit.originalAttempt, captureCotAttempt(oldAudit, previous.modelId))) throw new Error('重试必须保留首次回复配置快照。');
    } else if (!sameJson(captureCotAttempt(oldAudit, previous.modelId), captureCotAttempt(nextAudit, next.modelId))) {
      throw new Error('重试必须保留首次回复配置快照。');
    }
  } else if (previous.thinkingMode == null && nextAudit?.version === 2) {
    const expected = { cotMode: previous.cotMode, cotPresetId: previous.cotPresetId, modelId: previous.modelId,
      audit: oldAudit ?? null };
    if (!sameJson(nextAudit.legacySnapshot, expected)) throw new Error('重试必须保留原始历史配置快照。');
  }
}
