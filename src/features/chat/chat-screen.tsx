import { AppIcon as Ionicons } from '@/components/app-icon';
import { router } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppShell, ChatWelcome } from '@/components/app-shell';
import { ThemedText } from '@/components/themed-text';
import { Typography } from '@/constants/typography';
import { useTheme } from '@/hooks/use-theme';
import { openChatSession, retryChatPersistence } from '@/lib/chat/engine';
import { useChatRuntimeStore } from '@/lib/chat/runtime';
import { useChatStore, useModelStore, usePersonaStore } from '@/stores/app-stores';

import { MessageList } from './message-list';
import { useChatRole } from './use-chat-role';

export function ChatScreen() {
  const theme = useTheme();
  const activeId = useChatStore((state) => state.activeSessionId);
  const allMessages = useChatStore((state) => state.messages);
  const sessionPersona = useChatStore((state) => state.sessions.find((session) => session.id === activeId)?.personaId);
  const activePersona = usePersonaStore((state) => state.activePersonaId);
  const owner = usePersonaStore((state) => state.personas.find((persona) => persona.id === sessionPersona));
  const runtime = useChatRuntimeStore();
  const { role } = useChatRole();
  const modelExists = useModelStore((state) => state.models.some((model) => model.id === role?.configuration?.currentModelId));
  const roleNeedsSetup = role && (!role.configuration?.confirmed || !modelExists);
  const messages = useMemo(() => allMessages.filter((message) => message.sessionId === activeId && message.role !== 'system'), [allMessages, activeId]);
  const otherSession = runtime.isSending && runtime.streamingSessionId && runtime.streamingSessionId !== activeId;

  return <AppShell showComposer>
    <View style={styles.screen}>
      {roleNeedsSetup ? <Pressable accessibilityRole="button" accessibilityLabel="配置当前角色" disabled={runtime.isSending || runtime.hasUnsaved}
        onPress={() => router.push({ pathname: '/role', params: { id: role.id } })}
        style={[styles.notice, { backgroundColor: theme.primarySurface }]}>
        <Ionicons name="options-outline" size={18} color={theme.primary} />
        <ThemedText style={[styles.noticeText, { color: theme.primary }]}>{role.configuration?.confirmed ? '为这个角色重新选择模型' : '确认这个角色的模型与思维配置'}</ThemedText>
        <Ionicons name="chevron-forward" size={16} color={theme.primary} />
      </Pressable> : null}
      {activeId && sessionPersona !== activePersona ? <View style={[styles.notice, { backgroundColor: theme.backgroundElement }]}>
        <Ionicons name="person-outline" size={17} color={theme.textSecondary} />
        <ThemedText themeColor="textSecondary" style={styles.noticeText}>{owner ? `本会话使用${owner.profile.name}` : '此会话的人设已删除，请开始新会话。'}</ThemedText>
      </View> : null}
      {runtime.persistenceError ? <Pressable accessibilityRole="button" accessibilityLabel="重试保存消息" onPress={() => void retryChatPersistence()}
        style={[styles.notice, { backgroundColor: theme.primarySurface }]}>
        <Ionicons name="alert-circle-outline" size={17} color={theme.danger} />
        <ThemedText style={[styles.noticeText, { color: theme.danger }]}>{runtime.persistenceError} 点此重试</ThemedText>
      </Pressable> : null}
      {runtime.error && !runtime.persistenceError ? <View accessibilityRole="alert" style={[styles.notice, { backgroundColor: theme.backgroundElement }]}>
        <Ionicons name="information-circle-outline" size={17} color={theme.textSecondary} /><ThemedText themeColor="textSecondary" style={styles.noticeText}>{runtime.error}</ThemedText>
      </View> : null}
      {otherSession ? <Pressable accessibilityRole="button" onPress={() => { if (runtime.streamingSessionId) void openChatSession(runtime.streamingSessionId); }}
        style={[styles.notice, { backgroundColor: theme.accentSurface }]}>
        <Ionicons name="chatbubble-ellipses-outline" size={17} color={theme.accent} /><ThemedText style={[styles.noticeText, { color: theme.accent }]}>查看正在回复的会话</ThemedText><Ionicons name="chevron-forward" size={14} color={theme.accent} />
      </Pressable> : null}
      {messages.length ? <MessageList key={activeId} messages={messages}
        generating={runtime.isSending && runtime.streamingSessionId === activeId}
        retryEnabled={!runtime.isSending && !runtime.hasUnsaved}
      /> : <ChatWelcome />}
    </View>
  </AppShell>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  notice: { marginHorizontal: 16, marginTop: 6, marginBottom: 5, padding: 11, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  noticeText: { ...Typography.secondary, flex: 1 },
});
