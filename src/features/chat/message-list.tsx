import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useRef } from 'react';
import { StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Typography } from '@/constants/typography';
import type { MessageRecord } from '@/lib/db/types';

import { MessageBubble } from './message-bubble';

type Props = { messages: MessageRecord[]; generating: boolean; retryEnabled: boolean };
type Output = { id: string; content: string; reasoning: string };

/** The parent keys this list by session, so scroll and reading intent never leak between chats. */
export function MessageList({ messages, generating, retryEnabled }: Props) {
  const list = useRef<FlashListRef<MessageRecord>>(null);
  const lastOutput = useRef<Output | null>(null);
  const pausedTurn = useRef<string | undefined>(undefined);
  const nearBottom = useRef(true);
  const scroll = useRef({ offset: 0, contentHeight: 0 });
  const last = messages[messages.length - 1];
  const startedAt = new Date(messages[0]?.createdAt ?? '');
  const now = new Date();
  const sameDay = startedAt.toDateString() === now.toDateString();
  const sessionTime = Number.isNaN(startedAt.getTime()) ? '' : `${sameDay ? '今天' : `${startedAt.getFullYear() === now.getFullYear() ? '' : `${startedAt.getFullYear()}/`}${startedAt.getMonth() + 1}/${startedAt.getDate()}`} · ${String(startedAt.getHours()).padStart(2, '0')}:${String(startedAt.getMinutes()).padStart(2, '0')}`;

  return <FlashList ref={list} data={messages} keyExtractor={(message) => message.id} getItemType={(message) => message.role}
    ListHeaderComponent={sessionTime ? <ThemedText themeColor="textSecondary" style={styles.timestamp}>{sessionTime}</ThemedText> : null}
    renderItem={({ item }) => <MessageBubble message={item} onReasoningToggle={() => { pausedTurn.current = last?.id; }}
      canRetry={retryEnabled && item.id === last?.id && item.role === 'assistant' && ['error', 'aborted'].includes(item.status)} />}
    contentContainerStyle={styles.messages} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
    onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
      // A size-only scroll event during token layout must not cancel an existing follow intent.
      if (Math.abs(contentOffset.y - scroll.current.offset) > 0.5 || contentSize.height === scroll.current.contentHeight) {
        nearBottom.current = contentSize.height - layoutMeasurement.height - contentOffset.y <= layoutMeasurement.height * 0.2;
      }
      scroll.current = { offset: contentOffset.y, contentHeight: contentSize.height };
    }}
    scrollEventThrottle={16}
    onContentSizeChange={() => {
      const previous = lastOutput.current;
      const changed = last && (previous?.id !== last.id || previous.content !== last.content || previous.reasoning !== last.reasoning);
      lastOutput.current = last ? { id: last.id, content: last.content, reasoning: last.reasoning } : null;
      // Never use MVCP bottom autoscroll: its pending callback can survive disabling the prop.
      // Only fresh output can request a follow, after measurement; toggles pause immediately.
      if (changed && generating && nearBottom.current && pausedTurn.current !== last.id) {
        list.current?.scrollToEnd({ animated: false });
      }
    }}
  />;
}

const styles = StyleSheet.create({
  messages: { paddingHorizontal: 23, paddingTop: 10, paddingBottom: 16 },
  timestamp: { ...Typography.caption, textAlign: 'center', marginTop: 8, marginBottom: 18 },
});
