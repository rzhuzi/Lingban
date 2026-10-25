import { Typography } from '@/constants/typography';
import { AppIcon as Ionicons } from '@/components/app-icon';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState, type PropsWithChildren } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import { initializeStores } from '@/stores/app-stores';

void SplashScreen.preventAutoHideAsync().catch(() => {});

export function AppBootstrap({ children }: PropsWithChildren) {
  const theme = useTheme();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ ready: boolean; error: string | null }>({ ready: false, error: null });
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    let active = true;
    initializeStores().then(() => {
      if (active) setResult({ ready: true, error: null });
    }).catch((error: unknown) => {
      if (active) setResult({ ready: false, error: error instanceof Error ? error.message : '本地数据初始化失败。' });
    });
    return () => { active = false; };
  }, [attempt]);

  useEffect(() => {
    if (result.ready || result.error) SplashScreen.hide();
  }, [result.ready, result.error]);

  if (result.ready) return children;

  return <View style={[styles.screen, { backgroundColor: theme.background }]}>
    {result.error ? <View style={styles.errorContent}>
      <View style={[styles.errorIcon, { backgroundColor: theme.primarySurface }]}><Ionicons name="refresh-outline" size={29} color={theme.primary} /></View>
      <ThemedText style={styles.title}>暂时无法启动</ThemedText>
      <ThemedText themeColor="textSecondary" style={styles.hint}>本地数据还未准备好，请重试。</ThemedText>
      <Pressable accessibilityRole="button" accessibilityLabel="重新启动" style={[styles.retry, { backgroundColor: theme.primaryStrong }]} onPress={() => {
        setResult({ ready: false, error: null });
        setShowDetails(false);
        setAttempt((value) => value + 1);
      }}><ThemedText style={[styles.retryLabel, { color: theme.onPrimary }]}>重试</ThemedText></Pressable>
      <Pressable accessibilityRole="button" onPress={() => setShowDetails(!showDetails)} style={styles.detailsButton}><ThemedText themeColor="textSecondary" style={styles.detailsLabel}>{showDetails ? '收起详情' : '查看详情'}</ThemedText></Pressable>
      {showDetails ? <ThemedText selectable themeColor="textSecondary" style={styles.details}>{result.error}</ThemedText> : null}
    </View> : <ActivityIndicator color={theme.primary} />}
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 },
  errorContent: { alignItems: 'center', maxWidth: 420, gap: 12, width: '100%' },
  errorIcon: { width: 64, height: 64, borderRadius: 22, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  title: { ...Typography.title },
  hint: { ...Typography.body, textAlign: 'center', },
  retry: { minWidth: 104, paddingHorizontal: 28, minHeight: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  retryLabel: { ...Typography.button, color: '#FFFFFF', },
  detailsButton: { padding: 8 },
  detailsLabel: { ...Typography.compact },
  details: { ...Typography.secondary, textAlign: 'center' },
});
