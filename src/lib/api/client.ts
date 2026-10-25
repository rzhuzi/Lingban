export type ApiErrorCode =
  | 'validation' | 'auth' | 'rate_limit' | 'server' | 'network'
  | 'timeout' | 'cancelled' | 'invalid_response' | 'interrupted_response' | 'empty_response' | 'http';

const ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  validation: '请检查接口地址、模型 ID 和密钥格式。',
  auth: '鉴权失败，请检查密钥、权限和服务地域。',
  rate_limit: '请求过于频繁，请稍后重试。',
  server: '模型服务暂时不可用，请稍后重试。',
  network: '无法连接模型服务，请检查网络和接口地址。',
  timeout: '连接超时，请稍后重试。',
  cancelled: '已取消请求。',
  invalid_response: '接口返回格式不符合聊天协议。',
  interrupted_response: '回复意外中断，可以重试。',
  empty_response: '模型没有返回正文，请重试或更换模型。',
  http: '请求未被接受，请检查接口地址和模型 ID。',
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status?: number;

  constructor(code: ApiErrorCode, status?: number) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** Accept a base URL or a full completion endpoint without guessing an API version. */
export function normalizeChatCompletionsUrl(baseUrl: string): string {
  const value = baseUrl.trim();
  if (!value || /[\s\\?#]/.test(value)) throw new ApiError('validation');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError('validation');
  }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new ApiError('validation');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
  return url.toString();
}

export type ConnectionOptions = {
  baseUrl: string;
  apiModel: string;
  apiKey?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

function statusError(status: number): ApiError {
  if (status === 401 || status === 403) return new ApiError('auth', status);
  if (status === 429) return new ApiError('rate_limit', status);
  if (status >= 500) return new ApiError('server', status);
  return new ApiError('http', status);
}

function isChatResponse(value: unknown): boolean {
  if (!value || typeof value !== 'object' || 'error' in value || !('choices' in value)) return false;
  if (!Array.isArray(value.choices) || value.choices.length !== 1) return false;
  const choice = value.choices[0];
  if (!choice || typeof choice !== 'object' || (choice.index !== undefined && choice.index !== 0) ||
      (choice.finish_reason != null && (typeof choice.finish_reason !== 'string' || !choice.finish_reason))) return false;
  const message = choice.message;
  if (!message || typeof message !== 'object' || message.role !== 'assistant' ||
      (message.content !== null && typeof message.content !== 'string') ||
      (message.reasoning_content != null && typeof message.reasoning_content !== 'string')) return false;
  // A tiny probe may exhaust its budget in reasoning. This proves protocol connectivity,
  // not that a real chat request has produced a usable answer or completed its thinking.
  return !!message.content?.trim() || !!message.reasoning_content?.trim();
}

/** One bounded, non-streaming request. Never return/log server text, request bodies, or credentials. */
export async function testConnection(options: ConnectionOptions): Promise<{ latencyMs: number }> {
  const endpoint = normalizeChatCompletionsUrl(options.baseUrl);
  const model = options.apiModel.trim();
  const key = options.apiKey?.trim() ?? '';
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!model || model.length > 200 || /[\u0000-\u001f\u007f]/.test(model) ||
      key.length > 8192 || /[\u0000-\u001f\u007f]/.test(key) ||
      !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new ApiError('validation');
  }
  if (options.signal?.aborted) throw new ApiError('cancelled');

  const controller = new AbortController();
  const startedAt = Date.now();
  let rejectInterrupted: (error: ApiError) => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
  const cancel = () => {
    rejectInterrupted(new ApiError('cancelled'));
    controller.abort();
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => {
    rejectInterrupted(new ApiError('timeout'));
    controller.abort();
  }, timeoutMs);

  try {
    const request = async () => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (key) headers.Authorization = `Bearer ${key}`;
      // Current DeepSeek models think by default. Disable it only for this tiny official-endpoint probe.
      // This does not claim or configure prefill/CoT support for a provider or custom model.
      const isDeepSeekProbe = new URL(endpoint).origin === 'https://api.deepseek.com' &&
        ['deepseek-flash', 'deepseek-v4-pro'].includes(model);
      const response = await (options.fetchImpl ?? fetch)(endpoint, {
        method: 'POST', headers, signal: controller.signal, redirect: 'error',
        body: JSON.stringify({
          model, messages: [{ role: 'user', content: 'Hi' }], stream: false, max_tokens: 8,
          ...(isDeepSeekProbe ? { thinking: { type: 'disabled' } } : {}),
        }),
      });
      if (!response.ok) throw statusError(response.status);
      let result: unknown;
      try {
        result = await response.json();
      } catch {
        throw new ApiError('invalid_response');
      }
      if (!isChatResponse(result)) throw new ApiError('invalid_response');
      return { latencyMs: Math.max(0, Date.now() - startedAt) };
    };
    // Race also bounds injected/buggy transports that do not honor AbortSignal, including body reads.
    return await Promise.race([request(), interrupted]);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('network');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
