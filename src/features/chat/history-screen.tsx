import { AppIcon as Ionicons } from '@/components/app-icon';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Keyboard, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppShell } from '@/components/app-shell';
import { SmallAction, useConfirmation } from '@/components/customization-ui';
import { ThemedText } from '@/components/themed-text';
import { Fonts } from '@/constants/theme';
import { Typography } from '@/constants/typography';
import { useTheme } from '@/hooks/use-theme';
import { deleteChatSession, openChatSession } from '@/lib/chat/engine';
import type { SessionRecord } from '@/lib/db/types';
import { useChatStore, useModelStore, usePersonaStore } from '@/stores/app-stores';

type SearchResult = {
  query: string; sessions: SessionRecord[]; source: SessionRecord[] | null; revision: number; failed: boolean;
};
const newestFirst = (a: SessionRecord, b: SessionRecord) => b.updatedAt.localeCompare(a.updatedAt);

function displayDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const prefix = date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}年`;
  return `${prefix}${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export default function HistoryScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const sessions = useChatStore((state) => state.sessions);
  const models = useModelStore((state) => state.models);
  const personas = usePersonaStore((state) => state.personas);
  const searchSessions = useChatStore((state) => state.searchSessions);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<SearchResult>({ query: '', sessions: [], source: null, revision: 0, failed: false });
  const [searchRevision, setSearchRevision] = useState(0);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const mounted = useRef(true);
  const { confirm, dialog } = useConfirmation();
  const trimmedQuery = query.trim();

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!trimmedQuery) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchSessions(trimmedQuery).then((found) => {
        if (!cancelled) {
          setSearch({ query: trimmedQuery, sessions: found, source: sessions, revision: searchRevision, failed: false });
        }
      }).catch(() => {
        if (!cancelled) {
          setSearch({ query: trimmedQuery, sessions: [], source: sessions, revision: searchRevision, failed: true });
        }
      });
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [trimmedQuery, sessions, searchSessions, searchRevision]);

  const searchMatches = search.query === trimmedQuery && search.source === sessions && search.revision === searchRevision;
  const visibleSessions = useMemo(() => {
    if (!trimmedQuery) return [...sessions].sort(newestFirst);
    if (!searchMatches) return [];
    const current = new Map(sessions.map((session) => [session.id, session]));
    return search.sessions.flatMap((session) => {
      const item = current.get(session.id);
      return item ? [item] : [];
    }).sort(newestFirst);
  }, [sessions, search, trimmedQuery, searchMatches]);
  const loading = Boolean(trimmedQuery) && !searchMatches;
  const searchFailed = Boolean(trimmedQuery) && searchMatches && search.failed;

  const openSession = async (id: string) => {
    if (pendingId) return;
    Keyboard.dismiss();
    setPendingId(id);
    setActionError(null);
    try {
      await openChatSession(id);
      if (mounted.current) router.dismissTo('/(tabs)');
    } catch {
      if (mounted.current) setActionError('打开会话失败，请重试。');
    } finally {
      if (mounted.current) setPendingId(null);
    }
  };

  const removeSession = async (id: string) => {
    if (pendingId) return;
    setPendingId(id);
    setActionError(null);
    try {
      await deleteChatSession(id);
    } catch {
      if (mounted.current) setActionError('删除会话失败，请重试。');
    } finally {
      if (mounted.current) setPendingId(null);
    }
  };

  return <AppShell>
    <View style={[styles.search, { borderColor: theme.border, backgroundColor: theme.backgroundElement }]}>
      <Ionicons name="search-outline" size={18} color={theme.textSecondary} />
      <TextInput accessibilityLabel="搜索历史会话" placeholder="搜索标题或消息" placeholderTextColor={theme.textSecondary}
        style={[styles.searchInput, { color: theme.text }]} selectionColor={theme.primary}
        value={query} onChangeText={setQuery} returnKeyType="search" autoCorrect={false} />
      {query ? <Pressable accessibilityRole="button" accessibilityLabel="清除搜索" hitSlop={6}
        onPress={() => setQuery('')} style={styles.clearSearch}>
        <Ionicons name="close-circle" size={17} color={theme.textSecondary} />
      </Pressable> : null}
    </View>

    {actionError ? <View accessibilityRole="alert" style={styles.actionError}>
      <Ionicons name="alert-circle-outline" size={17} color={theme.danger} />
      <ThemedText style={[styles.errorText, { color: theme.danger }]}>{actionError}</ThemedText>
      <Pressable accessibilityRole="button" accessibilityLabel="关闭错误提示" onPress={() => setActionError(null)}>
        <Ionicons name="close" size={17} color={theme.danger} />
      </Pressable>
    </View> : null}

    {loading || searchFailed ? <View style={styles.empty}>
      {loading ? <ActivityIndicator color={theme.primary} /> : <>
        <ThemedText style={styles.emptyText} themeColor="textSecondary">搜索失败</ThemedText>
        <SmallAction label="重试" icon="refresh" onPress={() => setSearchRevision((value) => value + 1)} />
      </>}
    </View> : <FlatList data={visibleSessions} keyExtractor={(session) => session.id}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false}
      contentContainerStyle={[styles.list, { paddingBottom: Math.max(insets.bottom, 16) }]}
      ListEmptyComponent={<View style={styles.empty}>
        <Ionicons name={trimmedQuery ? 'search-outline' : 'chatbubbles-outline'} size={30} color={theme.textSecondary} />
        <ThemedText style={styles.emptyText} themeColor="textSecondary">{trimmedQuery ? '没有匹配的会话' : '还没有会话'}</ThemedText>
      </View>}
      renderItem={({ item }) => {
        const modelName = models.find((model) => model.id === item.modelId)?.name;
        const roleName = personas.find((persona) => persona.id === item.personaId)?.profile.name ?? '角色已删除';
        return <View style={[styles.row, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Pressable accessibilityRole="button" accessibilityLabel={`打开会话：${item.title || '新聊天'}`}
            disabled={pendingId !== null} onPress={() => { void openSession(item.id); }}
            style={({ pressed }) => [styles.sessionBody, { opacity: pressed ? 0.6 : 1 }]}>
            <ThemedText numberOfLines={2} style={styles.sessionTitle}>{item.title || '新聊天'}</ThemedText>
            <View style={styles.metadata}>
              <ThemedText numberOfLines={1} style={styles.date} themeColor="textSecondary">{displayDate(item.updatedAt)}</ThemedText>
              <ThemedText numberOfLines={1} style={styles.model} themeColor="textSecondary">{roleName}{modelName ? ` · ${modelName}` : ''}</ThemedText>
            </View>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`删除会话：${item.title || '新聊天'}`}
            disabled={pendingId !== null}
            onPress={() => confirm({ title: '删除会话？', message: '会话中的所有消息都会删除。', confirmLabel: '删除', destructive: true,
              onConfirm: () => { void removeSession(item.id); } })}
            style={({ pressed }) => [styles.deleteButton, { opacity: pressed ? 0.5 : 1 }]}>
            {pendingId === item.id ? <ActivityIndicator size="small" color={theme.textSecondary} />
              : <Ionicons name="trash-outline" size={18} color={theme.textSecondary} />}
          </Pressable>
        </View>;
      }} />}
    {dialog}
  </AppShell>;
}

const styles = StyleSheet.create({
  search: { marginHorizontal: 22, marginTop: 10, marginBottom: 12,
    borderRadius: 11, paddingLeft: 12, flexDirection: 'row', alignItems: 'center', minHeight: 48, gap: 8 },
  searchInput: { ...Typography.input, fontFamily: Fonts.sans, flex: 1, minWidth: 0, paddingVertical: 10 },
  clearSearch: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  list: { paddingHorizontal: 22, flexGrow: 1 },
  row: { borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', minHeight: 96 },
  sessionBody: { flex: 1, minWidth: 0, paddingVertical: 14, paddingRight: 6, gap: 6 },
  sessionTitle: { ...Typography.rowTitle },
  metadata: { gap: 2 },
  date: { ...Typography.caption },
  model: { ...Typography.secondary, flexShrink: 1 },
  deleteButton: { width: 44, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 170, padding: 24, gap: 12 },
  emptyText: { ...Typography.body },
  actionError: { marginHorizontal: 20, marginBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 7 },
  errorText: { ...Typography.secondary, flex: 1 },
});
