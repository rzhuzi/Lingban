import { normalizeModelsUrl, type RemoteModel } from './models';

/** Small official catalog references, not an account's enabled or available models. */
export function getModelSuggestions(baseUrl: string): RemoteModel[] {
  let url: URL;
  try { url = new URL(normalizeModelsUrl(baseUrl)); } catch { return []; }
  let models: RemoteModel[] = [];
  if (url.origin === 'https://api.deepseek.com' && ['/models', '/v1/models'].includes(url.pathname)) {
    models = [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }];
  } else if (url.origin === 'https://api.moonshot.cn' && url.pathname === '/v1/models') {
    models = [{ id: 'kimi-k3' }, { id: 'kimi-k2.6' }];
  } else if (['https://dashscope.aliyuncs.com', 'https://dashscope-intl.aliyuncs.com',
    'https://cn-hongkong.dashscope.aliyuncs.com'].includes(url.origin) && url.pathname === '/compatible-mode/v1/models') {
    models = [{ id: 'qwen3.8-max' }, { id: 'qwen3.7-plus' }, { id: 'qwen3.8-flash' }];
  } else if (url.origin === 'https://open.bigmodel.cn' && url.pathname === '/api/paas/v4/models') {
    models = [{ id: 'glm-5.3' }, { id: 'glm-4.7' }, { id: 'glm-4.5-flash' }];
  }
  return models;
}
