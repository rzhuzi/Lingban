import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#171717',
    background: '#ffffff',
    surface: '#ffffff',
    primarySurface: '#f5f5f5',
    accentSurface: '#f5f5f5',
    backgroundElement: '#f6f6f6',
    backgroundSelected: '#e9e9e9',
    userBubble: '#f2f2f2',
    textSecondary: '#666666',
    primary: '#171717',
    primaryStrong: '#171717',
    onPrimary: '#ffffff',
    accent: '#525252',
    border: '#e8e8e8',
    danger: '#333333',
    success: '#525252',
  },
  dark: {
    text: '#f2f2f2',
    background: '#0c0c0c',
    surface: '#141414',
    primarySurface: '#202020',
    accentSurface: '#202020',
    backgroundElement: '#1c1c1c',
    backgroundSelected: '#303030',
    userBubble: '#242424',
    textSecondary: '#a3a3a3',
    primary: '#f2f2f2',
    primaryStrong: '#f2f2f2',
    onPrimary: '#111111',
    accent: '#c8c8c8',
    border: '#2d2d2d',
    danger: '#e0e0e0',
    success: '#c8c8c8',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'sans-serif',
    serif: 'serif',
    rounded: 'sans-serif',
    mono: 'monospace',
  },
  web: {
    sans: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
    serif: 'ui-serif, Georgia, "Noto Serif CJK SC", serif',
    rounded: 'ui-rounded, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
