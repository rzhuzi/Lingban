import { Typography } from '@/constants/typography';
import { AppIcon as Ionicons } from '@/components/app-icon';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { Card, DetailScreen, IconButton, SmallAction, useConfirmation } from '@/components/customization-ui';
import { ThemedText } from '@/components/themed-text';
import { ModelCleanupWarning } from '@/features/models/model-cleanup-warning';
import { useTheme } from '@/hooks/use-theme';
import { getProvider } from '@/lib/api/providers';
import { useModelStore, usePersonaStore } from '@/stores/app-stores';

type ModelAction = { kind: 'delete'; id: string };

export default function ModelsScreen() {
  const theme = useTheme();
  const models = useModelStore((state) => state.models);
  const personas = usePersonaStore((state) => state.personas);
  const { confirm, dialog } = useConfirmation();
  const pendingRef = useRef(false);
  const [pending, setPending] = useState<ModelAction | null>(null);
  const [failure, setFailure] = useState<{ action: ModelAction; message: string } | null>(null);

  const perform = async (action: ModelAction) => {
    if (pendingRef.current) return;
    const current = useModelStore.getState().models.find((model) => model.id === action.id);
    if (!current) { setFailure(null); return; }
    pendingRef.current = true;
    setPending(action);
    setFailure(null);
    try {
      const store = useModelStore.getState();
      await store.deleteModel(action.id);
    } catch (error) {
      setFailure({ action, message: error instanceof Error ? error.message : '删除失败，请重试。' });
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };

  const editModel = (id: string) => router.push({ pathname: '/models/[id]', params: { id } });

  return <>
    <DetailScreen title="模型库" right={<IconButton name="add" label="添加模型" tone="primary" onPress={() => router.push('/models/new')} />}>
      <ModelCleanupWarning />
      {failure ? <View accessibilityRole="alert" style={[styles.error, { backgroundColor: theme.primarySurface }]}>
        <Ionicons name="alert-circle-outline" size={18} color={theme.danger} />
        <ThemedText style={[styles.errorText, { color: theme.danger }]}>{failure.message}</ThemedText>
        <SmallAction label="重试" icon="refresh" tone="danger" onPress={() => { void perform(failure.action); }} />
      </View> : null}
      {!models.length ? <Card><View style={styles.empty}>
        <View style={[styles.emptyIcon, { backgroundColor: theme.primarySurface }]}><Ionicons name="cube-outline" size={32} color={theme.primary} /></View>
        <ThemedText style={styles.emptyTitle}>还没有模型</ThemedText>
        <Pressable accessibilityRole="button" accessibilityLabel="添加第一个模型" onPress={() => router.push('/models/new')}
          style={({ pressed }) => [styles.addButton, { backgroundColor: theme.primaryStrong, opacity: pressed ? 0.7 : 1 }]}>
          <Ionicons name="add" size={18} color={theme.onPrimary} /><ThemedText style={[styles.addLabel, { color: theme.onPrimary }]}>添加模型</ThemedText>
        </Pressable>
      </View></Card> : models.map((model) => <Card key={model.id}>
        <Pressable accessibilityRole="button" accessibilityLabel={`编辑模型：${model.name}`} disabled={pending !== null} onPress={() => editModel(model.id)}
          style={({ pressed }) => [styles.modelRow, { opacity: pressed ? 0.65 : 1 }]}>
          <View style={[styles.modelIcon, { backgroundColor: theme.primarySurface }]}><Ionicons name="cube-outline" size={20} color={theme.primary} /></View>
          <View style={styles.identity}>
            <View style={styles.nameRow}><ThemedText numberOfLines={1} style={styles.name}>{model.name}</ThemedText>
            </View>
            <ThemedText numberOfLines={1} themeColor="textSecondary" style={styles.detail}>{getProvider(model.provider).label} · {model.apiModel}</ThemedText>
          </View>
          <Ionicons name="chevron-forward" size={17} color={theme.textSecondary} />
        </Pressable>
        <View style={[styles.actions, { borderTopColor: theme.border }]}>
          <View style={styles.defaultAction}>
            {pending?.id === model.id ? <ActivityIndicator size="small" color={theme.primary} /> : <Ionicons name="person-outline" size={16} color={theme.textSecondary} />}
            <ThemedText themeColor="textSecondary" style={styles.actionLabel}>{personas.filter((persona) => persona.configuration?.currentModelId === model.id).length} 个角色使用</ThemedText>
          </View>
          <View style={styles.endActions}>
            <Pressable accessibilityRole="button" accessibilityLabel={`编辑${model.name}`} disabled={pending !== null} onPress={() => editModel(model.id)} style={styles.iconAction}>
              <Ionicons name="create-outline" size={19} color={theme.textSecondary} />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={`删除${model.name}`} disabled={pending !== null} style={styles.iconAction}
              onPress={() => confirm({ title: '删除模型？', message: `将删除“${model.name}”及其保存的 API Key，已有会话会保留。`, confirmLabel: '删除', destructive: true, onConfirm: () => { void perform({ kind: 'delete', id: model.id }); } })}>
              <Ionicons name="trash-outline" size={18} color={theme.danger} />
            </Pressable>
          </View>
        </View>
      </Card>)}
    </DetailScreen>
    {dialog}
  </>;
}

const styles = StyleSheet.create({
  empty: { alignItems: 'center', paddingVertical: 32, gap: 16 },
  emptyIcon: { width: 58, height: 58, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { ...Typography.pageTitle },
  addButton: { minHeight: 48, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  addLabel: { ...Typography.button, color: '#FFFFFF', },
  modelRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 54 },
  modelIcon: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  identity: { flex: 1, minWidth: 0, gap: 4 },
  nameRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  name: { ...Typography.rowTitle, flexShrink: 1, },
  detail: { ...Typography.secondary },
  defaultBadge: { borderRadius: 7, paddingHorizontal: 7, paddingVertical: 1 },
  defaultLabel: { ...Typography.caption },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8, marginBottom: -6 },
  defaultAction: { flexDirection: 'row', gap: 6, alignItems: 'center', minHeight: 36 },
  actionLabel: { ...Typography.secondary },
  endActions: { flexDirection: 'row', gap: 8 },
  iconAction: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  error: { borderRadius: 13, flexDirection: 'row', padding: 11, gap: 8, alignItems: 'center' },
  errorText: { ...Typography.secondary, flex: 1 },
});
