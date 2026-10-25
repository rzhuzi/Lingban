export type MemoryIcon = 'heart' | 'sparkles' | 'cafe' | 'moon' | 'briefcase' | 'bookmark';
export type TemplateIcon = 'heart' | 'analytics' | 'sunny' | 'sparkles';
export type LegacyThinkingMode = 'off' | 'native' | 'prefill' | 'persona';
export type ThinkingMode = 'off' | 'official' | 'instruction' | 'persona';
export type ThinkingContentMode = Exclude<ThinkingMode, 'off'>;
export type InstructionPlacement = 'system-start' | 'user-prefix';
export type ThinkingDraft = {
  text: string;
  templateId: string | null;
  parametersJson: string;
  placement: InstructionPlacement;
};
export type ThinkingModeConfig = { draft: ThinkingDraft; applied: ThinkingDraft | null };
export type ModelThinkingConfig = { version: 1 } & Record<ThinkingContentMode, ThinkingModeConfig>;

export type CompanionProfile = {
  name: string;
  description: string;
  coverUri: string | null;
  avatarUri: string | null;
  traits: string[];
};

export type MemoryItem = {
  id: string;
  text: string;
  icon: MemoryIcon;
  createdAt: string;
  updatedAt: string;
};

export type PromptVariable = { id: string; name: string; value: string };
export type PromptTemplate = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  icon: TemplateIcon;
  enabled?: boolean;
  kind?: ThinkingContentMode | 'unclassified';
};

export type ThinkingConfig = {
  mode: ThinkingMode;
  prompt: string;
  nativeParameters: string;
  selectedTemplateId: string | null;
  templates: PromptTemplate[];
  variables: PromptVariable[];
  /** Unapplied workspace used only when there is no saved target model. */
  drafts?: Record<ThinkingContentMode, ThinkingDraft>;
  /** Retained text never activates an old sending mode. */
  legacyMode?: LegacyThinkingMode;
};

export type CompanionData = {
  schemaVersion: 2;
  profile: CompanionProfile;
  memories: MemoryItem[];
  interests: string[];
  thinking: ThinkingConfig;
};

export type CompanionContextValue = {
  data: CompanionData;
  ready: boolean;
  saveError: string | null;
  updateProfile: (patch: Partial<CompanionProfile>) => void;
  addMemory: (input: Pick<MemoryItem, 'text' | 'icon'>) => void;
  updateMemory: (id: string, patch: Partial<Pick<MemoryItem, 'text' | 'icon'>>) => void;
  deleteMemory: (id: string) => void;
  setInterests: (interests: string[]) => void;
  updateThinking: (patch: Partial<ThinkingConfig>) => void;
  retrySave: () => void;
};
