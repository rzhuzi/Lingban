import { StyleSheet, View } from 'react-native';

import { Sheet } from '@/components/customization-ui';
import { ThemedText } from '@/components/themed-text';
import { Typography } from '@/constants/typography';
import { THINKING_MODE_LABELS } from '@/features/companion/thinking-config';
import type { LegacyThinkingMode } from '@/features/companion/types';
import { useTheme } from '@/hooks/use-theme';
import type { CotAudit, CotAuditTarget } from '@/lib/cot/types';
import type { MessageRecord } from '@/lib/db/types';

const legacyLabels: Record<LegacyThinkingMode, string> = {
  off: '关闭', native: '旧原生参数配置', prefill: '旧正文前缀续写', persona: '普通提示词（旧人设注入）',
};
const targetLabels: Record<CotAuditTarget, string> = {
  none: '无额外注入', reasoning_content: '末尾 assistant.reasoning_content',
  'system-start': '系统提示词最前', 'user-prefix': '本次 user 消息之前', 'system-end': '系统提示词追加',
};

function AuditField({ label, value }: { label: string; value: string }) {
  return <View style={styles.field}><ThemedText themeColor="textSecondary" style={styles.label}>{label}</ThemedText><ThemedText selectable style={styles.value}>{value}</ThemedText></View>;
}

function ConfigurationDetails({ audit }: { audit: CotAudit }) {
  const theme = useTheme();
  const label = audit.version === 1 ? legacyLabels[audit.effectiveMode] : THINKING_MODE_LABELS[audit.effectiveMode];
  const requested = audit.version === 1 ? legacyLabels[audit.requestedMode] : THINKING_MODE_LABELS[audit.requestedMode];
  return <>
    <AuditField label="使用模式" value={label} />
    {audit.requestedMode !== audit.effectiveMode ? <AuditField label="选择模式" value={requested} /> : null}
    {audit.version === 2 ? <AuditField label="注入位置" value={targetLabels[audit.target]} /> : null}
    <AuditField label="模型" value={`${audit.modelName} · ${audit.apiModel}`} />
    <AuditField label="服务地址" value={audit.baseUrl} />
    <AuditField label="当时模板" value={audit.version === 1 && ['off', 'native'].includes(audit.effectiveMode)
      || audit.version === 2 && audit.effectiveMode === 'off' ? '未使用' : audit.templateName ?? audit.templateId ?? '已应用内联文本'} />
    {audit.renderedPrefix ? <AuditField label={audit.version === 1 ? '升级前发送的前缀文本' : audit.effectiveMode === 'official' ? '发送时的思考前缀（配置输入）' : '发送时的配置文本'} value={audit.renderedPrefix} /> : null}
    {audit.nativeParameters !== null ? <AuditField label="发送时的接口参数" value={JSON.stringify(audit.nativeParameters, null, 2)} /> : null}
    {audit.warnings.map((warning, index) => <ThemedText key={`${index}-${warning}`} style={[styles.warning, { color: theme.primary }]}>{warning}</ThemedText>)}
  </>;
}

export function AuditSheet({ message, visible, onClose }: { message: MessageRecord; visible: boolean; onClose: () => void }) {
  const theme = useTheme();
  const audit = message.cotAudit;
  const legacy = audit?.version === 2 ? audit.legacySnapshot : null;
  const originalAttempt = audit?.version === 2 ? audit.originalAttempt : null;
  return <Sheet title="本条回复配置" visible={visible} onClose={onClose}>
    {audit ? <ConfigurationDetails audit={audit} /> : <>
      <AuditField label="使用模式" value={message.thinkingMode ? THINKING_MODE_LABELS[message.thinkingMode] : legacyLabels[message.cotMode]} />
      {message.modelId ? <AuditField label="模型标识" value={message.modelId} /> : null}
      {message.cotPresetId ? <AuditField label="模板标识" value={message.cotPresetId} /> : null}
      <ThemedText themeColor="textSecondary" style={styles.value}>此消息没有保存详细配置快照。</ThemedText>
    </>}
    {originalAttempt ? <View style={[styles.legacy, { borderColor: theme.border }]}>
      <ThemedText accessibilityRole="header" style={styles.legacyTitle}>首次尝试的配置</ThemedText>
      <ConfigurationDetails audit={originalAttempt} />
    </View> : null}
    {legacy ? <View style={[styles.legacy, { borderColor: theme.border }]}>
      <ThemedText accessibilityRole="header" style={styles.legacyTitle}>升级前原始配置</ThemedText>
      <AuditField label="原记录模式" value={legacyLabels[legacy.cotMode]} />
      {legacy.modelId ? <AuditField label="原模型标识" value={legacy.modelId} /> : null}
      {legacy.cotPresetId ? <AuditField label="原模板标识" value={legacy.cotPresetId} /> : null}
      {legacy.audit ? <ConfigurationDetails audit={legacy.audit} /> : <ThemedText themeColor="textSecondary" style={styles.value}>旧消息没有详细配置快照，以上标识按原样保留。</ThemedText>}
    </View> : null}
  </Sheet>;
}

const styles = StyleSheet.create({
  field: { gap: 5 }, label: { ...Typography.label },
  value: { ...Typography.body }, warning: { ...Typography.secondary },
  legacy: { gap: 15, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 16 }, legacyTitle: { ...Typography.section },
});
