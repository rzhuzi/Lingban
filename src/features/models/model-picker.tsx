import { Typography } from '@/constants/typography';
import { AppIcon as Ionicons } from '@/components/app-icon';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Sheet, SmallAction } from '@/components/customization-ui';
import { ThemedText } from '@/components/themed-text';
import { useChatRole } from '@/features/chat/use-chat-role';
import { createRoleModelConfiguration, getRoleConfiguration, getRoleModelConfiguration } from '@/features/companion/role-config';
import { THINKING_MODE_LABELS } from '@/features/companion/thinking-config';
import { useTheme } from '@/hooks/use-theme';
import { useChatRuntimeStore } from '@/lib/chat/runtime';
import { useAppMaintenanceStore, useCotStore, useModelStore, usePersonaStore, useSettingsStore } from '@/stores/app-stores';
import { ModelCleanupWarning } from './model-cleanup-warning';

export function ModelPicker({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useTheme();
  const { role } = useChatRole();
  const models = useModelStore((state) => state.models);
  const personaBusy = usePersonaStore((state) => state.busy);
  const sending = useChatRuntimeStore((state) => state.isSending || state.hasUnsaved);
  const maintenance = useAppMaintenanceStore((state) => state.active);
  const [selectedId, setSelectedId] = useState(role?.configuration?.currentModelId ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const baseline = useRef(role);
  const locked = personaBusy || sending || maintenance || saving;
  const settings = useSettingsStore((state) => state.settings);
  const globalThinking = useCotStore((state) => state.thinking);
  const configuration = role ? getRoleConfiguration(role, settings, globalThinking.variables) : null;

  async function save() {
    if (locked || pending.current || !role || !selectedId || !configuration) return;
    if (!configuration.confirmed) { openRole(); return; }
    pending.current = true; setSaving(true); setError(null);
    try {
      const next = { ...configuration, currentModelId: selectedId, models: { ...configuration.models,
        [selectedId]: getRoleModelConfiguration(configuration, selectedId) } };
      await usePersonaStore.getState().saveRole({ ...role, configuration: next }, baseline.current);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '切换失败，请重试。');
    } finally { pending.current = false; setSaving(false); }
  }
  function openRole(addModel = false) {
    if (pending.current || !role) return;
    onClose();
    router.push({ pathname: '/role', params: { id: role.id, ...(addModel ? { addModel: '1' } : { section: 'thinking' }), ...(selectedId ? { modelId: selectedId } : {}) } });
  }
  function manageModels() {
    if (locked) return;
    onClose(); router.push('/models');
  }
  return <Sheet visible={visible} title={role ? `为${role.profile.name}选择模型` : '选择模型'}
    onClose={() => { if (!pending.current) onClose(); }} saveLabel={saving ? '保存中…' : '完成'}
    onSave={() => { void save(); }} saveDisabled={locked || !selectedId || !role}
    footer={<View style={styles.actions}>
      <SmallAction label="配置思维方式" icon="sparkles-outline" onPress={() => { if (!locked) openRole(); }} />
      <SmallAction label="模型库" icon="options-outline" tone="muted" onPress={manageModels} />
    </View>}>
    <ModelCleanupWarning />
    {!role?.configuration?.confirmed ? <ThemedText style={styles.detail} themeColor="textSecondary">先在角色页确认模型与思维配置，保存后即可聊天。</ThemedText> : null}
    {models.map((model) => {
      const selected = model.id === selectedId;
      const mode = configuration?.confirmed ? getRoleModelConfiguration(configuration, model.id).mode : createRoleModelConfiguration(model, globalThinking).mode;
      return <Pressable key={model.id} accessibilityRole="radio" accessibilityLabel={`选择模型：${model.name}`}
        accessibilityState={{ checked: selected, disabled: locked }} disabled={locked}
        onPress={() => { setSelectedId(model.id); setError(null); }}
        style={({ pressed }) => [styles.model, { backgroundColor: pressed ? theme.backgroundElement : 'transparent',
          borderColor: theme.border, opacity: pressed || locked ? 0.6 : 1 }]}>
        <View style={styles.icon}><Ionicons name="cube-outline" size={20} color={theme.text} /></View>
        <View style={styles.identity}>
          <ThemedText numberOfLines={1} style={styles.name}>{model.name}</ThemedText>
          <ThemedText numberOfLines={1} themeColor="textSecondary" style={styles.detail}>思维配置：{THINKING_MODE_LABELS[mode]}</ThemedText>
        </View>
        <Ionicons name={selected ? 'checkmark' : 'chevron-forward'} size={selected ? 18 : 14} color={selected ? theme.primary : theme.textSecondary} />
      </Pressable>;
    })}
    {!models.length ? <ThemedText style={styles.detail} themeColor="textSecondary">还没有模型，可在角色配置中直接添加。</ThemedText> : null}
    <SmallAction label="添加模型" icon="add" onPress={() => { if (!locked) openRole(true); }} />
    {error ? <ThemedText accessibilityRole="alert" style={[styles.detail, { color: theme.danger }]}>{error}</ThemedText> : null}
  </Sheet>;
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  model: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 13, paddingHorizontal: 2, minHeight: 66, borderBottomWidth: StyleSheet.hairlineWidth },
  icon: { width: 26, height: 34, justifyContent: 'center', alignItems: 'center' },
  identity: { flex: 1, minWidth: 0, gap: 2 }, name: { ...Typography.rowTitle }, detail: { ...Typography.secondary },
});
