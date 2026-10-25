import { AppIcon as Ionicons } from '@/components/app-icon';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Card, Chip, Field, SectionHeading, SmallAction } from '@/components/customization-ui';
import { ThemedText } from '@/components/themed-text';
import { Typography } from '@/constants/typography';
import { useTheme } from '@/hooks/use-theme';
import type { ModelRecord } from '@/lib/db/types';

import { editableNativeParameters, previewOfficialThinking } from './native-thinking';

function jsonError(value: string) {
  try {
    const parsed: unknown = JSON.parse(value.trim() ? value : '{}');
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? null : '参数需为 JSON 对象；草稿未保存，已应用配置保持不变。';
  } catch { return 'JSON 格式不正确；草稿未保存，已应用配置保持不变。'; }
}

export function NativeThinkingCard({ model, prefix = '', parameters, onChange, active = false, parameterDraft, onDraftChange, disabled = false }: {
  model?: ModelRecord; prefix?: string; parameters: string; onChange: (parameters: string) => void;
  active?: boolean; parameterDraft?: string | null; onDraftChange?: (draft: string | null) => void; disabled?: boolean;
}) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [localDraft, setLocalDraft] = useState<string | null>(null);
  const draft = parameterDraft === undefined ? localDraft : parameterDraft;
  const value = draft ?? editableNativeParameters(parameters);
  const error = jsonError(value);
  const preview = previewOfficialThinking(model, prefix, parameters);
  const supported = preview.state === 'ready' || preview.state === 'needs-prefix';
  const setDraft = (next: string | null) => { if (onDraftChange) onDraftChange(next); else setLocalDraft(next); };
  const edit = (next: string) => {
    if (disabled) return;
    if (jsonError(next)) setDraft(next);
    else { setDraft(null); onChange(next.trim() ? next : '{}'); }
  };
  let effort: unknown;
  try { effort = JSON.parse(parameters).reasoning_effort; } catch { /* Saved validation errors are displayed by the adapter. */ }

  return <Card>
    <SectionHeading title="官方请求预览" />
    <View style={styles.status}>
      <Ionicons name={supported ? 'information-circle-outline' : 'alert-circle-outline'} color={theme.textSecondary} size={20} />
      <ThemedText style={styles.statusTitle}>{supported ? '文档已接入 · 实际效果待联调' : model ? '当前版本未接入或配置不可用' : '待选择目标模型'}</ThemedText>
    </View>
    <ThemedText themeColor="textSecondary" style={styles.note}>{active ? '此模型已启用官方模式；以下为正在编辑的草稿。' : '此模型当前未启用官方模式。'}</ThemedText>
    {preview.message ? <ThemedText accessibilityRole="alert" style={[styles.note, { color: theme.textSecondary }]}>{preview.message}</ThemedText> : null}
    {preview.baseUrl ? <ThemedText selectable style={styles.note}>{preview.baseUrl}/chat/completions</ThemedText> : null}
    {preview.assistant ? <>
      <ThemedText themeColor="textSecondary" style={styles.note}>人设与历史 → 本次提问 → 末尾专用 assistant</ThemedText>
      <ThemedText selectable accessibilityLabel="官方末消息预览" style={[styles.parameters, { backgroundColor: theme.backgroundElement, color: theme.textSecondary }]}>
        {JSON.stringify(preview.assistant, null, 2)}
      </ThemedText>
    </> : null}
    {preview.parameters ? <ThemedText selectable accessibilityLabel="官方接口参数预览" style={[styles.parameters, { backgroundColor: theme.backgroundElement, color: theme.textSecondary }]}>
      {JSON.stringify(preview.parameters, null, 2)}
    </ThemedText> : null}
    {supported ? <View style={styles.effort}>
      <ThemedText themeColor="textSecondary" style={styles.note}>思考已开启 · 强度</ThemedText>
      <View style={styles.chips}>{['默认', 'low', 'high', 'max'].map((item) => <Chip key={item} label={item} selected={item === '默认' ? effort === undefined : effort === item}
        onPress={disabled ? undefined : () => {
          try {
            const next = JSON.parse(parameters);
            if (item === '默认') delete next.reasoning_effort;
            else next.reasoning_effort = item;
            setDraft(null);
            onChange(JSON.stringify(next));
          } catch { /* Leave invalid drafts available for correction. */ }
        }} />)}</View>
    </View> : null}
    <Pressable accessibilityRole="button" accessibilityLabel="高级接口参数" accessibilityState={{ expanded }}
      onPress={() => setExpanded(!expanded)} style={[styles.advanced, { borderColor: theme.border }]}>
      <ThemedText style={styles.advancedLabel}>高级接口参数</ThemedText>
      <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={theme.textSecondary} />
    </Pressable>
    {expanded ? <View style={styles.editor}>
      <ThemedText themeColor="textSecondary" style={styles.note}>仅保存此目标模型的官方参数草稿。留空使用协议默认值；应用后用于之后的请求。</ThemedText>
      <Field label="参数覆盖（JSON）" accessibilityLabel="官方参数 JSON" value={value} onChangeText={edit} editable={!disabled}
        autoCapitalize="none" autoCorrect={false} multiline maxLength={4000} placeholder="可选：填写接口参数" style={styles.input} />
      <ThemedText accessibilityRole={error ? 'alert' : undefined} style={[styles.note, { color: error ? theme.danger : theme.textSecondary }]}>
        {error ?? '有效 JSON 自动保存为草稿，明确应用后才替换已应用配置。'}
      </ThemedText>
      {value || draft !== null ? <SmallAction label="清除参数覆盖" icon="refresh-outline" onPress={() => { if (!disabled) { setDraft(null); onChange('{}'); } }} /> : null}
    </View> : null}
  </Card>;
}

const styles = StyleSheet.create({
  status: { flexDirection: 'row', alignItems: 'center', gap: 8 }, statusTitle: { ...Typography.label, flex: 1 },
  note: { ...Typography.secondary },
  parameters: { ...Typography.code, fontFamily: 'monospace', padding: 12, borderRadius: 10 },
  advanced: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12, minHeight: 38 },
  advancedLabel: { ...Typography.rowTitle }, editor: { gap: 10 }, effort: { gap: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 }, input: { ...Typography.code, minHeight: 120, fontFamily: 'monospace' },
});
