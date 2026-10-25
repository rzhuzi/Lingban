import { Typography } from '@/constants/typography';
import { AppIcon as Ionicons } from '@/components/app-icon';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Keyboard, Pressable, StyleSheet, View } from 'react-native';

import { Field, Sheet, SmallAction } from '@/components/customization-ui';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import type { RemoteModel } from '@/lib/api/models';

export type RemoteModelPickerProps = {
  visible: boolean;
  onClose: () => void;
  models: RemoteModel[];
  selectedId: string;
  onSelect: (model: RemoteModel) => void;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onManualEntry?: () => void;
  sourceLabel?: string;
};

const PAGE_SIZE = 8;

/** Mount a fresh search per opening; the parent owns fetching, selection and cancellation. */
export function RemoteModelPicker(props: RemoteModelPickerProps) {
  return props.visible ? <RemoteModelPickerSheet {...props} /> : null;
}

function RemoteModelPickerSheet({ onClose, models, selectedId, onSelect, loading, error, onRefresh, onManualEntry, sourceLabel }: RemoteModelPickerProps) {
  const theme = useTheme();
  const [query, setQuery] = useState('');
  const [requestedPage, setRequestedPage] = useState(0);
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return search ? models.filter((model) => model.id.toLowerCase().includes(search)
      || model.name?.toLowerCase().includes(search)) : models;
  }, [models, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pages - 1);
  const visibleModels = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const close = () => { Keyboard.dismiss(); onClose(); };
  const manualEntry = () => { Keyboard.dismiss(); (onManualEntry ?? onClose)(); };

  return <Sheet visible title="选择模型 ID" onClose={close} footer={<View style={styles.footer}>
    {!loading && pages > 1 ? <View style={styles.pagination}>
      <Pressable accessibilityRole="button" accessibilityLabel="上一页模型" disabled={page === 0}
        accessibilityState={{ disabled: page === 0 }} onPress={() => setRequestedPage(page - 1)}
        style={[styles.pageButton, page === 0 && styles.disabled]}>
        <Ionicons name="chevron-back" size={19} color={theme.primary} />
      </Pressable>
      <ThemedText themeColor="textSecondary" style={styles.pageLabel}>{page + 1} / {pages}</ThemedText>
      <Pressable accessibilityRole="button" accessibilityLabel="下一页模型" disabled={page === pages - 1}
        accessibilityState={{ disabled: page === pages - 1 }} onPress={() => setRequestedPage(page + 1)}
        style={[styles.pageButton, page === pages - 1 && styles.disabled]}>
        <Ionicons name="chevron-forward" size={19} color={theme.primary} />
      </Pressable>
    </View> : null}
    <SmallAction label="手动输入模型 ID" icon="create-outline" tone="muted" onPress={manualEntry} />
  </View>}>
    <Field accessibilityLabel="搜索远端模型" placeholder="搜索模型 ID 或名称" value={query}
      onChangeText={(value) => { setQuery(value); setRequestedPage(0); }}
      autoCapitalize="none" autoCorrect={false} returnKeyType="search" onSubmitEditing={Keyboard.dismiss}
      maxLength={200} clearButtonMode="while-editing" />
    <View style={styles.toolbar}>
      <ThemedText themeColor="textSecondary" numberOfLines={1} style={styles.meta}>{loading ? '正在获取模型…'
        : sourceLabel ? `${sourceLabel} · ${filtered.length} 个模型` : error && !models.length ? '获取失败' : `${filtered.length} 个模型`}</ThemedText>
      <Pressable accessibilityRole="button" accessibilityLabel="刷新远端模型" disabled={loading}
        accessibilityState={{ disabled: loading }} onPress={onRefresh}
        style={({ pressed }) => [styles.refresh, (loading || pressed) && styles.disabled]}>
        <Ionicons name="refresh-outline" size={15} color={theme.primary} />
        <ThemedText style={[styles.refreshLabel, { color: theme.primary }]}>刷新</ThemedText>
      </Pressable>
    </View>
    {loading ? <View style={styles.state} accessibilityRole="progressbar" accessibilityLabel="正在获取模型列表">
      <ActivityIndicator color={theme.primary} />
    </View> : <>
    {error ? <View accessibilityRole="alert" style={[styles.error, { backgroundColor: theme.primarySurface }]}>
      <Ionicons name="alert-circle-outline" size={19} color={theme.danger} />
      <ThemedText style={[styles.errorText, { color: theme.danger }]}>{error}</ThemedText>
    </View> : null}
    {!error || models.length ? filtered.length ? <View style={styles.list}>
      {/* Sheet already owns a ScrollView; bounded pages avoid nested virtual lists and unbounded rows. */}
      {visibleModels.map((model) => {
        const selected = model.id === selectedId;
        const displayName = model.name?.trim();
        const hasName = !!displayName && displayName !== model.id;
        return <Pressable key={model.id} accessibilityRole="radio" accessibilityLabel={`选择远端模型：${hasName ? `${displayName}，` : ''}${model.id}`}
          accessibilityState={{ checked: selected }} onPress={() => { Keyboard.dismiss(); onSelect(model); }}
          style={({ pressed }) => [styles.model, { backgroundColor: pressed ? theme.backgroundElement : 'transparent',
            borderColor: theme.border, opacity: pressed ? 0.65 : 1 }]}>
          <View style={styles.identity}>
            <ThemedText numberOfLines={2} style={styles.name}>{hasName ? displayName : model.id}</ThemedText>
            {hasName ? <ThemedText themeColor="textSecondary" numberOfLines={2} style={styles.modelId}>{model.id}</ThemedText>
              : model.ownedBy ? <ThemedText themeColor="textSecondary" numberOfLines={1} style={styles.modelId}>{model.ownedBy}</ThemedText> : null}
          </View>
          {selected ? <Ionicons name="checkmark" size={18} color={theme.primary} /> : null}
        </Pressable>;
      })}
    </View> : <View style={styles.state}>
      <Ionicons name={models.length ? 'search-outline' : 'cube-outline'} size={27} color={theme.textSecondary} />
      <ThemedText themeColor="textSecondary" style={styles.emptyText}>{models.length ? '没有匹配的模型' : '接口未返回可选模型'}</ThemedText>
    </View> : null}
    </>}
  </Sheet>;
}

const styles = StyleSheet.create({
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: -7, marginBottom: -7 },
  meta: { ...Typography.secondary, flex: 1 }, refresh: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 32, paddingHorizontal: 4 },
  refreshLabel: { ...Typography.compact }, disabled: { opacity: 0.35 },
  list: { gap: 0 }, model: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 2, paddingVertical: 13,
    minHeight: 58, borderBottomWidth: StyleSheet.hairlineWidth },
  identity: { flex: 1, gap: 2, minWidth: 0 }, name: { ...Typography.rowTitle },
  modelId: { ...Typography.caption },
  state: { minHeight: 104, paddingVertical: 21, gap: 9, alignItems: 'center', justifyContent: 'center' },
  emptyText: { ...Typography.secondary }, error: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 12, borderRadius: 13 },
  errorText: { ...Typography.secondary, flex: 1, },
  footer: { width: '100%', gap: 3 }, pagination: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 17 },
  pageButton: { width: 40, height: 36, alignItems: 'center', justifyContent: 'center' }, pageLabel: { ...Typography.secondary },
});
