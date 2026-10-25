import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { createContext, useContext, useEffect, useMemo, type PropsWithChildren } from 'react';

import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useSettingsStore } from '@/stores/app-stores';

type AppTheme = {
  scheme: 'light' | 'dark';
  colors: typeof Colors.light | typeof Colors.dark;
};

const ThemeContext = createContext<AppTheme | null>(null);

export function AppThemeProvider({ children }: PropsWithChildren) {
  const systemScheme = useColorScheme();
  const preference = useSettingsStore((state) => state.settings.theme);
  const scheme = preference === 'system' ? systemScheme === 'dark' ? 'dark' : 'light' : preference;
  const value = useMemo<AppTheme>(() => ({ scheme, colors: Colors[scheme] }), [scheme]);

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(value.colors.background).catch(() => {});
  }, [value.colors.background]);

  return <ThemeContext.Provider value={value}>
    <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
    {children}
  </ThemeContext.Provider>;
}

export function useAppTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useAppTheme must be used within AppThemeProvider');
  return context;
}
