import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';

import { AppBootstrap } from '@/components/app-bootstrap';
import { Colors } from '@/constants/theme';
import { CompanionProvider } from '@/features/companion/companion-store';
import { AppThemeProvider, useAppTheme } from '@/lib/theme/theme-provider';

/** Keep navigation surfaces consistent with the app's light and dark palettes. */
function buildNavTheme(scheme: 'light' | 'dark') {
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  const colors = Colors[scheme];
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: colors.primary,
      background: colors.background,
      card: colors.background,
      text: colors.text,
      border: colors.border,
    },
  };
}

function RootNavigation() {
  const { scheme } = useAppTheme();
  const navTheme = buildNavTheme(scheme);

  return (
    <CompanionProvider>
      <ThemeProvider value={navTheme}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="thinking" />
          <Stack.Screen name="models" />
          <Stack.Screen name="cot" />
          <Stack.Screen name="persona" />
          <Stack.Screen name="role" />
        </Stack>
      </ThemeProvider>
    </CompanionProvider>
  );
}

export default function RootLayout() {
  return <AppThemeProvider><AppBootstrap><RootNavigation /></AppBootstrap></AppThemeProvider>;
}
