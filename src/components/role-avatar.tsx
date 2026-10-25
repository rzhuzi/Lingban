import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppIcon } from '@/components/app-icon';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

export type RoleAvatarProps = {
  profile: { name: string; avatarUri: string | null };
  size?: number;
};

/** A role's own image or initial; no preset character artwork. */
export function RoleAvatar({ profile, size = 40 }: RoleAvatarProps) {
  const theme = useTheme();
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const uri = profile.avatarUri?.trim();
  const initial = Array.from(profile.name.trim())[0];

  return <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: theme.primarySurface }]}>
    {uri && uri !== failedUri ? <Image key={uri} source={{ uri }} contentFit="cover" transition={0}
      alt="" accessible={false} onError={() => setFailedUri(uri)} style={StyleSheet.absoluteFill} /> : initial ? (
      <ThemedText accessible={false} style={{ fontSize: Math.round(size * 0.4), lineHeight: size, color: theme.primary,
        fontWeight: '500', textAlign: 'center' }}>{initial.toLocaleUpperCase()}</ThemedText>
    ) : <AppIcon name="person-outline" size={Math.round(size * 0.45)} color={theme.primary} />}
  </View>;
}

const styles = StyleSheet.create({
  avatar: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 },
});
