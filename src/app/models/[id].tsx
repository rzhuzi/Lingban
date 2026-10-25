import { useLocalSearchParams } from 'expo-router';

import { MissingModel, ModelEditor } from '@/features/models/model-editor';
import { useModelStore } from '@/stores/app-stores';

export default function ModelEditorRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const model = useModelStore((state) => state.models.find((item) => item.id === id));
  if (id !== 'new' && !model) return <MissingModel />;
  return <ModelEditor key={id} model={model} />;
}
