import { createDefaultData, createId } from './defaults';
import type { CompanionData, LegacyThinkingMode, MemoryIcon, TemplateIcon, ThinkingContentMode, ThinkingDraft, ThinkingMode } from './types';
import { createThinkingDraft } from './thinking-config';

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Recover readable fields without truncating user-authored strings. The caller backs up repaired input. */
export function normalizeCompanion(value: unknown): { data: CompanionData; recovered: boolean; migrated: boolean } {
  const defaults = createDefaultData();
  let recovered = false;
  const repair = <T,>(fallback: T): T => { recovered = true; return fallback; };
  const object = (input: unknown): RecordValue => isRecord(input) ? input : repair({});
  const string = (input: unknown, fallback = '') => typeof input === 'string' ? input : repair(fallback);
  const nullableString = (input: unknown) => input === null || typeof input === 'string' ? input : repair(null);
  const array = (input: unknown): unknown[] => Array.isArray(input) ? input : repair([]);
  const strings = (input: unknown): string[] => array(input).flatMap((entry) =>
    typeof entry === 'string' ? [entry] : repair([]));
  const uniqueId = (input: unknown, used: Set<string>) => {
    const id = typeof input === 'string' && input && !used.has(input) ? input : repair(createId());
    used.add(id);
    return id;
  };
  const enumValue = <T extends string>(input: unknown, choices: readonly T[], fallback: T): T =>
    typeof input === 'string' && choices.includes(input as T) ? input as T : repair(fallback);

  const source = object(value);
  if (typeof source.schemaVersion === 'number' && source.schemaVersion > 2) {
    throw new Error('本地配置来自较新版本，暂未覆盖。请更新应用后重试。');
  }
  const migrated = source.schemaVersion === 1;
  if (source.schemaVersion !== 1 && source.schemaVersion !== 2) repair(null);
  const profile = object(source.profile);
  const thinking = object(source.thinking);
  const memoryIds = new Set<string>();
  const templateIds = new Set<string>();
  const variableIds = new Set<string>();
  const variableNames = new Set<string>();

  const memories = array(source.memories).flatMap((input) => {
    if (!isRecord(input) && typeof input !== 'string') return repair([]);
    const entry: RecordValue = typeof input === 'string' ? repair({ text: input }) : input;
    const createdAt = string(entry.createdAt, new Date().toISOString());
    return [{
      id: uniqueId(entry.id, memoryIds), text: string(entry.text),
      icon: enumValue<MemoryIcon>(entry.icon, ['heart', 'sparkles', 'cafe', 'moon', 'briefcase', 'bookmark'], 'heart'),
      createdAt, updatedAt: string(entry.updatedAt, createdAt),
    }];
  });

  const templates = thinking.templates === undefined ? repair(defaults.thinking.templates) : array(thinking.templates).flatMap((input) => {
    if (!isRecord(input)) return repair([]);
    return [{
      id: uniqueId(input.id, templateIds), name: string(input.name, '未命名模板'),
      description: string(input.description), prompt: string(input.prompt),
      icon: enumValue<TemplateIcon>(input.icon, ['heart', 'analytics', 'sunny', 'sparkles'], 'sparkles'),
      kind: input.kind === undefined ? 'persona' as const
        : enumValue<ThinkingContentMode | 'unclassified'>(input.kind, ['official', 'instruction', 'persona', 'unclassified'], 'unclassified'),
      ...(input.enabled === undefined ? {} : {
        enabled: typeof input.enabled === 'boolean' ? input.enabled : repair(true),
      }),
    }];
  });

  const variables = thinking.variables === undefined ? repair(defaults.thinking.variables) : array(thinking.variables).flatMap((input) => {
    if (!isRecord(input) || typeof input.name !== 'string' || !input.name || variableNames.has(input.name)) return repair([]);
    variableNames.add(input.name);
    return [{ id: uniqueId(input.id, variableIds), name: input.name, value: string(input.value) }];
  });
  const selectedTemplateId = thinking.selectedTemplateId === null ? null
    : typeof thinking.selectedTemplateId === 'string' && templates.some((entry) => entry.id === thinking.selectedTemplateId)
      ? thinking.selectedTemplateId : repair(null);

  const oldMode = migrated ? enumValue<LegacyThinkingMode>(thinking.mode, ['off', 'native', 'prefill', 'persona'], 'off') : 'off';
  // Only v1 interprets old sending modes; v2 uses the new vocabulary directly.
  const mode = migrated ? (oldMode === 'persona' ? 'persona' : 'off')
    : enumValue<ThinkingMode>(thinking.mode, ['off', 'official', 'instruction', 'persona'], 'off');
  const prompt = string(thinking.prompt, defaults.thinking.prompt);
  const normalizeDraft = (input: unknown, fallback: ThinkingDraft): ThinkingDraft => {
    if (input === undefined) return { ...fallback };
    const item = object(input);
    return { text: string(item.text, fallback.text), templateId: nullableString(item.templateId),
      parametersJson: string(item.parametersJson, '{}'),
      placement: enumValue(item.placement, ['system-start', 'user-prefix'], 'system-start') };
  };
  const workspaces = isRecord(thinking.drafts) ? thinking.drafts : {};
  const data: CompanionData = {
    schemaVersion: 2,
    profile: {
      name: string(profile.name, defaults.profile.name), description: string(profile.description),
      coverUri: nullableString(profile.coverUri), avatarUri: nullableString(profile.avatarUri), traits: strings(profile.traits),
    },
    memories,
    interests: strings(source.interests),
    thinking: {
      mode,
      prompt,
      nativeParameters: string(thinking.nativeParameters, '{}'),
      selectedTemplateId, templates, variables,
      drafts: {
        official: normalizeDraft(workspaces.official, createThinkingDraft()),
        instruction: normalizeDraft(workspaces.instruction, createThinkingDraft()),
        persona: normalizeDraft(workspaces.persona, { ...createThinkingDraft(prompt), templateId: selectedTemplateId }),
      },
      ...(migrated ? { legacyMode: oldMode } : thinking.legacyMode !== undefined
        ? { legacyMode: enumValue<LegacyThinkingMode>(thinking.legacyMode, ['off', 'native', 'prefill', 'persona'], 'off') } : {}),
    },
  };
  return { data, recovered, migrated };
}
