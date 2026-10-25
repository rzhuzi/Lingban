import type { CompanionData, CompanionProfile, LegacyThinkingMode, MemoryItem, ModelThinkingConfig, PromptVariable, ThinkingMode } from '@/features/companion/types';
import type { CotAudit } from '../cot/types';
import { assertRoleConfiguration } from '../../features/companion/role-config';

export type ThemePreference = 'system' | 'light' | 'dark';
export type AppSettings = {
  theme: ThemePreference;
  userName: string;
  contextWindow: number;
  streamOutput: boolean;
};

export type ModelRecord = {
  id: string; name: string; provider: 'deepseek' | 'moonshot' | 'dashscope' | 'zhipu' | 'custom';
  baseUrl: string; apiModel: string; apiKeyAlias: string | null; isDefault: boolean;
  cotMode: ThinkingMode; cotPresetId: string | null; createdAt: string; updatedAt: string;
  thinkingConfig?: ModelThinkingConfig;
};
export type SessionRecord = {
  id: string; title: string; modelId: string | null; personaId: string | null;
  pinned: boolean; createdAt: string; updatedAt: string;
};
export type PersonaRecord = {
  id: string; profile: CompanionProfile; memories: MemoryItem[]; interests: string[]; isActive: boolean;
  configuration?: RoleConfiguration;
};
export type RoleModelConfiguration = { mode: ThinkingMode; thinking: ModelThinkingConfig; blockedReason?: string };
export type RoleConfiguration = {
  version: 1; confirmed: boolean; currentModelId: string | null; models: Record<string, RoleModelConfiguration>;
  variables: PromptVariable[]; chatSettings: Pick<AppSettings, 'contextWindow' | 'streamOutput'>;
};
export type MessageRecord = {
  id: string; sessionId: string; role: 'system' | 'user' | 'assistant'; content: string; reasoning: string;
  status: 'pending' | 'streaming' | 'done' | 'aborted' | 'error'; error: string | null;
  cotMode: LegacyThinkingMode; thinkingMode?: ThinkingMode | null;
  cotPresetId: string | null; modelId: string | null; createdAt: string;
  cotAudit?: CotAudit | null;
};
export type AppSnapshot = {
  companion: CompanionData; settings: AppSettings; personas: PersonaRecord[];
  models: ModelRecord[]; sessions: SessionRecord[]; messages: MessageRecord[];
  notice: string | null;
  migrationNotice?: { id: 'thinking-v2'; message: string } | null;
};

export interface AppRepository {
  dismissMigrationNotice?: (id: string) => Promise<void>;
  renameThinkingVariable?: (oldName: string, newName: string, variables: PromptVariable[]) => Promise<AppSnapshot>;
  initialize(): Promise<AppSnapshot>;
  saveCompanion(data: CompanionData, personaId?: string): Promise<void>;
  savePersona(persona: PersonaRecord): Promise<AppSnapshot>;
  saveRole(persona: PersonaRecord, baseline?: PersonaRecord | null, model?: ModelRecord): Promise<AppSnapshot>;
  setActivePersona(id: string): Promise<AppSnapshot>;
  deletePersona(id: string): Promise<AppSnapshot>;
  resetData(revision: string): Promise<AppSnapshot>;
  hasDataReset(revision: string): Promise<boolean>;
  saveSettings(settings: AppSettings): Promise<void>;
  saveModel(model: ModelRecord): Promise<void>;
  deleteModel(id: string): Promise<void>;
  saveSession(session: SessionRecord): Promise<void>;
  deleteSession(id: string): Promise<void>;
  saveMessage(message: MessageRecord): Promise<void>;
  getMessages(sessionId: string): Promise<MessageRecord[]>;
  saveChatTurn(session: SessionRecord, messages: MessageRecord[]): Promise<SessionRecord>;
  finishChatTurn(sessionId: string, message: MessageRecord, updatedAt: string): Promise<SessionRecord>;
  searchSessions(query: string): Promise<SessionRecord[]>;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system', userName: '你', contextWindow: 20, streamOutput: true,
};

export function assertAppSettings(value: AppSettings): void {
  if (!value || !['system', 'light', 'dark'].includes(value.theme) || typeof value.userName !== 'string'
    || !value.userName.trim() || value.userName.length > 100 || !Number.isInteger(value.contextWindow)
    || value.contextWindow < 1 || value.contextWindow > 100 || typeof value.streamOutput !== 'boolean') {
    throw new Error('设置格式无效：昵称需为 1–100 字，上下文需为 1–100 的整数。已有内容尚未覆盖。');
  }
}

export function assertPersonaRecord(value: PersonaRecord): void {
  const profile = value?.profile;
  if (!value || typeof value.id !== 'string' || !value.id.trim() || typeof value.isActive !== 'boolean'
    || !profile || typeof profile.name !== 'string' || !profile.name.trim() || typeof profile.description !== 'string'
    || ![profile.coverUri, profile.avatarUri].every((uri) => uri === null || typeof uri === 'string')
    || !Array.isArray(profile.traits) || !profile.traits.every((item) => typeof item === 'string')
    || !Array.isArray(value.interests) || !value.interests.every((item) => typeof item === 'string')
    || !Array.isArray(value.memories) || !value.memories.every((memory) => memory && typeof memory.id === 'string'
      && !!memory.id.trim() && typeof memory.text === 'string' && typeof memory.createdAt === 'string'
      && typeof memory.updatedAt === 'string' && ['heart', 'sparkles', 'cafe', 'moon', 'briefcase', 'bookmark'].includes(memory.icon))
    || new Set(value.memories.map((memory) => memory.id)).size !== value.memories.length) {
    throw new Error('人设或记忆格式异常，已有内容尚未覆盖。');
  }
  if (value.configuration !== undefined) assertRoleConfiguration(value.configuration);
}

export function assertResetRevision(revision: string): void {
  if (typeof revision !== 'string' || !revision.trim() || revision.length > 128) throw new Error('清空操作标识无效。');
}
