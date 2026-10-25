import { router, useLocalSearchParams } from 'expo-router';

import { Card, DetailScreen, SmallAction } from '@/components/customization-ui';
import { ThemedText } from '@/components/themed-text';
import { Typography } from '@/constants/typography';
import { useCompanion } from '@/features/companion/companion-store';

export default function CotPresetRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data } = useCompanion();
  const preset = data.thinking.templates.find((template) => template.id === id);
  return <DetailScreen title={preset?.name ?? '提示词模板'}>
    <Card>
      {preset ? <>
        {preset.description ? <ThemedText themeColor="textSecondary" style={Typography.secondary}>{preset.description}</ThemedText> : null}
        <ThemedText selectable style={Typography.body}>{preset.prompt}</ThemedText>
      </> : <ThemedText themeColor="textSecondary">未找到这个模板</ThemedText>}
      <SmallAction label="管理模板" icon="create-outline" onPress={() => router.replace('/thinking')} />
    </Card>
  </DetailScreen>;
}
