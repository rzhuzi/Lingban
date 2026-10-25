import type { TextStyle } from 'react-native';

/** Shared reading sizes. Keep supporting copy readable without making every label a heading. */
export const Typography = {
  body: { fontSize: 16, lineHeight: 26, fontWeight: '400' },
  chat: { fontSize: 17, lineHeight: 29, fontWeight: '400' },
  input: { fontSize: 16, lineHeight: 25, fontWeight: '400' },
  row: { fontSize: 16, lineHeight: 25, fontWeight: '400' },
  rowTitle: { fontSize: 16, lineHeight: 25, fontWeight: '500' },
  pageTitle: { fontSize: 18, lineHeight: 28, fontWeight: '600' },
  title: { fontSize: 24, lineHeight: 34, fontWeight: '600' },
  section: { fontSize: 16, lineHeight: 25, fontWeight: '600' },
  label: { fontSize: 15, lineHeight: 23, fontWeight: '500' },
  button: { fontSize: 16, lineHeight: 24, fontWeight: '500' },
  secondary: { fontSize: 14, lineHeight: 23, fontWeight: '400' },
  caption: { fontSize: 13, lineHeight: 20, fontWeight: '400' },
  compact: { fontSize: 14, lineHeight: 22, fontWeight: '500' },
  code: { fontSize: 14, lineHeight: 23, fontWeight: '400' },
} as const satisfies Record<string, TextStyle>;
