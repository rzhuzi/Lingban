import { StyleSheet, Text, type TextProps } from 'react-native';

import { Fonts, ThemeColor } from '@/constants/theme';
import { Typography } from '@/constants/typography';
import { useTheme } from '@/hooks/use-theme';

export type ThemedTextProps = TextProps & {
  type?: 'default' | 'title' | 'small' | 'smallBold' | 'subtitle' | 'link' | 'linkPrimary' | 'code';
  themeColor?: ThemeColor;
};

export function ThemedText({ style, type = 'default', themeColor, ...rest }: ThemedTextProps) {
  const theme = useTheme();

  return <Text style={[styles.base, { color: theme[themeColor ?? (type === 'linkPrimary' ? 'primary' : 'text')] }, styles[type], style]} {...rest} />;
}

const styles = StyleSheet.create({
  base: { fontFamily: Fonts.sans, includeFontPadding: false },
  small: Typography.secondary,
  smallBold: { ...Typography.secondary, fontWeight: '600' },
  default: Typography.body,
  title: Typography.title,
  subtitle: {
    fontSize: 20,
    lineHeight: 30,
    fontWeight: '600',
  },
  link: {
    ...Typography.label,
  },
  linkPrimary: {
    ...Typography.label,
  },
  code: {
    ...Typography.code,
    fontFamily: Fonts.mono,
  },
});
