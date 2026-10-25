import { useChatStore, usePersonaStore } from '@/stores/app-stores';

/** A viewed conversation owns its role, even when another role is active for new chats. */
export function useChatRole() {
  const sessionId = useChatStore((state) => state.activeSessionId);
  const session = useChatStore((state) => state.sessions.find((item) => item.id === state.activeSessionId));
  const activePersonaId = usePersonaStore((state) => state.activePersonaId);
  const personas = usePersonaStore((state) => state.personas);
  const roleId = sessionId ? session?.personaId ?? null : activePersonaId;
  return { role: personas.find((persona) => persona.id === roleId), roleId, sessionId };
}
