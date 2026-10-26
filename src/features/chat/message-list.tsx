import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useRef } from 'react';
import { StyleSheet, type NativeScrollEvent } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Typography } from '@/constants/typography';
import type { MessageRecord } from '@/lib/db/types';

import { MessageBubble } from './message-bubble';

type Props = { messages: MessageRecord[]; generating: boolean; retryEnabled: boolean };
type Output = { id: string; content: string; reasoning: string };
const isNearBottom = ({ contentOffset, contentSize, layoutMeasurement }: NativeScrollEvent) =>
  contentSize.height - layoutMeasurement.height - contentOffset.y <= layoutMeasurement.height * 0.2;

/** The parent keys this list by session, so scroll and reading intent never leak between chats. */
export function MessageList({ messages, generating, retryEnabled }: Props) {
  const list = useRef<FlashListRef<MessageRecord>>(null);
  const lastOutput = useRef<Output | null>(null);
  const pausedTurn = useRef<string | undefined>(undefined);
  const nearBottom = useRef(true);
  const userDragging = useRef(false);
  const pendingMomentum = useRef(false);
  const userMomentum = useRef(false);
  const direction = useRef<'up' | 'down' | null>(null);
  const scroll = useRef({ offset: 0, contentHeight: 0 });
  const last = messages[messages.length - 1];
  const startedAt = new Date(messages[0]?.createdAt ?? '');
  const now = new Date();
  const sameDay = startedAt.toDateString() === now.toDateString();
  const sessionTime = Number.isNaN(startedAt.getTime()) ? '' : `${sameDay ? '今天' : `${startedAt.getFullYear() === now.getFullYear() ? '' : `${startedAt.getFullYear()}/`}${startedAt.getMonth() + 1}/${startedAt.getDate()}`} · ${String(startedAt.getHours()).padStart(2, '0')}:${String(startedAt.getMinutes()).padStart(2, '0')}`;
  const recordDirection = ({ contentOffset }: NativeScrollEvent) => {
    const delta = contentOffset.y - scroll.current.offset;
    if (Math.abs(delta) > 0.5) {
      direction.current = delta > 0 ? 'down' : 'up';
      if (direction.current === 'up') pausedTurn.current = last?.id;
    }
  };
  const resumeFollowing = (event: NativeScrollEvent) => {
    if (direction.current === 'down' && isNearBottom(event)) { pausedTurn.current = undefined; nearBottom.current = true; }
  };

  return <FlashList ref={list} data={messages} keyExtractor={(message) => message.id} getItemType={(message) => message.role}
    ListHeaderComponent={sessionTime ? <ThemedText themeColor="textSecondary" style={styles.timestamp}>{sessionTime}</ThemedText> : null}
    renderItem={({ item }) => <MessageBubble message={item} onReasoningToggle={() => {
      pausedTurn.current = last?.id; userDragging.current = false; pendingMomentum.current = false;
      userMomentum.current = false; direction.current = null;
    }}
      canRetry={retryEnabled && item.id === last?.id && item.role === 'assistant' && ['error', 'aborted'].includes(item.status)} />}
    contentContainerStyle={styles.messages} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
    onScrollBeginDrag={(event) => {
      userDragging.current = true; pendingMomentum.current = false; userMomentum.current = false; direction.current = null;
      const geometry = event?.nativeEvent;
      if (geometry) scroll.current = { offset: geometry.contentOffset.y, contentHeight: geometry.contentSize.height };
    }}
    onScrollEndDrag={({ nativeEvent }) => {
      if (userDragging.current) { recordDirection(nativeEvent); resumeFollowing(nativeEvent); }
      pendingMomentum.current = userDragging.current && (nativeEvent.velocity?.y ?? 0) !== 0;
      userDragging.current = false;
    }}
    onMomentumScrollBegin={() => { userMomentum.current = pendingMomentum.current; pendingMomentum.current = false; }}
    onMomentumScrollEnd={({ nativeEvent }) => {
      if (userMomentum.current) { recordDirection(nativeEvent); resumeFollowing(nativeEvent); }
      userMomentum.current = false; pendingMomentum.current = false;
    }}
    onScroll={({ nativeEvent }) => {
      const { contentOffset, contentSize } = nativeEvent;
      // A size-only scroll event during token layout must not cancel an existing follow intent.
      if (Math.abs(contentOffset.y - scroll.current.offset) > 0.5 || contentSize.height === scroll.current.contentHeight) {
        nearBottom.current = isNearBottom(nativeEvent);
      }
      // Actual offset movement still matters while new tokens change the content height.
      // Height-only events have zero movement; they cannot resume a paused turn.
      if (userDragging.current || userMomentum.current) recordDirection(nativeEvent);
      scroll.current = { offset: contentOffset.y, contentHeight: contentSize.height };
    }}
    scrollEventThrottle={16}
    onContentSizeChange={() => {
      const previous = lastOutput.current;
      const changed = last && (previous?.id !== last.id || previous.content !== last.content || previous.reasoning !== last.reasoning);
      lastOutput.current = last ? { id: last.id, content: last.content, reasoning: last.reasoning } : null;
      // Never use MVCP bottom autoscroll: its pending callback can survive disabling the prop.
      // Only fresh output can request a follow, after measurement; toggles pause immediately.
      if (changed && generating && nearBottom.current && pausedTurn.current !== last.id
        && !userDragging.current && !pendingMomentum.current && !userMomentum.current) {
        list.current?.scrollToEnd({ animated: false });
      }
    }}
  />;
}

const styles = StyleSheet.create({
  messages: { paddingHorizontal: 23, paddingTop: 10, paddingBottom: 16 },
  timestamp: { ...Typography.caption, textAlign: 'center', marginTop: 8, marginBottom: 18 },
});
