import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { AppIcon } from '@/components/app-icon';
import { Sheet, SmallAction, useConfirmation } from '@/components/customization-ui';
import { RoleAvatar } from '@/components/role-avatar';
import { ThemedText } from '@/components/themed-text';
import { Typography } from '@/constants/typography';
import { useChatRole } from '@/features/chat/use-chat-role';
import { useTheme } from '@/hooks/use-theme';
import { startNewConversation } from '@/lib/chat/engine';
import { useChatRuntimeStore } from '@/lib/chat/runtime';
import { useAppMaintenanceStore, useModelStore, usePersonaStore } from '@/stores/app-stores';

export function PersonaManager({ disabled = false }: { disabled?: boolean }) {
  const theme = useTheme();
  const { roleId } = useChatRole();
  const { personas, activePersonaId, busy, switchPersona, deletePersona } = usePersonaStore();
  const models = useModelStore((state) => state.models);
  const maintenance = useAppMaintenanceStore((state) => state.active);
  const sending = useChatRuntimeStore((state) => state.isSending || state.hasUnsaved);
  const locked = disabled || busy || maintenance || sending;
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirmation();
  const act = async (work: () => Promise<void>) => {
    if (locked) return;
    setError(null);
    try { await work(); } catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败，请重试。'); }
  };
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel="切换和管理角色" accessibilityState={{ disabled: locked }} disabled={locked}
      onPress={() => { setError(null); setVisible(true); }} style={[styles.trigger, locked && styles.dimmed]}>
      {busy || maintenance ? <ActivityIndicator size="small" color={theme.primary} /> : <AppIcon name="people-outline" size={21} color={theme.primary} />}
    </Pressable>
    <Sheet visible={visible} title="角色" onClose={() => { if (!busy) setVisible(false); }}>
      {personas.map((persona) => {
        const model = models.find((item) => item.id === persona.configuration?.currentModelId);
        return <View key={persona.id} style={[styles.row, { borderColor: theme.border }]}>
          <Pressable accessibilityRole="radio" accessibilityLabel={'切换角色：' + persona.profile.name}
            accessibilityState={{ checked: persona.id === roleId, disabled: locked }} disabled={locked}
            onPress={() => { void act(async () => {
              if (persona.id !== activePersonaId || persona.id !== roleId) {
                await switchPersona(persona.id);
                startNewConversation();
              }
              setVisible(false);
              if (!persona.configuration?.confirmed) router.push({ pathname: '/role', params: { id: persona.id } });
              else router.replace('/(tabs)');
            }); }} style={styles.main}>
            <RoleAvatar profile={persona.profile} size={38} />
            <View style={styles.copy}><ThemedText numberOfLines={1} style={styles.name}>{persona.profile.name}</ThemedText>
              <ThemedText themeColor="textSecondary" numberOfLines={1} style={styles.meta}>{persona.configuration?.confirmed
                ? model?.name ?? '模型不可用' : '待确认模型配置'}</ThemedText></View>
            {persona.id === roleId ? <AppIcon name="checkmark" size={17} color={theme.primary} /> : null}
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={'编辑角色：' + persona.profile.name} disabled={locked}
            onPress={() => { setVisible(false); router.push({ pathname: '/role', params: { id: persona.id } }); }} style={styles.action}>
            <AppIcon name="create-outline" size={18} color={theme.textSecondary} />
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={'删除角色：' + persona.profile.name} disabled={locked || personas.length < 2}
            accessibilityState={{ disabled: locked || personas.length < 2 }} onPress={() => confirm({
              title: '删除“' + persona.profile.name + '”？', message: '角色资料、记忆与配置将删除，历史聊天保留。共用模型不会删除。',
              confirmLabel: '删除', destructive: true, onConfirm: () => { void act(() => deletePersona(persona.id)); },
            })} style={[styles.action, personas.length < 2 && styles.dimmed]}>
            <AppIcon name="trash-outline" size={18} color={theme.textSecondary} />
          </Pressable>
        </View>;
      })}
      {error ? <ThemedText accessibilityRole="alert" style={[styles.note, { color: theme.danger }]}>{error}</ThemedText> : null}
      <SmallAction label="新建角色" icon="add" onPress={() => { if (!locked) { setVisible(false); router.push({ pathname: '/role', params: { create: '1' } }); } }} />
    </Sheet>
    {dialog}
  </>;
}

const styles = StyleSheet.create({
  trigger: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 5 },
  main: { flex: 1, minWidth: 0, minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 10 },
  copy: { flex: 1, minWidth: 0, gap: 3 }, name: { ...Typography.rowTitle }, meta: { ...Typography.secondary },
  action: { width: 34, minHeight: 42, alignItems: 'center', justifyContent: 'center' }, dimmed: { opacity: 0.4 },
  note: { ...Typography.secondary },
});
