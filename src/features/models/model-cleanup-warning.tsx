import { Typography } from '@/constants/typography';
import { AppIcon as Ionicons } from '@/components/app-icon';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import { useModelStore } from '@/stores/app-stores';

export function ModelCleanupWarning() {
  const theme = useTheme();
  const cleanupPending = useModelStore((state) => state.credentialCleanupPending);
  const [pending, setPending] = useState(false);
  if (!cleanupPending) return null;

  const retry = async () => {
    if (pending) return;
    setPending(true);
    try { await useModelStore.getState().retryCredentialCleanup(); }
    catch { /* The pending flag keeps this retry visible until cleanup succeeds. */ }
    finally { setPending(false); }
  };

  return <View accessibilityRole="alert" style={[styles.notice, { backgroundColor: theme.primarySurface }]}>
    <Ionicons name="alert-circle-outline" size={18} color={theme.danger} />
    <ThemedText style={[styles.message, { color: theme.danger }]}>配置已保存，安全清理未完成。</ThemedText>
    <Pressable accessibilityRole="button" accessibilityLabel="重试安全清理" disabled={pending} onPress={() => { void retry(); }} style={styles.retry}>
      {pending ? <ActivityIndicator size="small" color={theme.danger} /> : <ThemedText style={[styles.retryLabel, { color: theme.danger }]}>重试</ThemedText>}
    </Pressable>
  </View>;
}

const styles = StyleSheet.create({
  notice: { borderRadius: 13, flexDirection: 'row', padding: 11, gap: 8, alignItems: 'center' },
  message: { ...Typography.secondary, flex: 1 },
  retry: { minWidth: 34, minHeight: 34, alignItems: 'center', justifyContent: 'center' },
  retryLabel: { ...Typography.compact },
});
