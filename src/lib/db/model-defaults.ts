import type { ModelRecord } from './types';

export const orderModels = (a: ModelRecord, b: ModelRecord) =>
  Number(b.isDefault) - Number(a.isDefault) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

export function modelWithDefault(models: ModelRecord[], model: ModelRecord): ModelRecord {
  return { ...model, isDefault: model.isDefault || !models.some((item) => item.id !== model.id && item.isDefault) };
}

export function modelsAfterSave(models: ModelRecord[], model: ModelRecord): ModelRecord[] {
  return [...models.filter((item) => item.id !== model.id)
    .map((item) => model.isDefault ? { ...item, isDefault: false } : item), model].sort(orderModels);
}

export function modelsAfterDelete(models: ModelRecord[], id: string): ModelRecord[] {
  const remaining = models.filter((item) => item.id !== id).sort(orderModels);
  if (remaining.length && !remaining.some((item) => item.isDefault)) remaining[0] = { ...remaining[0], isDefault: true };
  return remaining;
}
