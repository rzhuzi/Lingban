import { Typography } from '@/constants/typography';
import { AppIcon as Ionicons } from '@/components/app-icon';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppShell } from '@/components/app-shell';
import { Field, Sheet, SmallAction, useConfirmation } from '@/components/customization-ui';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import { useChatRuntimeStore } from '@/lib/chat/runtime';
import { exportAllLocalChats, resetAllLocalData } from '@/lib/data/actions';
import { DataResetError } from '@/lib/data/reset-core';
import { useChatRole } from '@/features/chat/use-chat-role';
import type { ThemePreference } from '@/lib/db/types';
import { useModelStore, useSettingsStore } from '@/stores/app-stores';
import appConfig from '../../../app.json';

const themeOptions: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' },
];
const destinations = [
  { label: '角色与记忆', icon: 'person-outline', route: '/(tabs)/persona' },
  { label: '模型库', icon: 'cube-outline', route: '/models' },
  { label: '模板库', icon: 'sparkles-outline', route: '/cot' },
] as const;
type DataAction = 'export' | 'reset';

export default function SettingsScreen() {
  const theme = useTheme();
  const { roleId, role } = useChatRole();
  const modelCount = useModelStore((state) => state.models.length);
  const insets = useSafeAreaInsets();
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const saveError = useSettingsStore((state) => state.saveError);
  const retrySave = useSettingsStore((state) => state.retrySave);
  const sending = useChatRuntimeStore((state) => state.isSending);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState<DataAction | null>(null);
  const busyRef = useRef<DataAction | null>(null);
  const [actionError, setActionError] = useState<{ action: DataAction; message: string } | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearWord, setClearWord] = useState('');
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [nameOpen, setNameOpen] = useState(false);
  const { confirm, dialog } = useConfirmation();
  const name = nameDraft ?? settings.userName;
  function saveName() {
    if (busyRef.current) return;
    const value = name.trim();
    if (!value || Array.from(value).length > 100) { setFieldError('昵称不能为空且最多 100 字。'); return; }
    updateSettings({ userName: value });
    setNameDraft(null); setFieldError(null); setNameOpen(false);
  }
  async function runAction(action: DataAction) {
    if (busyRef.current) return;
    busyRef.current = action;
    setBusy(action); setActionError(null); setActionNotice(null);
    try {
      if (action === 'export') await exportAllLocalChats();
      else {
        const didReset = await resetAllLocalData();
        setClearOpen(false); setClearWord('');
        if (didReset) { setNameDraft(null); setFieldError(null); }
      }
      setActionNotice(action === 'export' ? '已打开文件导出。' : '清理已完成。');
    } catch (error) {
      setClearOpen(false); setClearWord('');
      if (error instanceof DataResetError && error.didReset) { setNameDraft(null); setFieldError(null); }
      setActionError({ action, message: error instanceof Error ? error.message : '操作未完成，请重试。' });
    } finally { busyRef.current = null; setBusy(null); }
  }
  function requestClear() {
    if (busyRef.current) return;
    confirm({ title: '清空本机数据？', message: '聊天、模型与密钥、人设记忆和设置都会清空，当前回复会停止。此操作无法撤销。',
      confirmLabel: '继续', destructive: true, onConfirm: () => { setClearWord(''); setClearOpen(true); } });
  }

  return <AppShell>
    <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}>
      <View style={styles.brand}>
        <View style={[styles.brandIcon, { backgroundColor: theme.backgroundElement }]}><Ionicons name="orbit" size={38} color={theme.text} /></View>
        <View style={styles.brandCopy}><ThemedText style={styles.brandName}>零伴</ThemedText><ThemedText themeColor="textSecondary" style={styles.version}>{appConfig.expo.version}</ThemedText></View>
      </View>
      {saveError ? <Pressable accessibilityRole="button" accessibilityLabel="重新保存设置" onPress={retrySave}
        style={[styles.notice, { backgroundColor: theme.primarySurface }]}>
        <Ionicons name="alert-circle-outline" size={17} color={theme.danger} />
        <ThemedText style={[styles.noticeText, { color: theme.danger }]}>{saveError} 点此重试</ThemedText>
      </Pressable> : null}
      <View style={styles.section}>
        <ThemedText accessibilityRole="header" themeColor="textSecondary" style={styles.sectionTitle}>偏好</ThemedText>
        <View style={[styles.group, { borderColor: theme.border }]}>
          <Pressable accessibilityRole="button" accessibilityLabel="外观" disabled={busy !== null} onPress={() => setAppearanceOpen(true)} style={styles.row}>
            <Ionicons name="sunny" size={18} color={theme.textSecondary} /><ThemedText style={[styles.label, styles.text]}>外观</ThemedText>
            <ThemedText style={styles.value} themeColor="textSecondary">{themeOptions.find((option) => option.value === settings.theme)?.label}</ThemedText><Ionicons name="chevron-forward" size={13} color={theme.textSecondary} />
          </Pressable>
          <View style={[styles.divider, { backgroundColor: theme.border }]} />
          <Pressable accessibilityRole="button" accessibilityLabel="修改我的昵称" disabled={busy !== null} onPress={() => setNameOpen(true)} style={styles.row}>
            <Ionicons name="person-outline" size={18} color={theme.textSecondary} /><ThemedText style={[styles.label, styles.text]}>我的昵称</ThemedText>
            <ThemedText numberOfLines={1} style={styles.value} themeColor="textSecondary">{settings.userName}</ThemedText><Ionicons name="chevron-forward" size={13} color={theme.textSecondary} />
          </Pressable>
        </View>
      </View>
      <View style={styles.section}>
        <ThemedText accessibilityRole="header" themeColor="textSecondary" style={styles.sectionTitle}>配置</ThemedText>
        <View style={[styles.group, { borderColor: theme.border }]}>
        {destinations.map((item, index) => <View key={item.route}>
          {index ? <View style={[styles.divider, { backgroundColor: theme.border }]} /> : null}
          <Pressable accessibilityRole="button" accessibilityLabel={item.label} onPress={() => {
            if (item.route === '/(tabs)/persona' && roleId) router.push({ pathname: '/role', params: { id: roleId } });
            else router.push(item.route);
          }} style={styles.row}>
            <Ionicons name={item.icon} size={18} color={theme.textSecondary} />
            <ThemedText style={[styles.label, styles.text]}>{item.label}</ThemedText>
            {item.route === '/(tabs)/persona' ? <ThemedText numberOfLines={1} style={styles.value} themeColor="textSecondary">{role?.profile.name}</ThemedText> : null}
            {item.route === '/models' ? <ThemedText style={styles.value} themeColor="textSecondary">{modelCount} 个模型</ThemedText> : null}
            <Ionicons name="chevron-forward" size={13} color={theme.textSecondary} />
          </Pressable>
        </View>)}
        </View>
      </View>
      <View style={styles.section}>
        <ThemedText accessibilityRole="header" themeColor="textSecondary" style={styles.sectionTitle}>数据</ThemedText>
        <View style={[styles.group, { borderColor: theme.border }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="导出全部会话" disabled={busy !== null || sending}
          onPress={() => { void runAction('export'); }} style={[styles.row, { opacity: busy || sending ? 0.45 : 1 }]}>
          <Ionicons name="download-outline" size={18} color={theme.textSecondary} /><ThemedText style={[styles.label, styles.text]}>导出全部会话</ThemedText>
          {busy === 'export' ? <ActivityIndicator size="small" color={theme.primary} /> : <Ionicons name="chevron-forward" size={13} color={theme.textSecondary} />}
        </Pressable>
        {sending ? <ThemedText themeColor="textSecondary" style={styles.hint}>回复结束后可导出。</ThemedText> : null}
        <View style={[styles.divider, { backgroundColor: theme.border, marginLeft: 0 }]} />
        <Pressable accessibilityRole="button" accessibilityLabel="清空本机数据" disabled={busy !== null}
          onPress={requestClear} style={[styles.row, { opacity: busy ? 0.45 : 1 }]}>
          <Ionicons name="trash-outline" size={18} color={theme.danger} /><ThemedText style={[styles.label, styles.text, { color: theme.danger }]}>清空本机数据</ThemedText>
          {busy === 'reset' ? <ActivityIndicator size="small" color={theme.danger} /> : null}
        </Pressable>
        </View>
      </View>
      {actionError ? <View accessibilityRole="alert" style={[styles.notice, { backgroundColor: theme.primarySurface }]}>
        <ThemedText style={[styles.noticeText, { color: theme.danger }]}>{actionError.message}</ThemedText>
        <SmallAction label={actionError.action === 'reset' ? '重试清理' : '重试导出'} icon="refresh" onPress={() => { void runAction(actionError.action); }} />
      </View> : null}
      {actionNotice ? <ThemedText style={styles.hint} themeColor="textSecondary">{actionNotice}</ThemedText> : null}
    </ScrollView>
    <Sheet visible={appearanceOpen} title="外观" onClose={() => setAppearanceOpen(false)}>
      {themeOptions.map((option) => <Pressable key={option.value} accessibilityRole="radio" accessibilityLabel={`外观：${option.label}`}
        accessibilityState={{ checked: settings.theme === option.value }} disabled={busy !== null}
        onPress={() => updateSettings({ theme: option.value })}
        style={({ pressed }) => [styles.themeOption, { borderBottomColor: theme.border, opacity: pressed ? 0.6 : 1 }]}>
        <ThemedText style={styles.label}>{option.label}</ThemedText>
        {settings.theme === option.value ? <Ionicons name="checkmark" size={18} color={theme.text} /> : null}
      </Pressable>)}
    </Sheet>
    <Sheet visible={nameOpen} title="我的昵称" onClose={() => setNameOpen(false)} onSave={saveName} saveLabel="保存昵称" saveDisabled={busy !== null}>
      <Field label="我的昵称" accessibilityLabel="我的昵称" value={name} onChangeText={setNameDraft} maxLength={200}
        editable={busy === null} onSubmitEditing={saveName} returnKeyType="done" />
      {fieldError ? <ThemedText accessibilityRole="alert" style={[styles.hint, { color: theme.danger }]}>{fieldError}</ThemedText> : null}
      <ThemedText themeColor="textSecondary" style={styles.hint}>在对话中用这个名字称呼你。</ThemedText>
    </Sheet>
    {dialog}
    <Sheet visible={clearOpen} title="再次确认清空" onClose={() => { if (!busy) setClearOpen(false); }}
      saveLabel="确认清空" saveDisabled={clearWord !== '清空' || busy !== null} onSave={() => { void runAction('reset'); }}>
      <ThemedText style={styles.hint} themeColor="textSecondary">输入“清空”，删除上述全部本机数据。</ThemedText>
      <Field accessibilityLabel="输入清空以确认" value={clearWord} onChangeText={setClearWord} editable={busy === null}
        autoCorrect={false} maxLength={10} placeholder="清空" />
    </Sheet>
  </AppShell>;
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 22, gap: 24, maxWidth: 600, width: '100%', alignSelf: 'center' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 20, paddingBottom: 6 },
  brandIcon: { width: 58, height: 58, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  brandCopy: { gap: 4 }, brandName: { ...Typography.title }, version: { ...Typography.caption },
  section: { gap: 10 }, sectionTitle: { ...Typography.compact }, group: { borderTopWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'center', gap: 11, minHeight: 60, paddingVertical: 12 },
  text: { flex: 1, minWidth: 0 }, label: { ...Typography.row }, hint: { ...Typography.secondary },
  value: { ...Typography.secondary, maxWidth: '40%', flexShrink: 1 },
  divider: { height: StyleSheet.hairlineWidth },
  themeOption: { minHeight: 48, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  notice: { borderRadius: 13, padding: 12, gap: 8, flexDirection: 'row', alignItems: 'center' },
  noticeText: { ...Typography.secondary, flex: 1 },
});
