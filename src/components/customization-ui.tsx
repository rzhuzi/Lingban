import { Typography } from '@/constants/typography';
import { AppIcon as Ionicons } from '@/components/app-icon';
import { router } from 'expo-router';
import type { ComponentProps, ReactNode, Ref } from 'react';
import { useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
  type StyleProp,
  type ScrollViewInstance,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Fonts } from '@/constants/theme';
import { useCompanion } from '@/features/companion/companion-store';
import { useTheme } from '@/hooks/use-theme';

type IconName = ComponentProps<typeof Ionicons>['name'];
type Tone = 'primary' | 'accent' | 'danger' | 'muted' | 'neutral';

export function DetailScreen({ title, subtitle, children, right, onBack, scrollRef, footer }: {
  title: string; subtitle?: string; children: ReactNode; right?: ReactNode; onBack?: () => void; scrollRef?: Ref<ScrollViewInstance>; footer?: ReactNode;
}) {
  const theme = useTheme();
  const { ready, saveError, retrySave } = useCompanion();
  return (
    <SafeAreaView style={[ui.screen, { backgroundColor: theme.background }]}>
      <View style={ui.pageHeading}>
        <View style={ui.headingSide}>
          <IconButton name="chevron-back" label="返回" onPress={() => {
            if (onBack) { onBack(); return; }
            if (router.canGoBack()) router.back();
            else router.replace('/(tabs)');
          }} />
        </View>
        <ThemedText accessibilityRole="header" style={ui.pageTitle}>{title}</ThemedText>
        <View style={[ui.headingSide, ui.rightSide]}>{right}</View>
      </View>
      {subtitle ? <ThemedText themeColor="textSecondary" style={ui.subtitle}>{subtitle}</ThemedText> : null}
      {!ready ? <View style={ui.loading}>{saveError ? <><ThemedText style={ui.loadingError}>{saveError}</ThemedText><SmallAction label="重新加载" icon="refresh" onPress={retrySave} /></> : <ActivityIndicator color={theme.primary} />}</View> : (
        <KeyboardAvoidingView style={ui.screen} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <ScrollView ref={scrollRef} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}
            contentContainerStyle={ui.pageContent}>
            {saveError ? <Pressable accessibilityRole="button" onPress={retrySave} style={[ui.error, { backgroundColor: theme.primarySurface }]}>
              <Ionicons name="alert-circle-outline" size={18} color={theme.danger} />
              <ThemedText style={[ui.errorText, { color: theme.danger }]}>{saveError}，点此重试</ThemedText>
            </Pressable> : null}
            {children}
          </ScrollView>
          {footer ? <View style={[ui.pageFooter, { backgroundColor: theme.background }]}>{footer}</View> : null}
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

export function Card({ children, style, variant = 'flat' }: { children: ReactNode; style?: StyleProp<ViewStyle>; variant?: 'flat' | 'inset' }) {
  const theme = useTheme();
  return <View style={[ui.card, variant === 'inset' && ui.insetCard,
    { backgroundColor: variant === 'inset' ? theme.backgroundElement : theme.background, borderColor: theme.border }, style]}>{children}</View>;
}

export function SectionHeading({ title, action, onAction, icon }: {
  title: string; action?: string; onAction?: () => void; icon?: IconName;
}) {
  return <View style={ui.sectionHeading}>
    <ThemedText accessibilityRole="header" style={ui.sectionTitle}>{title}</ThemedText>
    {action && onAction ? <SmallAction label={action} icon={icon} onPress={onAction} /> : null}
  </View>;
}

export function IconButton({ name, label, onPress, tone = 'muted' }: {
  name: IconName; label: string; onPress: () => void; tone?: Tone;
}) {
  const theme = useTheme();
  const color = tone === 'primary' ? theme.primary : tone === 'accent' ? theme.accent : tone === 'danger' ? theme.danger : theme.textSecondary;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
    hitSlop={4} style={({ pressed }) => [ui.iconButton, { opacity: pressed ? 0.55 : 1 }]}>
    <Ionicons name={name} size={19} color={color} />
  </Pressable>;
}

export function SmallAction({ label, icon, onPress, tone = 'primary' }: {
  label: string; icon?: IconName; onPress: () => void; tone?: Tone;
}) {
  const theme = useTheme();
  const color = tone === 'accent' ? theme.accent : tone === 'danger' ? theme.danger : tone === 'muted' || tone === 'neutral' ? theme.textSecondary : theme.primary;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [ui.smallAction, { opacity: pressed ? 0.5 : 1 }]}>
    {icon ? <Ionicons name={icon} size={15} color={color} /> : null}
    <ThemedText style={[ui.actionLabel, { color }]}>{label}</ThemedText>
  </Pressable>;
}

export function Chip({ label, onPress, onRemove, tone = 'neutral', selected = false }: {
  label: string; onPress?: () => void; onRemove?: () => void; tone?: Tone; selected?: boolean;
}) {
  const theme = useTheme();
  const color = tone === 'primary' ? theme.primary : tone === 'accent' ? theme.accent : theme.textSecondary;
  return <View style={[ui.chip, {
    backgroundColor: tone === 'primary' ? theme.primarySurface : tone === 'accent' ? theme.accentSurface : theme.backgroundElement,
    borderColor: selected ? color : 'transparent',
  }]}>
    <Pressable accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={label} onPress={onPress} disabled={!onPress} style={ui.chipBody}>
      <ThemedText style={[ui.chipLabel, { color }]}>{label}</ThemedText>
    </Pressable>
    {onRemove ? <Pressable accessibilityRole="button" accessibilityLabel={`删除${label}`} hitSlop={6} onPress={onRemove} style={ui.chipRemove}>
      <Ionicons name="close" size={13} color={color} />
    </Pressable> : null}
  </View>;
}

export function Field({ label, style, multiline, ...props }: TextInputProps & { label?: string }) {
  const theme = useTheme();
  return <View style={ui.fieldGroup}>
    {label ? <ThemedText style={ui.fieldLabel}>{label}</ThemedText> : null}
    <TextInput {...props} accessibilityLabel={props.accessibilityLabel ?? label}
      multiline={multiline} placeholderTextColor={theme.textSecondary} selectionColor={theme.primary}
      style={[ui.input, multiline && ui.multiline, { color: theme.text, backgroundColor: theme.background, borderColor: theme.border }, style]} />
  </View>;
}

export function Sheet({ visible, title, onClose, onSave, saveLabel = '保存', saveDisabled, children, footer }: {
  visible: boolean; title: string; onClose: () => void; onSave?: () => void; saveLabel?: string;
  saveDisabled?: boolean; children: ReactNode; footer?: ReactNode;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [progress] = useState(() => new Animated.Value(0));
  const [panelHeight, setPanelHeight] = useState(0);
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    let changed = false;
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
      changed = true;
      if (active) setReduceMotion(enabled);
    });
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (active && !changed) setReduceMotion(enabled);
    }, () => { if (active && !changed) setReduceMotion(true); });
    return () => { active = false; subscription.remove(); };
  }, []);

  useEffect(() => {
    if (!visible) {
      progress.stopAnimation();
      progress.setValue(0);
      return;
    }
    if (reduceMotion === null) return;
    if (reduceMotion) { progress.setValue(1); return; }
    const animation = Animated.timing(progress, { toValue: 1, duration: 220, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [progress, reduceMotion, visible]);

  // Native slide moves the entire modal, including its full-screen backdrop.
  // Dismiss immediately when hidden: several callers replace one Sheet with another.
  return <Modal visible={visible} animationType="none" transparent statusBarTranslucent onRequestClose={onClose}>
    <View style={ui.screen}>
      <Animated.View style={[StyleSheet.absoluteFill, ui.backdrop, { opacity: progress }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={`关闭${title}`} onPress={onClose} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <KeyboardAvoidingView pointerEvents="box-none" style={ui.sheetOverlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <Animated.View onLayout={(event) => setPanelHeight(event.nativeEvent.layout.height)}
        style={[ui.sheet, { backgroundColor: theme.surface, paddingBottom: Math.max(insets.bottom, 16),
          transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [panelHeight || height, 0] }) }] }]}>
        <View style={[ui.handle, { backgroundColor: theme.border }]} />
        <View style={ui.sheetHeading}>
          <ThemedText accessibilityRole="header" style={ui.sheetTitle}>{title}</ThemedText>
          <IconButton name="close" label={`关闭${title}`} onPress={onClose} />
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={ui.sheetContent} showsVerticalScrollIndicator={false}>
          {children}
        </ScrollView>
        {onSave ? <Pressable accessibilityRole="button" accessibilityLabel={saveLabel} disabled={saveDisabled} onPress={onSave}
          style={({ pressed }) => [ui.saveButton, { backgroundColor: theme.primaryStrong, opacity: saveDisabled ? 0.4 : pressed ? 0.75 : 1 }]}>
          <ThemedText style={[ui.saveLabel, { color: theme.onPrimary }]}>{saveLabel}</ThemedText>
        </Pressable> : null}
        {footer ? <View style={ui.sheetFooter}>{footer}</View> : null}
      </Animated.View>
      </KeyboardAvoidingView>
    </View>
  </Modal>;
}

type Confirmation = {
  title: string; message: string; confirmLabel?: string; destructive?: boolean; onConfirm: () => void;
};

/** An app confirmation works on native and web, including while an edit sheet is open. */
export function useConfirmation() {
  const theme = useTheme();
  const [request, setRequest] = useState<Confirmation | null>(null);
  const confirm = (next: Confirmation) => { Keyboard.dismiss(); setRequest(next); };
  const dialog = <Modal visible={request !== null} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setRequest(null)}>
    <View style={ui.confirmOverlay}>
      <Pressable accessibilityLabel="取消操作" style={[StyleSheet.absoluteFill, ui.backdrop]} onPress={() => setRequest(null)} />
      <View style={[ui.confirmCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <ThemedText style={ui.sheetTitle}>{request?.title}</ThemedText>
        <ThemedText themeColor="textSecondary" style={ui.confirmMessage}>{request?.message}</ThemedText>
        <View style={ui.confirmActions}>
          <SmallAction label="取消" tone="muted" onPress={() => setRequest(null)} />
          <SmallAction label={request?.confirmLabel ?? '确定'} tone={request?.destructive ? 'danger' : 'primary'} onPress={() => {
            request?.onConfirm();
            setRequest(null);
          }} />
        </View>
      </View>
    </View>
  </Modal>;
  return { confirm, dialog };
}

const ui = StyleSheet.create({
  screen: { flex: 1 },
  pageHeading: { flexDirection: 'row', alignItems: 'center', minHeight: 58, paddingHorizontal: 12 },
  headingSide: { width: 44 },
  rightSide: { alignItems: 'flex-end' },
  pageTitle: { ...Typography.pageTitle, flex: 1, textAlign: 'center', },
  subtitle: { ...Typography.secondary, textAlign: 'center', paddingHorizontal: 24, marginBottom: 12 },
  pageContent: { gap: 12, padding: 22, paddingTop: 4, paddingBottom: 24, width: '100%', maxWidth: 600, alignSelf: 'center' },
  pageFooter: { paddingHorizontal: 22, paddingTop: 10, paddingBottom: 8, gap: 8, width: '100%', maxWidth: 600, alignSelf: 'center' },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  loadingError: { ...Typography.secondary, paddingHorizontal: 24, textAlign: 'center', },
  card: { paddingVertical: 16, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  insetCard: { borderRadius: 12, padding: 14, borderWidth: StyleSheet.hairlineWidth },
  sectionHeading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  sectionTitle: { ...Typography.section },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  smallAction: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, minHeight: 44, paddingHorizontal: 2 },
  actionLabel: { ...Typography.label },
  chip: { borderWidth: 1, borderRadius: 6, flexDirection: 'row', alignItems: 'center', maxWidth: '100%' },
  chipBody: { paddingHorizontal: 10, paddingVertical: 5, minHeight: 34, justifyContent: 'center', flexShrink: 1 },
  chipLabel: { ...Typography.secondary },
  chipRemove: { paddingHorizontal: 8, minHeight: 34, justifyContent: 'center' },
  fieldGroup: { gap: 7 },
  fieldLabel: { ...Typography.label },
  input: { ...Typography.input, fontFamily: Fonts.sans, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 13, paddingVertical: 11, minHeight: 48 },
  multiline: { minHeight: 112, textAlignVertical: 'top' },
  sheetOverlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { backgroundColor: '#00000033' },
  sheet: { maxHeight: '90%', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 22, paddingTop: 9 },
  handle: { width: 30, height: 3, borderRadius: 2, alignSelf: 'center', marginBottom: 6 },
  sheetHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  sheetTitle: { ...Typography.pageTitle },
  sheetContent: { gap: 15, paddingBottom: 18 },
  saveButton: { alignItems: 'center', justifyContent: 'center', minHeight: 48, paddingVertical: 12, borderRadius: 12, marginTop: 6 },
  saveLabel: { ...Typography.button },
  sheetFooter: { alignItems: 'center', paddingTop: 8 },
  error: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: 12 },
  errorText: { ...Typography.secondary, flex: 1 },
  confirmOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 30 },
  confirmCard: { width: '100%', maxWidth: 330, padding: 22, borderRadius: 16, borderWidth: 1, gap: 12 },
  confirmMessage: { ...Typography.body },
  confirmActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 24, marginTop: 4 },
});
