import { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import { AppIcon } from '@/components/app-icon';
import { Sheet } from '@/components/customization-ui';
import { ThemedText } from '@/components/themed-text';
import { Typography } from '@/constants/typography';
import { useTheme } from '@/hooks/use-theme';
import type { ModelRecord } from '@/lib/db/types';

import { findInstructionPreset, getInstructionPresetCompatibility, INSTRUCTION_PRESETS, type InstructionPreset } from './instruction-presets';
import type { ThinkingDraft } from './types';

export function InstructionPresetPicker({ visible, onClose, model, value, disabled, onSelect }: {
  visible: boolean; onClose: () => void; model?: ModelRecord; value: ThinkingDraft; disabled: boolean;
  onSelect: (preset: InstructionPreset) => void;
}) {
  const theme = useTheme();
  const [selectedId, setSelectedId] = useState<string | null>(() => findInstructionPreset(value.text, value.placement)?.id ?? null);
  const [showList, setShowList] = useState(() => !findInstructionPreset(value.text, value.placement));
  const [showText, setShowText] = useState(false);
  const [linkError, setLinkError] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const selected = INSTRUCTION_PRESETS.find((item) => item.id === selectedId);
  const compatibility = selected ? getInstructionPresetCompatibility(selected, model) : null;
  const active = useRef({ visible, disabled, model, selected, onSelect, showList });
  useEffect(() => { active.current = { visible, disabled, model, selected, onSelect, showList }; }, [visible, disabled, model, selected, onSelect, showList]);
  const replace = !!value.text.trim() && selected?.prompt !== value.text;
  const fill = () => {
    const current = active.current;
    if (!alive.current || !current.visible || current.disabled || !current.model || !current.selected || current.showList) return;
    current.onSelect(current.selected);
  };
  async function openSource() {
    const current = active.current;
    const selected = current.selected;
    if (!alive.current || !current.visible || !selected?.sourceUrl) return;
    const sourceId = selected.id;
    const sourceUrl = selected.sourceUrl;
    try { await Linking.openURL(sourceUrl); }
    catch { if (alive.current && active.current.selected?.id === sourceId) setLinkError(true); }
  }

  return <Sheet visible={visible} title="第三方指令预设" onClose={onClose}
    onSave={fill} saveLabel={replace ? '替换当前指令' : '填入当前指令'} saveDisabled={disabled || !model || !selected || showList}>
    <ThemedText themeColor="textSecondary" style={s.note}>{model ? `当前模型：${model.name} · ${model.apiModel}` : '请先为角色选择模型。'}</ThemedText>
    {showList ? <View style={[s.list, { borderColor: theme.border }]}>
      {INSTRUCTION_PRESETS.map((item, index) => <Pressable key={item.id} accessibilityRole="radio"
        accessibilityLabel={'选择指令预设：' + item.name} accessibilityState={{ checked: item.id === selectedId, disabled }} disabled={disabled}
        onPress={() => { if (!active.current.visible || active.current.disabled) return; setSelectedId(item.id); setShowList(false); setShowText(false); setLinkError(false); }}
        style={[s.row, index > 0 && s.divider, { borderColor: theme.border, backgroundColor: item.id === selectedId ? theme.primarySurface : 'transparent' }]}>
        <View style={s.flex}><ThemedText style={s.name}>{item.name}</ThemedText><ThemedText themeColor="textSecondary" style={s.note}>{item.summary}</ThemedText></View>
        <AppIcon name={item.id === selectedId ? 'checkmark-circle' : 'ellipse-outline'} size={18} color={item.id === selectedId ? theme.primary : theme.textSecondary} />
      </Pressable>)}
    </View> : <Pressable accessibilityRole="button" accessibilityLabel="重新选择指令预设" onPress={() => setShowList(true)} style={s.action}>
      <ThemedText style={[s.note, { color: theme.primary }]}>重新选择</ThemedText>
    </Pressable>}
    {!showList && selected && compatibility ? <View style={[s.details, { backgroundColor: theme.backgroundElement }]}>
      <ThemedText style={s.name}>{selected.name}</ThemedText>
      <ThemedText style={[s.status, { color: theme.primary }]}>{compatibility.label}</ThemedText>
      <ThemedText themeColor="textSecondary" style={s.note}>{compatibility.detail}</ThemedText>
      <ThemedText style={s.note}>适用模型：{selected.modelScope}</ThemedText>
      <ThemedText style={s.note}>怎么用：{selected.usage}</ThemedText>
      <ThemedText style={s.note}>当前插入：{selected.placement === 'system-start' ? '系统提示词最前' : '本次用户消息之前'}</ThemedText>
      <ThemedText themeColor="textSecondary" style={s.note}>{selected.caveat}</ThemedText>
      <ThemedText themeColor="textSecondary" style={s.note}>{selected.provenance === 'source-excerpt' ? '官方模型文档中的软指令' : selected.provenance === 'protocol-example' ? '模型对话模板标记' : '社区或自定义写法，未核实官方支持'}</ThemedText>
      <View style={s.actions}>
        <Pressable accessibilityRole="button" accessibilityLabel={showText ? '收起预设内容' : '查看预设内容'} onPress={() => setShowText(!showText)} style={s.action}>
          <ThemedText style={[s.note, { color: theme.primary }]}>{showText ? '收起内容' : '查看内容'}</ThemedText>
        </Pressable>
        {selected.sourceUrl && selected.sourceLabel ? <Pressable accessibilityRole="link" accessibilityLabel={'查看预设来源：' + selected.sourceLabel} onPress={() => { void openSource(); }} style={s.action}>
          <ThemedText style={[s.note, { color: theme.primary }]}>查看来源</ThemedText>
        </Pressable> : null}
      </View>
      {showText ? <ThemedText selectable style={[s.prompt, { backgroundColor: theme.surface }]}>{selected.prompt}</ThemedText> : null}
      {linkError ? <ThemedText accessibilityRole="alert" style={[s.note, { color: theme.danger }]}>暂时无法打开来源，请稍后重试。</ThemedText> : null}
    </View> : <ThemedText themeColor="textSecondary" style={s.note}>先选择一项，查看用途、适用模型和使用方式。</ThemedText>}
    <ThemedText themeColor="textSecondary" style={s.note}>协议标记按普通消息文本插入；不会改变 API 的角色结构或 assistant 续写位置。</ThemedText>
    <ThemedText themeColor="textSecondary" style={s.note}>{replace ? '将替换当前指令文本和插入位置。' : '填入后仍可编辑。'}保存角色后生效；真实模型效果待验证。</ThemedText>
  </Sheet>;
}

const s = StyleSheet.create({
  list: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 8, paddingVertical: 13, minHeight: 62 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth }, flex: { flex: 1, minWidth: 0 },
  name: { ...Typography.rowTitle }, note: { ...Typography.secondary },
  details: { borderRadius: 10, padding: 14, gap: 9 }, status: { ...Typography.compact },
  actions: { flexDirection: 'row', gap: 24 }, action: { minHeight: 38, justifyContent: 'center' },
  prompt: { ...Typography.code, fontFamily: 'monospace', padding: 12, borderRadius: 8 },
});
