export type RemoteModel = { id: string; name?: string; ownedBy?: string };

export type ModelsListErrorCode =
  | 'validation' | 'auth' | 'rate_limit' | 'server' | 'network'
  | 'timeout' | 'cancelled' | 'unsupported' | 'invalid_response' | 'http';

const ERROR_MESSAGES: Record<ModelsListErrorCode, string> = {
  validation: '请检查接口地址和密钥格式。',
  auth: '获取模型失败，请检查密钥、权限和服务地域。',
  rate_limit: '请求过于频繁，请稍后重新获取。',
  server: '模型服务暂时不可用，请稍后重新获取。',
  network: '无法获取模型，请检查网络和接口地址。',
  timeout: '获取模型超时，请稍后重试。',
  cancelled: '已取消获取模型。',
  unsupported: '此地址未提供兼容的模型列表，请查阅厂商模型目录并手动填写。',
  invalid_response: '模型列表格式不符合兼容协议，请查阅厂商模型目录并手动填写。',
  http: '获取模型的请求未被接受，请检查接口地址。',
};

export class ModelsListError extends Error {
  readonly code: ModelsListErrorCode;
  readonly status?: number;

  constructor(code: ModelsListErrorCode, status?: number) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ModelsListError';
    this.code = code;
    this.status = status;
  }
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 5_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
// The current native list documentation explicitly names these regional origins.
// Beijing's documented list URL includes a workspace host; do not guess that host.
const DASHSCOPE_LIST_ORIGINS = new Set([
  'https://dashscope-intl.aliyuncs.com',
  'https://cn-hongkong.dashscope.aliyuncs.com',
]);

/** Derive only the final endpoint; never guess a version, region, or another host. */
export function normalizeModelsUrl(baseUrl: string): string {
  if (typeof baseUrl !== 'string') throw new ModelsListError('validation');
  const value = baseUrl.trim();
  if (!value || /[\s\\?#]/.test(value)) throw new ModelsListError('validation');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ModelsListError('validation');
  }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new ModelsListError('validation');
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/chat/completions')) path = path.slice(0, -'/chat/completions'.length);
  url.pathname = path.endsWith('/models') ? path : `${path}/models`;
  return url.toString();
}

export type ListModelsOptions = {
  baseUrl: string;
  apiKey?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

function statusError(status: number): ModelsListError {
  if (status === 401 || status === 403) return new ModelsListError('auth', status);
  if (status === 429) return new ModelsListError('rate_limit', status);
  if (status === 404 || status === 405 || status === 501) return new ModelsListError('unsupported', status);
  if (status >= 500) return new ModelsListError('server', status);
  return new ModelsListError('http', status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ModelsListError('invalid_response');
  const text = value.trim();
  if (text.length > 200 || CONTROL_CHARACTERS.test(text)) throw new ModelsListError('invalid_response');
  return text || undefined;
}

function parseModels(value: unknown): RemoteModel[] {
  if (!isRecord(value) || 'error' in value || !Array.isArray(value.data) || value.data.length > MAX_MODELS) {
    throw new ModelsListError('invalid_response');
  }
  // Reject incomplete pages rather than presenting a partial catalog as the whole list.
  if (value.has_more === true || (typeof value.next === 'string' && value.next.trim()) ||
      (typeof value.next_page === 'string' && value.next_page.trim())) {
    throw new ModelsListError('unsupported');
  }
  const models = new Map<string, RemoteModel>();
  for (const row of value.data) {
    if (!isRecord(row) || typeof row.id !== 'string') throw new ModelsListError('invalid_response');
    const id = row.id.trim();
    if (!id || id.length > 200 || CONTROL_CHARACTERS.test(id)) throw new ModelsListError('invalid_response');
    const name = optionalText(row.name);
    const ownedBy = optionalText(row.owned_by);
    if (!models.has(id)) models.set(id, { id, ...(name ? { name } : {}), ...(ownedBy ? { ownedBy } : {}) });
  }
  return [...models.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** A single bounded GET. Only sanitized errors and whitelisted model fields leave this module. */
export async function listModels(options: ListModelsOptions): Promise<RemoteModel[]> {
  const endpoint = normalizeModelsUrl(options.baseUrl);
  const endpointUrl = new URL(endpoint);
  const dashscope = DASHSCOPE_LIST_ORIGINS.has(endpointUrl.origin) &&
    endpointUrl.pathname === '/compatible-mode/v1/models';
  if (options.apiKey !== undefined && options.apiKey !== null && typeof options.apiKey !== 'string') {
    throw new ModelsListError('validation');
  }
  const key = options.apiKey?.trim() ?? '';
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (key.length > 8192 || CONTROL_CHARACTERS.test(key) ||
      !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new ModelsListError('validation');
  }
  if (options.signal?.aborted) throw new ModelsListError('cancelled');

  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let interruption: ModelsListError | undefined;
  let rejectInterrupted: (error: ModelsListError) => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
  const stopReader = () => {
    // A buggy transport's cancel() must not delay the caller's timeout/cancellation.
    try { void reader?.cancel().catch(() => {}); } catch { /* Best effort cleanup. */ }
  };
  const interrupt = (code: 'cancelled' | 'timeout') => {
    if (interruption) return;
    interruption = new ModelsListError(code);
    rejectInterrupted(interruption);
    controller.abort();
    stopReader();
  };
  const cancel = () => interrupt('cancelled');
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => interrupt('timeout'), timeoutMs);
  const checkDeadline = () => {
    if (!interruption && Date.now() >= deadline) interrupt('timeout');
    if (interruption) throw interruption;
  };

  try {
    const getJson = async (url: string): Promise<unknown> => {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (key) headers.Authorization = `Bearer ${key}`;
      const response = await (options.fetchImpl ?? fetch)(url, {
        method: 'GET', headers, signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
      });
      if (interruption || response.redirected || (response.url && response.url !== url) || !response.ok) {
        try { void response.body?.cancel().catch(() => {}); } catch { /* Best effort cleanup. */ }
        checkDeadline();
        if (response.redirected || (response.url && response.url !== url)) throw new ModelsListError('network');
        throw statusError(response.status);
      }
      checkDeadline();
      const declaredLength = Number(response.headers.get('content-length'));
      if (declaredLength > MAX_BODY_BYTES || !response.body) {
        try { void response.body?.cancel().catch(() => {}); } catch { /* Best effort cleanup. */ }
        throw new ModelsListError('invalid_response');
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let size = 0;
      let body = '';
      try {
        for (;;) {
          const chunk = await reader.read();
          checkDeadline();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_BODY_BYTES) throw new ModelsListError('invalid_response');
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
      } catch (error) {
        stopReader();
        if (interruption) throw interruption;
        if (error instanceof ModelsListError) throw error;
        throw new ModelsListError('invalid_response');
      } finally {
        try { reader.releaseLock(); } catch { /* A pending native read may still own the lock. */ }
        reader = undefined;
      }
      let value: unknown;
      try { value = JSON.parse(body); } catch { throw new ModelsListError('invalid_response'); }
      checkDeadline();
      return value;
    };
    const request = async () => {
      if (!dashscope) {
        const models = parseModels(await getJson(endpoint));
        checkDeadline();
        return models;
      }
      // The API lists text-generation models in pages. Never substitute another region.
      const rows: unknown[] = [];
      let received = 0;
      let expectedTotal: number | undefined;
      for (let page = 1; page <= MAX_MODELS / 20; page += 1) {
        const url = new URL('/api/v1/models', endpointUrl.origin);
        url.searchParams.set('capabilities', 'TG');
        url.searchParams.set('page_no', String(page));
        url.searchParams.set('page_size', '20');
        const value = await getJson(url.toString());
        if (!isRecord(value) || value.success !== true || !isRecord(value.output)) {
          throw new ModelsListError('invalid_response');
        }
        const output = value.output;
        if (typeof output.total !== 'number' || !Number.isInteger(output.total) ||
            output.total < 0 || output.total > MAX_MODELS || !Array.isArray(output.models) ||
            output.models.length > 20 || (expectedTotal !== undefined && output.total !== expectedTotal) ||
            (output.page_no !== undefined && output.page_no !== page)) {
          throw new ModelsListError('invalid_response');
        }
        expectedTotal = output.total;
        const pageRows = output.models.map((item) => {
          if (!isRecord(item)) throw new ModelsListError('invalid_response');
          return { id: item.model, name: item.name, owned_by: item.provider };
        });
        // Validate this page before accumulating metadata from subsequent responses.
        const pageModels = parseModels({ data: pageRows });
        rows.push(...pageModels.map((model) => ({ id: model.id, name: model.name, owned_by: model.ownedBy })));
        received += output.models.length;
        if (received > expectedTotal) throw new ModelsListError('invalid_response');
        if (received === expectedTotal) {
          const models = parseModels({ data: rows });
          checkDeadline();
          return models;
        }
        if (!output.models.length) throw new ModelsListError('invalid_response');
      }
      throw new ModelsListError('invalid_response');
    };
    // Bounds headers and body even when an injected/native transport ignores AbortSignal.
    return await Promise.race([request(), interrupted]);
  } catch (error) {
    if (interruption) throw interruption;
    if (error instanceof ModelsListError) throw error;
    throw new ModelsListError('network');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
