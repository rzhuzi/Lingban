import { ApiError, normalizeChatCompletionsUrl } from './client';
import { SseParser } from './sse';
import { safeRequestParameters } from '../cot/request-parameters';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string; prefix?: true; reasoning_content?: string };
export type StreamChatResult = { finishReason: string | null };

type StreamReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<unknown>;
  releaseLock(): void;
};
type StreamResponse = {
  ok: boolean;
  status: number;
  redirected?: boolean;
  headers: { get(name: string): string | null };
  body: { getReader(): StreamReader } | null;
};
export type StreamFetch = (url: string, init: {
  method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'error';
}) => Promise<StreamResponse>;

export type StreamChatOptions = {
  baseUrl: string;
  apiModel: string;
  apiKey?: string | null;
  messages: ChatMessage[];
  requestParameters?: Record<string, unknown>;
  streamOutput?: boolean;
  /** Custom gateways may ignore stream:true and return one complete JSON completion. */
  allowJsonFallback?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxTokens?: number;
  onContent: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  fetchImpl?: StreamFetch;
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function statusError(status: number): ApiError {
  if (status === 401 || status === 403) return new ApiError('auth', status);
  if (status === 429) return new ApiError('rate_limit', status);
  if (status >= 500) return new ApiError('server', status);
  return new ApiError('http', status);
}

/** Bounded OpenAI-compatible SSE. Raw payloads, exception causes and credentials never escape. */
export async function streamChat(options: StreamChatOptions): Promise<StreamChatResult> {
  const endpoint = normalizeChatCompletionsUrl(options.baseUrl);
  const model = options.apiModel.trim();
  const key = options.apiKey?.trim() ?? '';
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxTokens = options.maxTokens ?? 2048;
  const streamOutput = options.streamOutput ?? true;
  const allowJsonFallback = options.allowJsonFallback ?? false;
  if (!model || model.length > 200 || /[\u0000-\u001f\u007f]/.test(model) ||
      key.length > 8192 || /[\u0000-\u001f\u007f]/.test(key) ||
      !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
      !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 32_768 ||
      typeof streamOutput !== 'boolean' ||
      typeof allowJsonFallback !== 'boolean' ||
      !Array.isArray(options.messages) || !options.messages.length || options.messages.length > 1000 ||
      options.messages.some((message, index) => !record(message) || !['system', 'user', 'assistant'].includes(message.role) ||
        typeof message.content !== 'string' ||
        ('partial' in message && message.partial !== undefined) ||
        ((message.prefix !== undefined || message.reasoning_content !== undefined) &&
          (message.role !== 'assistant' || index !== options.messages.length - 1 || message.content !== '' ||
           message.prefix !== true || typeof message.reasoning_content !== 'string' || !message.reasoning_content.trim() ||
           message.reasoning_content.length > 32768))) || typeof options.onContent !== 'function' ||
      (options.onReasoning !== undefined && typeof options.onReasoning !== 'function')) {
    throw new ApiError('validation');
  }
  let requestParameters: Record<string, unknown>;
  try { requestParameters = safeRequestParameters(options.requestParameters); }
  catch { throw new ApiError('validation'); }
  if (options.messages.some((message) => message.prefix) &&
      (!record(requestParameters.thinking) || requestParameters.thinking.type !== 'enabled' || requestParameters.reasoning_effort === 'none')) {
    throw new ApiError('validation');
  }
  if (options.signal?.aborted) throw new ApiError('cancelled');

  const controller = new AbortController();
  let reader: StreamReader | null = null;
  let readerCancelled = false;
  let active = true;
  let interruption: ApiError | null = null;
  let rejectInterrupted: (error: ApiError) => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
  const cancelReader = () => {
    if (!reader || readerCancelled) return;
    readerCancelled = true;
    // Do not await potentially stuck native/injected cancellation while satisfying the deadline.
    try { void reader.cancel().catch(() => {}); } catch { /* transport teardown is best effort */ }
  };
  const interrupt = (code: 'cancelled' | 'timeout') => {
    if (!active || interruption) return;
    interruption = new ApiError(code);
    rejectInterrupted(interruption);
    cancelReader();
    controller.abort();
  };
  const cancel = () => interrupt('cancelled');
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => interrupt('timeout'), timeoutMs);

  const request = async () => {
    const fetchImpl: StreamFetch = options.fetchImpl ?? (await import('expo/fetch')).fetch;
    if (!active || interruption) throw interruption ?? new ApiError('cancelled');
    const headers: Record<string, string> = { 'Content-Type': 'application/json',
      Accept: !streamOutput ? 'application/json' : allowJsonFallback ? 'text/event-stream, application/json' : 'text/event-stream' };
    if (key) headers.Authorization = `Bearer ${key}`;
    const response = await fetchImpl(endpoint, {
      method: 'POST', headers, redirect: 'error', signal: controller.signal,
      body: JSON.stringify({ ...requestParameters, model, messages: options.messages.map(({ role, content, prefix, reasoning_content }) => ({ role, content,
        ...(prefix ? { prefix: true, reasoning_content } : {}) })),
        stream: streamOutput, max_tokens: maxTokens }),
    });
    if (response.body) reader = response.body.getReader();
    if (!active || interruption) { cancelReader(); throw interruption ?? new ApiError('cancelled'); }
    if (!response.ok) throw statusError(response.status);
    const contentType = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
    if (response.redirected || !reader || (contentType !== 'application/json' && (contentType !== 'text/event-stream' || !streamOutput))) {
      throw new ApiError('invalid_response');
    }

    if (contentType === 'application/json') {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let raw = '';
      while (active && !interruption) {
        const next = await reader.read();
        if (!active || interruption) throw interruption ?? new ApiError('cancelled');
        if (next.done) {
          try { raw += decoder.decode(); } catch { throw new ApiError('invalid_response'); }
          break;
        }
        if (!(next.value instanceof Uint8Array)) throw new ApiError('invalid_response');
        try { raw += decoder.decode(next.value, { stream: true }); } catch { throw new ApiError('invalid_response'); }
        if (raw.length > 4_194_304) throw new ApiError('invalid_response');
      }
      let payload: unknown;
      try { payload = JSON.parse(raw); } catch { throw new ApiError('invalid_response'); }
      if (!record(payload)) throw new ApiError('invalid_response');
      if ('error' in payload) throw new ApiError('server');
      if (streamOutput && !allowJsonFallback) throw new ApiError('invalid_response');
      if (!Array.isArray(payload.choices) || payload.choices.length !== 1 || !record(payload.choices[0]) ||
          (payload.choices[0].index !== undefined && payload.choices[0].index !== 0) ||
          !record(payload.choices[0].message)) throw new ApiError('invalid_response');
      const choice = payload.choices[0];
      if (choice.finish_reason != null && (typeof choice.finish_reason !== 'string' || !choice.finish_reason)) {
        throw new ApiError('invalid_response');
      }
      const finishReason = choice.finish_reason as string | null | undefined;
      // Do not turn an arbitrary JSON body or an unmarked truncated response into success.
      if (streamOutput && !finishReason) throw new ApiError('interrupted_response');
      const message = choice.message;
      if (!record(message) || (message.role !== undefined && message.role !== 'assistant') || (message.content !== null && typeof message.content !== 'string') ||
          (message.reasoning_content != null && typeof message.reasoning_content !== 'string')) throw new ApiError('invalid_response');
      if (active && !interruption) {
        if (message.reasoning_content) options.onReasoning?.(message.reasoning_content as string);
        if (message.content) options.onContent(message.content);
      }
      if (!message.content?.trim() && !(finishReason === 'length' && typeof message.reasoning_content === 'string' && message.reasoning_content.trim())) {
        throw new ApiError('empty_response');
      }
      return { finishReason: finishReason ?? null };
    }

    let done = false;
    let finished = false;
    let outputChars = 0;
    let hasContent = false;
    let hasReasoning = false;
    let finishReason: string | null = null;
    const emit = (value: unknown, callback?: (delta: string) => void) => {
      if (value === undefined || value === null || value === '') return;
      if (typeof value !== 'string' || finished) throw new ApiError('invalid_response');
      outputChars += value.length;
      if (outputChars > 4_194_304) throw new ApiError('invalid_response');
      if (active && !interruption) callback?.(value);
    };
    const parser = new SseParser((data, event) => {
      if (done || !active || interruption || !data.trim()) return;
      if (event === 'error') throw new ApiError('server');
      if (data.trim() === '[DONE]') { done = true; return; }
      let chunk: unknown;
      try { chunk = JSON.parse(data); } catch { throw new ApiError('invalid_response'); }
      if (!record(chunk)) throw new ApiError('invalid_response');
      if ('error' in chunk) throw new ApiError('server');
      if (!Array.isArray(chunk.choices)) throw new ApiError('invalid_response');
      // Some providers send usage in a separate final chunk with no choices.
      if (!chunk.choices.length && record(chunk.usage)) return;
      if (chunk.choices.length !== 1 || !record(chunk.choices[0])) throw new ApiError('invalid_response');
      const choice = chunk.choices[0];
      if (choice.index !== undefined && choice.index !== 0) throw new ApiError('invalid_response');
      if (!record(choice.delta)) throw new ApiError('invalid_response');
      if (typeof choice.delta.reasoning_content === 'string' && choice.delta.reasoning_content.trim()) hasReasoning = true;
      emit(choice.delta.reasoning_content, options.onReasoning);
      if (typeof choice.delta.content === 'string' && choice.delta.content.trim()) hasContent = true;
      emit(choice.delta.content, options.onContent);
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (typeof choice.finish_reason !== 'string' || !choice.finish_reason) throw new ApiError('invalid_response');
        if (finishReason !== null && finishReason !== choice.finish_reason) throw new ApiError('invalid_response');
        finishReason = choice.finish_reason;
        finished = true;
      }
    });
    const decoder = new TextDecoder('utf-8', { fatal: true });
    while (active && !interruption && !done) {
      const next = await reader.read();
      if (!active || interruption) throw interruption ?? new ApiError('cancelled');
      if (next.done) {
        try { parser.push(decoder.decode()); } catch (error) {
          if (error instanceof ApiError) throw error;
          throw new ApiError('invalid_response');
        }
        if (!done && !finished) throw new ApiError('interrupted_response');
        break;
      }
      if (!(next.value instanceof Uint8Array)) throw new ApiError('invalid_response');
      try { parser.push(decoder.decode(next.value, { stream: true })); } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError('invalid_response');
      }
    }
    if (!outputChars) throw new ApiError('invalid_response');
    if (!hasContent && !(finishReason === 'length' && hasReasoning)) throw new ApiError('empty_response');
    return { finishReason };
  };

  try {
    return await Promise.race([request(), interrupted]);
  } catch (error) {
    if (interruption) throw interruption;
    if (error instanceof ApiError) throw error;
    throw new ApiError('network');
  } finally {
    active = false;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    cancelReader();
    controller.abort();
    try { (reader as StreamReader | null)?.releaseLock(); } catch { /* a pending read may still own the lock */ }
  }
}
