export const AUDIT_RECOVERY_NOTICE = '个别历史消息的配置快照已忽略，聊天正文和会话已保留。';

/** Retain earlier recovery information without accumulating the same notice on every launch. */
export function withAuditRecoveryNotice(notice: string | null): string {
  return notice?.includes(AUDIT_RECOVERY_NOTICE) ? notice
    : [notice, AUDIT_RECOVERY_NOTICE].filter(Boolean).join('\n');
}
