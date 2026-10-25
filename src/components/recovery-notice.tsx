import { Typography } from '@/constants/typography';
import { AppIcon as Ionicons } from '@/components/app-icon';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import { useAppRecoveryStore } from '@/stores/app-stores';

export function RecoveryNotice() {
  const theme = useTheme();
  const notice = useAppRecoveryStore((state) => state.notice);
  const dismissNotice = useAppRecoveryStore((state) => state.dismissNotice);
  const migrationNotice = useAppRecoveryStore((state) => state.migrationNotice);
  const migrationError = useAppRecoveryStore((state) => state.migrationError);
  const migrationBusy = useAppRecoveryStore((state) => state.migrationBusy);
  const dismissMigrationNotice = useAppRecoveryStore((state) => state.dismissMigrationNotice);
  if (!notice && !migrationNotice) return null;
  return <View>
    {notice ? <View accessibilityRole="alert" style={[styles.notice, { backgroundColor: theme.backgroundElement }]}>
    <Ionicons name="information-circle-outline" size={17} color={theme.textSecondary} />
    <ThemedText themeColor="textSecondary" style={styles.text}>{notice}</ThemedText>
    <Pressable accessibilityRole="button" accessibilityLabel="关闭恢复提示" onPress={dismissNotice} hitSlop={8} style={styles.close}>
      <Ionicons name="close" size={18} color={theme.textSecondary} />
    </Pressable>
    </View> : null}
    {migrationNotice ? <View style={[styles.notice, { backgroundColor: theme.backgroundElement }]}>
      <Ionicons name="information-circle-outline" size={17} color={theme.textSecondary} />
      <ThemedText themeColor="textSecondary" style={styles.text}>{migrationNotice.message}{migrationError ? `\n${migrationError}` : ''}</ThemedText>
      <Pressable accessibilityRole="button" accessibilityLabel="关闭模式升级提示" disabled={migrationBusy}
        onPress={() => void dismissMigrationNotice()} hitSlop={8} style={styles.close}>
        <Ionicons name="close" size={18} color={theme.textSecondary} />
      </Pressable>
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  notice: { marginHorizontal: 16, marginBottom: 6, padding: 11, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  text: { ...Typography.secondary, flex: 1, },
  close: { minHeight: 28, minWidth: 28, alignItems: 'center', justifyContent: 'center' },
});
