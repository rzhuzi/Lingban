import { useMemo, type PropsWithChildren } from 'react';

import { useCotStore, usePersonaStore } from '@/stores/app-stores';

import type { CompanionContextValue, CompanionData } from './types';

/** Compatibility wrapper; the five Zustand stores own all application state. */
export function CompanionProvider({ children }: PropsWithChildren) {
  return children;
}

export function useCompanion(): CompanionContextValue {
  const persona = usePersonaStore();
  const cot = useCotStore();
  const data = useMemo<CompanionData>(() => ({
    schemaVersion: 2, profile: persona.profile, memories: persona.memories,
    interests: persona.interests, thinking: cot.thinking,
  }), [persona.profile, persona.memories, persona.interests, cot.thinking]);

  return useMemo(() => ({
    data, ready: persona.ready && cot.ready, saveError: persona.saveError ?? cot.saveError,
    updateProfile: persona.updateProfile, addMemory: persona.addMemory, updateMemory: persona.updateMemory,
    deleteMemory: persona.deleteMemory, setInterests: persona.setInterests,
    updateThinking: cot.updateThinking, retrySave: persona.retrySave,
  }), [data, persona, cot]);
}
