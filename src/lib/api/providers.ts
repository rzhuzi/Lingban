import type { ModelRecord } from '@/lib/db/types';

export type ProviderId = ModelRecord['provider'];

export type ProviderDefinition = {
  id: ProviderId;
  label: string;
  baseUrl: string;
  defaultModel: string;
};

// Editable connection defaults only. Official prefix capability is checked per endpoint/model.
export const PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-flash',
  },
  {
    id: 'moonshot', label: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
  },
  {
    id: 'dashscope', label: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-turbo',
  },
  {
    id: 'zhipu', label: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash-250414',
  },
  {
    id: 'custom', label: '自定义', baseUrl: '', defaultModel: '',
  },
];

export function getProvider(id: string): ProviderDefinition {
  return PROVIDERS.find((provider) => provider.id === id) ?? PROVIDERS[PROVIDERS.length - 1];
}
