import { createId } from '@/features/companion/defaults';
import { getModelApiKey } from '@/features/models/model-service';
import { streamChat } from '@/lib/api/stream';
import { repository } from '@/lib/db/repository';
import { initializeStores, useChatStore, useModelStore, usePersonaStore, useSettingsStore, getCompanionForPersona, isAppMaintenanceActive } from '@/stores/app-stores';
import { chatDraftKey, useChatDraftStore } from '@/stores/chat-draft-store';

import { createChatEngine } from './engine-core';
import { useChatRuntimeStore } from './runtime';

const engine = createChatEngine({
  repository, initialize: initializeStores,
  getChat: useChatStore.getState, setChat: useChatStore.setState,
  getModels: () => useModelStore.getState().models, setRuntime: useChatRuntimeStore.setState,
  getCompanion: getCompanionForPersona, getSettings: () => useSettingsStore.getState().settings,
  isAppMaintenanceActive: () => isAppMaintenanceActive() || usePersonaStore.getState().busy,
  getApiKey: getModelApiKey, stream: streamChat,
  now: () => new Date().toISOString(), id: createId,
});

export const { sendChatMessage, retryChatMessage, stopGeneration, retryChatPersistence,
  startNewConversation, openChatSession, withChatMaintenance } = engine;

export async function deleteChatSession(id: string) {
  await engine.deleteChatSession(id);
  useChatDraftStore.getState().discardDraft(chatDraftKey(id, ''));
}
