import { AppIcon as Ionicons } from '@/components/app-icon';
import { router, type Href, usePathname } from 'expo-router';
import { useState, type ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { RecoveryNotice } from '@/components/recovery-notice';
import { RoleAvatar } from '@/components/role-avatar';
import { Spacing } from '@/constants/theme';
import { Typography } from '@/constants/typography';
import { useTheme } from '@/hooks/use-theme';
import { ChatComposer } from '@/features/chat/chat-composer';
import { ModelPicker } from '@/features/models/model-picker';
import { RolePicker } from '@/features/chat/role-picker';
import { useChatRole } from '@/features/chat/use-chat-role';
import { startNewConversation } from '@/lib/chat/engine';
import { useChatRuntimeStore } from '@/lib/chat/runtime';
import { useAppMaintenanceStore, useChatStore, useModelStore, usePersonaStore } from '@/stores/app-stores';

type AppRoute = '/(tabs)' | '/(tabs)/history' | '/(tabs)/persona' | '/(tabs)/settings' | '/models';
type AppShellProps = { children: ReactNode; showComposer?: boolean };
type Overlay = 'model' | 'role' | 'navigation' | null;

const navigationItems: {
  route: AppRoute;
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
}[] = [
  { route: '/(tabs)', label: '聊天', icon: 'chatbubble-ellipses-outline' },
  { route: '/(tabs)/history', label: '历史会话', icon: 'time-outline' },
  { route: '/(tabs)/persona', label: '角色与记忆', icon: 'person-outline' },
  { route: '/(tabs)/settings', label: '设置', icon: 'settings-outline' },
];

function getActiveRoute(pathname: string): AppRoute {
  if (pathname.endsWith('/history')) return '/(tabs)/history';
  if (pathname.endsWith('/persona')) return '/(tabs)/persona';
  if (pathname.endsWith('/settings')) return '/(tabs)/settings';
  return '/(tabs)';
}

function AppHeader({ onOpen }: { onOpen: (overlay: Overlay) => void }) {
  const theme = useTheme();
  const { role } = useChatRole();
  const activeModelName = useModelStore((state) => state.models.find((model) => model.id === role?.configuration?.currentModelId)?.name);
  const runtimeBusy = useChatRuntimeStore((state) => state.isSending || state.hasUnsaved);
  const personaBusy = usePersonaStore((state) => state.busy);
  const maintenance = useAppMaintenanceStore((state) => state.active);
  const busy = runtimeBusy || personaBusy || maintenance;
  return (
    <View style={styles.header}>
      <View style={styles.brand}>
        <Pressable accessibilityRole="button" accessibilityLabel="查看当前角色" disabled={busy || !role}
          onPress={() => { if (role) router.push({ pathname: '/role', params: { id: role.id } }); }}
          style={[styles.brandMark, { opacity: busy ? 0.4 : 1 }]}>
          <RoleAvatar profile={role?.profile ?? { name: '', avatarUri: null }} size={32} />
        </Pressable>
        <View style={styles.roleIdentity}>
          <Pressable accessibilityRole="button" accessibilityLabel="选择角色" disabled={busy}
            onPress={() => onOpen('role')} style={styles.roleNameRow}>
            <ThemedText numberOfLines={1} style={styles.brandName}>{role?.profile.name ?? '角色已删除'}</ThemedText>
            <Ionicons name="chevron-down" size={12} color={theme.textSecondary} />
          </Pressable>
        </View>
      </View>

      <View style={styles.headerActions}>
        <Pressable
          accessibilityLabel={activeModelName ? `选择模型，当前：${activeModelName}` : '选择模型'}
          accessibilityRole="button"
          hitSlop={{ top: 7, bottom: 7 }}
          disabled={busy || !role}
          onPress={() => onOpen('model')}
          style={({ pressed }) => [
            styles.modelButton,
            {
              backgroundColor: theme.backgroundElement,
              opacity: busy || !role ? 0.45 : pressed ? 0.72 : 1,
            },
          ]}
        >
          <ThemedText numberOfLines={1} style={styles.modelButtonLabel}>{activeModelName ?? '选择模型'}</ThemedText>
          <Ionicons name="chevron-down" size={12} color={theme.textSecondary} />
        </Pressable>

        <Pressable
          accessibilityLabel="打开导航菜单"
          accessibilityRole="button"
          onPress={() => onOpen('navigation')}
          style={({ pressed }) => [
            styles.moreButton,
            {
              backgroundColor: pressed ? theme.backgroundElement : 'transparent',
              opacity: pressed ? 0.72 : 1,
            },
          ]}
        >
          <Ionicons name="ellipsis-horizontal" size={18} color={theme.text} />
        </Pressable>
      </View>
    </View>
  );
}

function SecondaryHeader({ route }: { route: AppRoute }) {
  const theme = useTheme();
  const title = navigationItems.find((item) => item.route === route)?.label ?? '';
  return <View style={[styles.header, styles.secondaryHeader]}>
    <Pressable accessibilityRole="button" accessibilityLabel="返回对话"
      onPress={() => router.dismissTo('/(tabs)')}
      style={({ pressed }) => [styles.backButton, { opacity: pressed ? 0.55 : 1 }]}>
      <Ionicons name="chevron-back" size={21} color={theme.text} />
    </Pressable>
    <ThemedText accessibilityRole="header" style={styles.pageTitle}>{title}</ThemedText>
    <View style={styles.headerSide} />
  </View>;
}

function NavigationMenu({
  visible,
  onClose,
  activeRoute,
  top,
}: {
  visible: boolean;
  onClose: () => void;
  activeRoute: AppRoute;
  top: number;
}) {
  const theme = useTheme();
  const { roleId, role } = useChatRole();
  const runtimeBusy = useChatRuntimeStore((state) => state.isSending || state.hasUnsaved);
  const personaBusy = usePersonaStore((state) => state.busy);
  const maintenance = useAppMaintenanceStore((state) => state.active);
  const busy = runtimeBusy || personaBusy || maintenance;

  async function newChat() {
    if (busy) return;
    try {
      // A new conversation follows the role shown in the current session's header.
      if (role && role.id !== usePersonaStore.getState().activePersonaId) await usePersonaStore.getState().switchPersona(role.id);
      startNewConversation();
      onClose();
      router.dismissTo('/(tabs)');
    } catch { useChatRuntimeStore.setState({ error: '无法使用这个角色开始聊天，请重试。' }); }
  }

  const goTo = (route: AppRoute) => {
    onClose();
    if (route === '/(tabs)/persona' && roleId) { router.push({ pathname: '/role', params: { id: roleId } }); return; }
    if (route === '/models') router.push('/models');
    else if (route === '/(tabs)') router.dismissTo('/(tabs)');
    else if (route !== activeRoute) {
      // Keep chat below the secondary page so Android Back returns to this conversation.
      if (activeRoute === '/(tabs)') router.push(route as Href);
      else router.replace(route as Href);
    }
  };

  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <View style={styles.overlay}>
        <Pressable
          accessibilityLabel="关闭导航菜单"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <View
          style={[
            styles.navigationMenu,
            { backgroundColor: theme.background, borderColor: theme.border, top },
          ]}
        >
          <Pressable accessibilityRole="button" accessibilityLabel="新建聊天" disabled={busy}
            onPress={() => { void newChat(); }} style={[styles.navigationItem, { opacity: busy ? 0.45 : 1 }]}>
            <Ionicons name="create-outline" size={18} color={theme.primary} />
            <ThemedText style={styles.navigationItemText}>新建聊天</ThemedText>
          </Pressable>
          <View style={[styles.menuDivider, { backgroundColor: theme.border }]} />
          {navigationItems.map((item) => {
            const isActive = item.route === activeRoute;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: isActive }}
                key={item.route}
                onPress={() => goTo(item.route)}
                style={({ pressed }) => [
                  styles.navigationItem,
                  {
                    backgroundColor: isActive || pressed ? theme.backgroundElement : 'transparent',
                  },
                ]}
              >
                <Ionicons
                  name={item.icon}
                  size={18}
                  color={isActive ? theme.primary : theme.textSecondary}
                />
                <ThemedText style={styles.navigationItemText}>{item.label}</ThemedText>
                {isActive ? <View style={[styles.activeMark, { backgroundColor: theme.primary }]} /> : null}
              </Pressable>
            );
          })}
        </View>
      </View>
    </Modal>
  );
}

export function AppShell({ children, showComposer = false }: AppShellProps) {
  const [overlay, setOverlay] = useState<Overlay>(null);
  const theme = useTheme();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const activeRoute = getActiveRoute(pathname);
  const activeSessionId = useChatStore((state) => state.activeSessionId);

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.screen, { backgroundColor: theme.background }]}
    >
      {activeRoute === '/(tabs)' ? <AppHeader onOpen={setOverlay} /> : <SecondaryHeader route={activeRoute} />}
      <RecoveryNotice />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.screenContent}
      >
        <View style={styles.body}>{children}</View>
        {showComposer ? (
          <ChatComposer key={activeSessionId ?? 'new'} onSelectModel={() => setOverlay('model')} />
        ) : null}
      </KeyboardAvoidingView>

      <NavigationMenu
        activeRoute={activeRoute}
        onClose={() => setOverlay(null)}
        top={insets.top + 52}
        visible={overlay === 'navigation'}
      />
      <ModelPicker
        key={overlay === 'model' ? 'opened-model' : 'closed-model'}
        onClose={() => setOverlay(null)}
        visible={overlay === 'model'}
      />
      <RolePicker onClose={() => setOverlay(null)} visible={overlay === 'role'} />
    </SafeAreaView>
  );
}

export function ChatWelcome() {
  const { role } = useChatRole();

  return (
    <View style={styles.welcome}>
      <View style={styles.welcomeMark}><RoleAvatar profile={role?.profile ?? { name: '', avatarUri: null }} size={56} /></View>
      <ThemedText style={styles.welcomeTitle}>{role?.profile.name ?? '零伴'}</ThemedText>
      <ThemedText style={styles.welcomeHint} themeColor="textSecondary">
        想说点什么…
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  screenContent: { flex: 1, width: '100%', maxWidth: 800, alignSelf: 'center' },
  body: { flex: 1 },
  header: {
    minHeight: 60,
    width: '100%',
    maxWidth: 800,
    alignSelf: 'center',
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 7,
  },
  secondaryHeader: { paddingHorizontal: 12 },
  backButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerSide: { width: 44 },
  pageTitle: { ...Typography.pageTitle, textAlign: 'center', flex: 1 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 5, flex: 1, minWidth: 0 },
  brandMark: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roleIdentity: { flex: 1, minWidth: 0 },
  roleNameRow: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44 },
  brandName: { ...Typography.pageTitle, flexShrink: 1 },
  headerActions: { flexDirection: 'row', flexShrink: 1, maxWidth: '52%', alignItems: 'center', gap: 4 },
  modelButton: {
    maxWidth: 148,
    flexShrink: 1,
    minHeight: 36,
    borderRadius: 18,
    paddingHorizontal: 10,
    paddingVertical: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  modelButtonLabel: { ...Typography.compact, flexShrink: 1 },
  moreButton: {
    width: 34,
    height: 44,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlay: { flex: 1 },
  navigationMenu: {
    position: 'absolute',
    right: Spacing.three,
    width: 212,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: 6,
    gap: 2,
    elevation: 6,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
  },
  navigationItem: {
    minHeight: 48,
    borderRadius: 8,
    paddingHorizontal: 11,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
  },
  navigationItemText: { ...Typography.row, fontWeight: '700', flex: 1 },
  menuDivider: { height: StyleSheet.hairlineWidth, marginHorizontal: 8, marginVertical: 5 },
  activeMark: { width: 6, height: 6, borderRadius: 3 },
  welcome: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.five,
  },
  welcomeMark: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.three,
  },
  welcomeTitle: { ...Typography.title, textAlign: 'center' },
  welcomeHint: { ...Typography.body, marginTop: Spacing.one, textAlign: 'center' },
});
