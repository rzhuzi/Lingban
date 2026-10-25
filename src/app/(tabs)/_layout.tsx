import { Stack } from 'expo-router';

export const unstable_settings = { anchor: 'index' };

/** 顶部更多菜单统一承载原底部 Tab 的页面入口。 */
export default function AppLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, animation: 'fade' }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="history" />
      <Stack.Screen name="persona" />
      <Stack.Screen name="settings" />
    </Stack>
  );
}
