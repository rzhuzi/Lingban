import type { CompanionData, PromptTemplate } from './types';
import { createThinkingDraft } from './thinking-config';

export const DEFAULT_PROMPT =
  '你是{persona}，正在与{user_name}对话。\n\n请先理解对方的需求，以自然、真诚的语气回应；需要时给出清晰、具体的建议。\n当前日期：{date}。';

let nextId = 0;

export function createId() {
  nextId += 1;
  return `${Date.now().toString(36)}-${nextId.toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createDefaultTemplates(): PromptTemplate[] {
  return [
    {
      id: 'template-warm',
      kind: 'persona',
      name: '温柔陪伴',
      description: '自然倾听，温和回应',
      prompt: DEFAULT_PROMPT,
      icon: 'heart',
    },
    {
      id: 'template-rational',
      kind: 'persona',
      name: '理性分析',
      description: '梳理问题，给出具体建议',
      prompt:
        '你是{persona}，正在与{user_name}对话。\n\n请先梳理问题的已知信息与不确定之处，再给出简洁、有依据、可执行的建议。\n当前日期：{date}。',
      icon: 'analytics',
    },
    {
      id: 'template-encourage',
      kind: 'persona',
      name: '温柔鼓励',
      description: '关注感受，支持下一步行动',
      prompt:
        '你是{persona}，正在与{user_name}对话。\n\n请尊重对方的感受，用真诚、具体的鼓励支持他们，并一起寻找容易开始的一小步。\n当前日期：{date}。',
      icon: 'sunny',
    },
  ];
}

export function createDefaultData(): CompanionData {
  return {
    schemaVersion: 2,
    profile: { name: '小零', description: '', coverUri: null, avatarUri: null, traits: [] },
    memories: [],
    interests: [],
    thinking: {
      mode: 'off',
      prompt: DEFAULT_PROMPT,
      nativeParameters: '{}',
      selectedTemplateId: 'template-warm',
      templates: createDefaultTemplates(),
      variables: [{ id: 'variable-user-name', name: 'user_name', value: '你' }],
      drafts: { official: createThinkingDraft(), instruction: createThinkingDraft(), persona: createThinkingDraft(DEFAULT_PROMPT) },
    },
  };
}
