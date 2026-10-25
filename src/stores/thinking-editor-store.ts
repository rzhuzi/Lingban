import { create } from 'zustand';

import { createId } from '@/features/companion/defaults';
import { assertModelThinkingConfig, copyModelThinkingConfig, createModelThinkingConfig } from '@/features/companion/thinking-config';
import type { ModelRecord } from '@/lib/db/types';

type EditorSession = { model: ModelRecord };
type EditorState = {
  locked: boolean;
  sessions: Record<string, EditorSession>;
  begin: (model: ModelRecord) => string;
  update: (id: string, patch: Partial<Pick<ModelRecord, 'cotMode' | 'thinkingConfig'>>) => void;
  remove: (id: string) => void;
};
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

/** Uncommitted model forms never pass a secret through route parameters or a global draft. */
export const useThinkingEditorStore = create<EditorState>()((set, get) => ({
  sessions: {}, locked: false,
  begin: (input) => {
    if (get().locked) throw new Error('正在更新提示词变量，请稍后重试。');
    const id = createId();
    const model: ModelRecord = {
      id: input.id, name: input.name, provider: input.provider, baseUrl: input.baseUrl, apiModel: input.apiModel,
      apiKeyAlias: input.apiKeyAlias, isDefault: input.isDefault, cotMode: input.cotMode, cotPresetId: input.cotPresetId,
      createdAt: input.createdAt, updatedAt: input.updatedAt,
      thinkingConfig: copyModelThinkingConfig(input.thinkingConfig ?? createModelThinkingConfig()),
    };
    set((state) => ({ sessions: { ...state.sessions, [id]: { model } } }));
    return id;
  },
  update: (id, patch) => set((state) => {
    if (state.locked) throw new Error('正在更新提示词变量，请稍后重试。');
    const session = state.sessions[id];
    if (!session) return state;
    if (patch.cotMode !== undefined && !['off', 'official', 'instruction', 'persona'].includes(patch.cotMode)) throw new Error('思维配置模式无效。');
    if (patch.thinkingConfig !== undefined) assertModelThinkingConfig(patch.thinkingConfig);
    const safe = { ...(patch.cotMode !== undefined ? { cotMode: patch.cotMode } : {}),
      ...(patch.thinkingConfig !== undefined ? { thinkingConfig: copyModelThinkingConfig(patch.thinkingConfig) } : {}) };
    return { sessions: { ...state.sessions, [id]: { model: { ...session.model, ...clone(safe) } } } };
  }),
  remove: (id) => set((state) => {
    const sessions = { ...state.sessions };
    delete sessions[id];
    return { sessions };
  }),
}));
