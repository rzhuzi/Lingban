import { AppIcon as Ionicons } from '@/components/app-icon';
import { useState } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';

import { Card, DetailScreen, Field, Sheet, SmallAction, useConfirmation } from '@/components/customization-ui';
import { ThemedText } from '@/components/themed-text';
import { Typography } from '@/constants/typography';
import { useTheme } from '@/hooks/use-theme';
import { useAppMaintenanceStore, useCotStore } from '@/stores/app-stores';
import { createId } from './defaults';
import { THINKING_CONTENT_MODES, THINKING_MODE_LABELS } from './thinking-config';
import type { PromptTemplate } from './types';

export function TemplateLibraryScreen() {
  const theme = useTheme();
  const templates = useCotStore((state) => state.thinking.templates);
  const maintenance = useAppMaintenanceStore((state) => state.active);
  const [draft, setDraft] = useState<PromptTemplate | null>(null);
  const [baseline, setBaseline] = useState<PromptTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirmation();
  function edit(template?: PromptTemplate) {
    setError(null); setBaseline(template ? { ...template } : null);
    setDraft(template ? { ...template } : { id: createId(), name: '', description: '', prompt: '', icon: 'sparkles', kind: 'instruction', enabled: true });
  }
  function save() {
    if (!draft || maintenance) return;
    const next = { ...draft, name: draft.name.trim(), prompt: draft.prompt.trim() };
    if (!next.name || !next.prompt) { setError('填写名称和模板内容后保存。'); return; }
    const latest = useCotStore.getState().thinking.templates;
    const stored = latest.find((template) => template.id === draft.id);
    if (baseline && JSON.stringify(stored) !== JSON.stringify(baseline)) { setError('模板已在其他页面更新，请重新打开后编辑。'); return; }
    useCotStore.getState().updateThinking({ templates: stored ? latest.map((template) => template.id === next.id ? next : template) : [...latest, next] });
    setDraft(null);
  }
  return <DetailScreen title="模板库" right={<SmallAction label="新建" icon="add" onPress={() => { if (!maintenance) edit(); }} />}>
    <ThemedText style={styles.hint} themeColor="textSecondary">在角色配置中复制使用，修改模板不影响角色已保存的内容。</ThemedText>
    {templates.map((template) => <Card key={template.id}>
      <Pressable accessibilityRole="button" accessibilityLabel={`编辑模板：${template.name}`} disabled={maintenance}
        onPress={() => edit(template)} style={styles.row}>
        <View style={styles.icon}><Ionicons name="book-outline" size={19} color={theme.textSecondary} /></View>
        <View style={styles.copy}><ThemedText numberOfLines={1} style={styles.name}>{template.name}</ThemedText>
          <ThemedText numberOfLines={1} style={styles.hint} themeColor="textSecondary">{template.kind && template.kind !== 'unclassified' ? THINKING_MODE_LABELS[template.kind] : '普通提示词'}{template.enabled === false ? ' · 已停用' : ''}</ThemedText></View>
        <Ionicons name="chevron-forward" size={17} color={theme.textSecondary} />
      </Pressable>
    </Card>)}
    {!templates.length ? <ThemedText style={styles.hint} themeColor="textSecondary">还没有模板。</ThemedText> : null}
    <Sheet visible={draft !== null} title={baseline ? '编辑模板' : '新建模板'} onClose={() => setDraft(null)} onSave={save}
      saveDisabled={maintenance || !draft?.name.trim() || !draft?.prompt.trim()}>
      <Field label="名称" value={draft?.name ?? ''} onChangeText={(name) => setDraft((value) => value ? { ...value, name } : value)} maxLength={80} />
      <View style={[styles.modes, { backgroundColor: theme.backgroundElement }]}>{THINKING_CONTENT_MODES.map((mode) => <Pressable key={mode}
        accessibilityRole="radio" accessibilityLabel={`模板用途：${THINKING_MODE_LABELS[mode]}`} accessibilityState={{ checked: draft?.kind === mode }}
        onPress={() => setDraft((value) => value ? { ...value, kind: mode } : value)}
        style={[styles.mode, { backgroundColor: draft?.kind === mode ? theme.primaryStrong : 'transparent' }]}>
        <ThemedText style={[styles.modeText, { color: draft?.kind === mode ? theme.onPrimary : theme.textSecondary }]}>{THINKING_MODE_LABELS[mode]}</ThemedText>
      </Pressable>)}</View>
      <Field label="模板内容" multiline value={draft?.prompt ?? ''} maxLength={4000} style={styles.prompt}
        onChangeText={(prompt) => setDraft((value) => value ? { ...value, prompt } : value)} />
      <View style={styles.between}><ThemedText style={styles.hint}>可供角色选用</ThemedText>
        <Switch accessibilityLabel="模板可供角色选用" value={draft?.enabled !== false} trackColor={{ true: theme.primary, false: theme.border }} thumbColor={theme.onPrimary}
          onValueChange={(enabled) => setDraft((value) => value ? { ...value, enabled } : value)} /></View>
      {baseline ? <SmallAction label="删除模板" icon="trash-outline" tone="danger" onPress={() => confirm({ title: '删除模板？',
        message: '角色中已经复制保存的内容会保留。', confirmLabel: '删除', destructive: true, onConfirm: () => {
          if (maintenance || !draft) return;
          useCotStore.getState().updateThinking({ templates: useCotStore.getState().thinking.templates.filter((template) => template.id !== draft.id) });
          setDraft(null);
        } })} /> : null}
      {error ? <ThemedText accessibilityRole="alert" style={[styles.hint, { color: theme.danger }]}>{error}</ThemedText> : null}
    </Sheet>
    {dialog}
  </DetailScreen>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 11, minHeight: 48 }, icon: { width: 26, height: 32, alignItems: 'center', justifyContent: 'center' },
  copy: { flex: 1, minWidth: 0, gap: 3 }, name: { ...Typography.rowTitle }, hint: { ...Typography.secondary },
  modes: { flexDirection: 'row', alignItems: 'stretch', borderRadius: 12, gap: 4, padding: 4 }, mode: { flex: 1, minWidth: 0, minHeight: 64, borderRadius: 9, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 5, paddingVertical: 10 },
  modeText: { ...Typography.compact, textAlign: 'center' }, prompt: { ...Typography.input, minHeight: 175, textAlignVertical: 'top' },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
