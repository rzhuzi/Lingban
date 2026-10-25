import { AppIcon as Ionicons } from '@/components/app-icon';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { Sheet, SmallAction } from '@/components/customization-ui';
import { ThemedText } from '@/components/themed-text';
import { Typography } from '@/constants/typography';
import { RoleAvatar } from '@/components/role-avatar';
import { useTheme } from '@/hooks/use-theme';
import { startNewConversation } from '@/lib/chat/engine';
import { useChatRuntimeStore } from '@/lib/chat/runtime';
import { useAppMaintenanceStore, useModelStore, usePersonaStore } from '@/stores/app-stores';
import { useChatRole } from './use-chat-role';

export function RolePicker({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useTheme();
  const { roleId, sessionId } = useChatRole();
  const personas = usePersonaStore((state) => state.personas);
  const activeId = usePersonaStore((state) => state.activePersonaId);
  const personaBusy = usePersonaStore((state) => state.busy);
  const models = useModelStore((state) => state.models);
  const sending = useChatRuntimeStore((state) => state.isSending || state.hasUnsaved);
  const maintenance = useAppMaintenanceStore((state) => state.active);
  const pending = useRef(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locked = sending || maintenance || personaBusy || pendingId !== null;

  async function select(id: string) {
    if (locked || pending.current) return;
    if (id === roleId && id === activeId) {
      onClose();
      if (!personas.find((persona) => persona.id === id)?.configuration?.confirmed) router.push({ pathname: '/role', params: { id } });
      return;
    }
    pending.current = true; setPendingId(id); setError(null);
    try {
      await usePersonaStore.getState().switchPersona(id);
      startNewConversation();
      onClose();
      router.replace('/(tabs)');
      const selected = usePersonaStore.getState().personas.find((persona) => persona.id === id);
      if (!selected?.configuration?.confirmed) router.push({ pathname: '/role', params: { id } });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '切换角色失败，请重试。');
    } finally { pending.current = false; setPendingId(null); }
  }
  function edit(create = false) {
    if (locked) return;
    onClose();
    router.push({ pathname: '/role', params: create ? { create: '1' } : { id: roleId ?? activeId } });
  }
  return <Sheet visible={visible} title="选择角色" onClose={() => { if (!pending.current) onClose(); }} footer={
    <View style={styles.actions}>
      <SmallAction label="新建角色" icon="add" onPress={() => edit(true)} />
      {roleId ? <SmallAction label="编辑当前角色" icon="create-outline" onPress={() => edit()} /> : null}
    </View>
  }>
    {personas.map((persona) => {
      const model = models.find((item) => item.id === persona.configuration?.currentModelId);
      const selected = persona.id === roleId;
      return <Pressable key={persona.id} accessibilityRole="radio" accessibilityLabel={`选择角色：${persona.profile.name}`}
        accessibilityState={{ checked: selected, disabled: locked }} disabled={locked}
        onPress={() => { void select(persona.id); }} style={({ pressed }) => [styles.row,
          { borderColor: theme.border, backgroundColor: pressed ? theme.backgroundElement : 'transparent',
            opacity: pressed || (locked && pendingId !== persona.id) ? 0.6 : 1 }]}>
        <RoleAvatar profile={persona.profile} size={38} />
        <View style={styles.copy}><ThemedText numberOfLines={1} style={styles.name}>{persona.profile.name}</ThemedText>
          <ThemedText numberOfLines={1} style={styles.detail} themeColor="textSecondary">{persona.configuration?.confirmed ? model?.name ?? '模型不可用' : '待确认模型配置'}</ThemedText></View>
        {pendingId === persona.id ? <ActivityIndicator color={theme.primary} size="small" /> : selected ? <Ionicons name="checkmark" color={theme.primary} size={18} /> : null}
      </Pressable>;
    })}
    {sessionId ? <ThemedText themeColor="textSecondary" style={styles.detail}>切换角色后开始新聊天，当前聊天保留在历史中。</ThemedText> : null}
    {error ? <ThemedText accessibilityRole="alert" style={[styles.detail, { color: theme.danger }]}>{error}</ThemedText> : null}
  </Sheet>;
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  row: { minHeight: 76, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 12, paddingHorizontal: 2, flexDirection: 'row', alignItems: 'center', gap: 12 },
  copy: { flex: 1, minWidth: 0, gap: 3 }, name: { ...Typography.rowTitle }, detail: { ...Typography.secondary },
});
