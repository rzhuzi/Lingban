import { AppIcon as Ionicons } from '@/components/app-icon';
import { useRecyclingState } from '@shopify/flash-list';
import { memo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Typography } from '@/constants/typography';
import { useTheme } from '@/hooks/use-theme';
import { retryChatMessage } from '@/lib/chat/engine';
import type { MessageRecord } from '@/lib/db/types';

import { AuditSheet } from './audit-sheet';

function ReasoningBlock({ message, onToggle }: { message: MessageRecord; onToggle?: () => void }) {
  const theme = useTheme();
  // Preserve the user's choice as output grows; recycling still resets a different message.
  const [expanded, setExpanded] = useRecyclingState(false, [message.id]);
  const thinking = ['pending', 'streaming'].includes(message.status) && !message.content;
  return <View style={styles.reasoning}>
    <Pressable accessibilityRole="button" accessibilityLabel={expanded ? '收起思考过程' : '展开思考过程'}
      accessibilityState={{ expanded }} onPress={() => { onToggle?.(); setExpanded(!expanded); }} style={styles.reasoningHeader}>
      {thinking ? <ActivityIndicator size="small" color={theme.textSecondary} style={styles.thinkingIcon} /> : <Ionicons name="orbit" size={8} color={theme.textSecondary} />}
      <ThemedText style={[styles.reasoningLabel, { color: theme.textSecondary }]}>{thinking ? '正在思考…' : '思考过程'}</ThemedText>
      <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={12} color={theme.textSecondary} />
    </Pressable>
    {expanded ? <ThemedText selectable style={[styles.reasoningText, { color: theme.textSecondary, borderLeftColor: theme.border, backgroundColor: theme.backgroundElement }]}>{message.reasoning}</ThemedText> : null}
  </View>;
}

export const MessageBubble = memo(function MessageBubble({ message, canRetry, onReasoningToggle }: { message: MessageRecord; canRetry: boolean; onReasoningToggle?: () => void }) {
  const theme = useTheme();
  const user = message.role === 'user';
  const pending = ['pending', 'streaming'].includes(message.status);
  const [showAudit, setShowAudit] = useRecyclingState(false, [message.id]);
  return <Pressable accessible={false} disabled={user} onLongPress={() => setShowAudit(true)}
    style={[styles.row, user ? styles.userRow : styles.assistantRow]}>
    {message.reasoning && !user ? <ReasoningBlock message={message} onToggle={onReasoningToggle} /> : null}
    {message.content ? <View style={[styles.bubble, user ? styles.userBubble : styles.assistantBubble,
      { backgroundColor: user ? theme.userBubble : 'transparent' }]}>
      <ThemedText selectable onLongPress={user ? undefined : () => setShowAudit(true)} style={styles.content}>{message.content}</ThemedText>
    </View> : null}
    {!user && pending && !message.content && !message.reasoning ? <View style={styles.waiting}>
      <ActivityIndicator size="small" color={theme.primary} /><ThemedText themeColor="textSecondary" style={styles.status}>正在回复…</ThemedText>
    </View> : null}
    {!user && message.status === 'error' ? <View accessibilityRole="alert" style={styles.feedback}>
      <Ionicons name="alert-circle-outline" size={16} color={theme.danger} />
      <ThemedText style={[styles.status, styles.flexText, { color: theme.danger }]}>{message.error ?? '回复失败，请重试。'}</ThemedText>
    </View> : null}
    {!user && message.status === 'aborted' ? <ThemedText themeColor="textSecondary" style={styles.status}>已停止</ThemedText> : null}
    {!user && message.status === 'done' && message.error ? <View style={styles.feedback}>
      <Ionicons name="information-circle-outline" size={16} color={theme.textSecondary} />
      <ThemedText themeColor="textSecondary" style={[styles.status, styles.flexText]}>{message.error}</ThemedText>
    </View> : null}
    {canRetry ? <Pressable accessibilityRole="button" accessibilityLabel="重试回复" onPress={() => void retryChatMessage(message.id)} style={styles.retry}>
      <Ionicons name="refresh-outline" size={15} color={theme.primary} /><ThemedText style={[styles.retryLabel, { color: theme.primary }]}>重新生成</ThemedText>
    </Pressable> : null}
    {!user && !pending && message.content ? <Pressable accessibilityRole="button" accessibilityLabel="查看回复详情"
      onPress={() => setShowAudit(true)} style={styles.details}>
      <Ionicons name="ellipsis-horizontal" size={16} color={theme.textSecondary} />
    </Pressable> : null}
    {!user && showAudit ? <AuditSheet message={message} visible={showAudit} onClose={() => setShowAudit(false)} /> : null}
  </Pressable>;
});

const styles = StyleSheet.create({
  row: { marginVertical: 12, gap: 8, maxWidth: '100%' }, userRow: { alignItems: 'flex-end' }, assistantRow: { alignItems: 'flex-start' },
  bubble: { borderRadius: 17 },
  userBubble: { maxWidth: '88%', borderBottomRightRadius: 4, paddingHorizontal: 15, paddingVertical: 10 },
  assistantBubble: { width: '100%', paddingRight: 10, paddingVertical: 2 },
  content: { ...Typography.chat }, status: { ...Typography.secondary },
  reasoning: { maxWidth: '100%', alignSelf: 'stretch' },
  reasoningHeader: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 7, minHeight: 40 },
  thinkingIcon: { width: 10, height: 10, transform: [{ scale: 0.5 }] },
  reasoningLabel: { ...Typography.compact },
  reasoningText: { ...Typography.body, marginTop: 4, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 10, borderLeftWidth: 1 },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 35 },
  feedback: { flexDirection: 'row', gap: 6, alignItems: 'flex-start', maxWidth: '96%', paddingHorizontal: 3 }, flexText: { flexShrink: 1 },
  retry: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 3, minHeight: 40 }, retryLabel: { ...Typography.compact },
  details: { width: 36, height: 32, alignItems: 'center', justifyContent: 'center', marginLeft: -8 },
});
