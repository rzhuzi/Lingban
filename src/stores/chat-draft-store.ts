import { create } from 'zustand';

type ChatDraft = { text: string };
type ChatDraftState = {
  drafts: Record<string, ChatDraft>;
  updateDraft: (key: string, text: string) => void;
  acceptDraft: (key: string, sent: ChatDraft, sessionId: string) => void;
  discardDraft: (key: string) => void;
  clearDrafts: () => void;
};

export const EMPTY_CHAT_DRAFT: ChatDraft = Object.freeze({ text: '' });
export const chatDraftKey = (sessionId: string | null, personaId: string) =>
  sessionId === null ? `new:${personaId}` : `session:${sessionId}`;

/** Drafts stay in memory across screen remounts and never share text between roles or sessions. */
export const createChatDraftStore = () => create<ChatDraftState>()((set) => ({
  drafts: {},
  // A fresh object records an edit even when the user changes the text back to its original value.
  updateDraft: (key, text) => set((state) => ({ drafts: { ...state.drafts, [key]: { text } } })),
  acceptDraft: (key, sent, sessionId) => set((state) => {
    const current = state.drafts[key];
    if (!current) return state;
    const target = chatDraftKey(sessionId, '');
    if (target === key && current !== sent) return state;
    const drafts = { ...state.drafts };
    delete drafts[key];
    // New input typed while the first turn was saving belongs to the newly created session.
    // If its remounted composer has already been edited, that newer destination draft wins.
    if (target !== key && current !== sent && !drafts[target]) drafts[target] = current;
    return { drafts };
  }),
  discardDraft: (key) => set((state) => {
    if (!state.drafts[key]) return state;
    const drafts = { ...state.drafts };
    delete drafts[key];
    return { drafts };
  }),
  clearDrafts: () => set({ drafts: {} }),
}));

export const useChatDraftStore = createChatDraftStore();
