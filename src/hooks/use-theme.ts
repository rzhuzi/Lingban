/**
 * Learn more about light and dark modes:
 * https://docs.expo.dev/guides/color-schemes/
 */

import { useAppTheme } from '@/lib/theme/theme-provider';

export function useTheme() {
  return useAppTheme().colors;
}
