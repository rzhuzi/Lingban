import { create } from 'zustand';

export type ChatRuntimeState = {
  isSending: boolean;
  streamingSessionId: string | null;
  error: string | null;
  persistenceError: string | null;
  hasUnsaved: boolean;
};

export const useChatRuntimeStore = create<ChatRuntimeState>()(() => ({
  isSending: false, streamingSessionId: null, error: null, persistenceError: null, hasUnsaved: false,
}));
