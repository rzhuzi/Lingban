import { AppIcon as Ionicons } from '@/components/app-icon';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Fonts } from '@/constants/theme';
import { Typography } from '@/constants/typography';
import { useCompanion } from '@/features/companion/companion-store';
import { useTheme } from '@/hooks/use-theme';
import { sendChatMessage, stopGeneration } from '@/lib/chat/engine';
import { useChatRuntimeStore } from '@/lib/chat/runtime';
import { useModelStore, useChatStore, usePersonaStore, useAppMaintenanceStore } from '@/stores/app-stores';

export function ChatComposer({ onSelectModel }: { onSelectModel: () => void }) {
  const theme = useTheme();
  const { data: { profile } } = useCompanion();
  const sessionOwnerId = useChatStore((state) => state.sessions.find((session) => session.id === state.activeSessionId)?.personaId);
  const ownerName = usePersonaStore((state) => state.personas.find((persona) => persona.id === sessionOwnerId)?.profile.name);
  const personaBusy = usePersonaStore((state) => state.busy);
  const maintenance = useAppMaintenanceStore((state) => state.active);
  const [draft, setDraft] = useState('');
  const draftRevision = useRef(0);
  const sending = useChatRuntimeStore((state) => state.isSending);
  const hasUnsaved = useChatRuntimeStore((state) => state.hasUnsaved);
  const canSend = !!draft.trim() && !sending && !hasUnsaved && !personaBusy && !maintenance;

  const send = () => {
    if (!canSend) return;
    if (!useModelStore.getState().models.length) { onSelectModel(); return; }
    const text = draft.trim();
    const sentRevision = draftRevision.current;
    void sendChatMessage(text, () => {
      // Acceptance can wait for storage; edits made meanwhile belong to the next draft.
      if (draftRevision.current !== sentRevision) return;
      draftRevision.current += 1;
      setDraft('');
    });
  };

  return <View style={styles.area}>
    <View style={[styles.composer, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <TextInput accessibilityLabel="聊天消息输入框" multiline editable={!maintenance && !personaBusy}
        value={draft} onChangeText={(text) => { draftRevision.current += 1; setDraft(text); }} submitBehavior="newline"
        placeholder={`发消息给${ownerName ?? profile.name}…`} placeholderTextColor={theme.textSecondary}
        returnKeyType="default" selectionColor={theme.primary} maxLength={20000}
        style={[styles.input, { color: theme.text }]} />
      <Pressable accessibilityRole="button" accessibilityLabel={sending ? '停止生成' : '发送消息'}
        accessibilityState={{ disabled: !sending && !canSend }} disabled={!sending && !canSend}
        onPress={sending ? stopGeneration : send}
        hitSlop={5}
        style={({ pressed }) => [styles.send, { backgroundColor: sending || canSend ? theme.primaryStrong : theme.backgroundSelected, opacity: pressed ? 0.65 : 1 }]}>
        <Ionicons name={sending ? 'stop' : 'arrow-up'} size={sending ? 14 : 19} color={sending || canSend ? theme.onPrimary : theme.textSecondary} />
      </Pressable>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  area: { paddingHorizontal: 17, paddingTop: 10, paddingBottom: 9 },
  composer: { minHeight: 64, borderRadius: 21, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, gap: 8, flexDirection: 'row', alignItems: 'flex-end' },
  input: { ...Typography.input, fontFamily: Fonts.sans, flex: 1, minWidth: 0, minHeight: 40, maxHeight: 150, paddingHorizontal: 2, paddingVertical: 7, textAlignVertical: 'center' },
  send: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
});
