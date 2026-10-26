import { ApiError } from '../api/client';
import type { ChatMessage, StreamChatResult } from '../api/stream';
import type { CompanionData } from '../../features/companion/types';
import { resolveRoleRuntime } from '../../features/companion/role-config';
import { CotConfigurationError } from '../cot/errors';
import { buildRequestMessages, type BuiltChatRequest } from '../cot/inject';
import { captureCotAttempt, type CotAttemptSnapshot, type LegacyCotSnapshot } from '../cot/types';
import type { AppRepository, AppSettings, MessageRecord, ModelRecord, RoleConfiguration, SessionRecord } from '../db/types';
import type { ChatRuntimeState } from './runtime';

type ChatState = { sessions: SessionRecord[]; messages: MessageRecord[]; activeSessionId: string | null };
type StreamOptions = {
  baseUrl: string; apiModel: string; apiKey?: string | null; signal?: AbortSignal;
  messages: ChatMessage[]; requestParameters?: Record<string, unknown>; streamOutput?: boolean; allowJsonFallback?: boolean;
  onContent: (delta: string) => void; onReasoning: (delta: string) => void;
};
export type ChatEngineDependencies = {
  repository: Pick<AppRepository, 'saveChatTurn' | 'finishChatTurn' | 'getMessages' | 'deleteSession'>;
  initialize: () => Promise<void>;
  getChat: () => ChatState;
  setChat: (patch: Partial<ChatState>) => void;
  getModels: () => ModelRecord[];
  getCompanion: (personaId?: string | null) => { data: CompanionData; personaId: string; configuration: RoleConfiguration };
  getSettings: () => AppSettings;
  isAppMaintenanceActive?: () => boolean;
  setRuntime: (patch: Partial<ChatRuntimeState>) => void;
  getApiKey: (alias: string | null) => Promise<string | null>;
  stream: (options: StreamOptions) => Promise<StreamChatResult | void>;
  now: () => string;
  id: () => string;
};

const SAVE_ERROR = '消息尚未保存，内容仍保留在本次会话中。请重试保存。';
const CANCELLED = '生成已停止，可重试。';
const LENGTH_NOTICE = '回复已达长度上限，可继续提问让模型接着回答。';
const sorted = (sessions: SessionRecord[]) => [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

/** Only content history is carried forward; each request replaces the system prompt from its snapshot. */
export function buildChatContext(messages: MessageRecord[], contextWindow = 20) {
  const history = messages.filter((message) => message.role !== 'system' && message.content.trim()
    && (message.role === 'user' || message.status === 'done')).slice(-contextWindow)
    .map(({ role, content }) => ({ role, content }));
  return [{ role: 'system' as const, content: '你是零伴，一位友善、真诚的 AI 助手。请自然、简洁地回应用户。' }, ...history];
}

/** A single owner captures each session/model and keeps network retry separate from disk retry. */
export function createChatEngine(deps: ChatEngineDependencies) {
  let inFlight: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let generatingSession: string | null = null;
  let unsaved: (() => Promise<void>) | null = null;
  let unsavedSession: string | null = null;
  let persistence: Promise<void> | null = null;
  let deleting = 0;
  let maintenance = false;

  const runtime = deps.setRuntime;
  function put(session: SessionRecord, messages: MessageRecord[], activate = false) {
    const state = deps.getChat();
    const ids = new Set(messages.map((message) => message.id));
    deps.setChat({ sessions: sorted([...state.sessions.filter((item) => item.id !== session.id), session]),
      messages: [...state.messages.filter((item) => !ids.has(item.id)), ...messages]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      ...(activate ? { activeSessionId: session.id } : {}),
    });
  }
  function putMessage(message: MessageRecord) {
    deps.setChat({ messages: deps.getChat().messages.map((item) => item.id === message.id ? { ...message } : item) });
  }
  function remember(sessionId: string, write: () => Promise<void>) {
    unsaved = write;
    unsavedSession = sessionId;
    runtime({ persistenceError: SAVE_ERROR, hasUnsaved: true });
  }
  function launch(work: (signal: AbortSignal) => Promise<void>) {
    if (inFlight || persistence || deleting || maintenance || deps.isAppMaintenanceActive?.()) return Promise.resolve();
    if (unsaved) { runtime({ error: '请先保存当前消息，再继续发送。' }); return Promise.resolve(); }
    controller = new AbortController();
    const signal = controller.signal;
    generatingSession = deps.getChat().activeSessionId;
    runtime({ isSending: true, error: null, streamingSessionId: generatingSession });
    inFlight = Promise.resolve().then(() => work(signal)).catch(() => {
      runtime({ error: '暂时无法发送，请重试。' });
    }).finally(() => {
      controller = null;
      generatingSession = null;
      inFlight = null;
      runtime({ isSending: false, streamingSessionId: null });
    });
    return inFlight;
  }
  async function execute(text: string | null, retryId: string | null, onAccepted?: (sessionId: string) => void) {
    if (inFlight || persistence || deleting || maintenance || deps.isAppMaintenanceActive?.()) return;
    if (unsaved) { runtime({ error: '请先保存当前消息，再继续发送。' }); return; }
    const requestedSessionId = deps.getChat().activeSessionId;
    const requestedSession = deps.getChat().sessions.find((session) => session.id === requestedSessionId);
    let selectedRole: ReturnType<typeof resolveRoleRuntime>;
    try {
      if (requestedSession && !requestedSession.personaId) throw new Error('此会话的角色已删除，请开始新会话。');
      const companion = deps.getCompanion(requestedSession?.personaId);
      selectedRole = resolveRoleRuntime({ id: companion.personaId, profile: companion.data.profile,
        memories: companion.data.memories, interests: companion.data.interests, isActive: false,
        configuration: companion.configuration }, deps.getModels(), companion.data.thinking, deps.getSettings());
    } catch (error) {
      runtime({ error: error instanceof Error ? error.message : '角色配置无法使用，请检查角色设置。' }); return;
    }
    // Resolve and freeze one complete role before any asynchronous key/storage work.
    const { model, data, settings, personaId } = JSON.parse(JSON.stringify(selectedRole)) as typeof selectedRole;
    return launch(async (signal) => {
      await deps.initialize();
      const state = deps.getChat();
      generatingSession = requestedSessionId;
      runtime({ streamingSessionId: generatingSession });
      let apiKey: string | null;
      try { apiKey = await deps.getApiKey(model.apiKeyAlias); }
      catch { runtime({ error: '无法读取模型密钥，请在模型设置中检查后重试。' }); return; }
      // A credential edited for another endpoint must never be sent to a captured old endpoint.
      if (deps.getModels().find((item) => item.id === model.id)?.updatedAt !== model.updatedAt) {
        runtime({ error: '模型配置已更改，请重新发送。' }); return;
      }
      if ((model.apiKeyAlias !== null || model.provider !== 'custom') && !apiKey) {
        runtime({ error: '请先在模型设置中填写 API Key。' }); return;
      }
      if (signal.aborted) return;
      if (!Number.isInteger(settings.contextWindow) || settings.contextWindow < 1 || settings.contextWindow > 100 || typeof settings.streamOutput !== 'boolean') {
        runtime({ error: '聊天设置无效，请在这个角色的高级设置中重新保存。' }); return;
      }
      const now = deps.now();
      let session = state.sessions.find((item) => item.id === requestedSessionId);
      if (requestedSessionId !== null && !session) { runtime({ error: '会话已不存在，请开始新会话。' }); return; }
      let prior: MessageRecord[] = session ? await deps.repository.getMessages(session.id) : [];
      let user: MessageRecord;
      let assistant: MessageRecord;
      let legacySnapshot: LegacyCotSnapshot | null = null;
      let originalAttempt: CotAttemptSnapshot | null = null;
      if (retryId) {
        const last = prior[prior.length - 1];
        const previous = prior[prior.length - 2];
        if (!session || last?.id !== retryId || last.role !== 'assistant'
          || !['error', 'aborted'].includes(last.status) || previous?.role !== 'user') {
          runtime({ error: '只能重试当前会话最后一条失败或中断的回复。' }); return;
        }
        user = previous;
        if (last.cotAudit?.version === 2) {
          legacySnapshot = last.cotAudit.legacySnapshot ?? null;
          originalAttempt = last.cotAudit.originalAttempt ?? captureCotAttempt(last.cotAudit, last.modelId);
          originalAttempt = JSON.parse(JSON.stringify(originalAttempt));
        }
        else if (last.thinkingMode == null) legacySnapshot = {
          cotMode: last.cotMode, cotPresetId: last.cotPresetId, modelId: last.modelId,
          audit: last.cotAudit?.version === 1 ? last.cotAudit : null,
        };
        if (legacySnapshot) legacySnapshot = JSON.parse(JSON.stringify(legacySnapshot));
        assistant = { ...last, content: '', reasoning: '', status: 'pending', error: null,
          modelId: model.id, cotPresetId: null };
        prior = prior.slice(0, -1);
      } else {
        if (!text?.trim()) return;
        session ??= { id: deps.id(), title: Array.from(text.trim()).slice(0, 20).join(''),
          modelId: model.id, personaId, pinned: false, createdAt: now, updatedAt: now };
        user = { id: deps.id(), sessionId: session.id, role: 'user', content: text.trim(), reasoning: '',
          status: 'done', error: null, cotMode: 'off', cotPresetId: null, modelId: model.id, createdAt: now };
        // A distinct timestamp guarantees user-before-assistant even when DB rows are later upserted.
        assistant = { ...user, id: deps.id(), role: 'assistant', content: '', status: 'pending',
          createdAt: new Date(Date.parse(now) + 1).toISOString() };
        prior = [...prior, user];
      }
      if (!session || signal.aborted) return;
      let request: BuiltChatRequest;
      try { request = buildRequestMessages(model, data, buildChatContext(prior, settings.contextWindow), new Date(now)); }
      catch (error) {
        runtime({ error: error instanceof CotConfigurationError ? error.message : '思维链配置无法使用，请检查后重试。' });
        return;
      }
      request.audit = { ...request.audit, legacySnapshot };
      if (originalAttempt) request.audit.originalAttempt = originalAttempt;
      assistant = { ...assistant, thinkingMode: request.audit.effectiveMode, cotPresetId: request.audit.templateId, cotAudit: request.audit };
      if (!retryId) user = { ...user, thinkingMode: request.audit.effectiveMode, cotPresetId: request.audit.templateId };
      session = { ...session, modelId: model.id, updatedAt: now };
      generatingSession = session.id;
      runtime({ streamingSessionId: session.id });
      const localSession = session;
      try {
        session = await deps.repository.saveChatTurn(session, retryId ? [assistant] : [user, assistant]);
        put(session, retryId ? [assistant] : [user, assistant], !retryId && state.activeSessionId === null
          && deps.getChat().activeSessionId === null);
      } catch {
        assistant = { ...assistant, status: 'error', error: '尚未发送，请先保存消息后重试。' };
        put(localSession, retryId ? [assistant] : [user, assistant], !retryId && state.activeSessionId === null
          && deps.getChat().activeSessionId === null);
        const draft = { ...assistant };
        remember(localSession.id, async () => {
          const saved = await deps.repository.saveChatTurn(localSession, retryId ? [draft] : [user, draft]);
          put(saved, retryId ? [draft] : [user, draft]);
        });
        try { onAccepted?.(localSession.id); } catch { /* UI callback failures never alter persistence or network state. */ }
        return;
      }
      try { onAccepted?.(session.id); } catch { /* UI callback failures never alter generation. */ }
      const capturedSession = session;
      const appendContent = (delta: string) => {
        if (signal.aborted || assistant.status !== 'streaming') return;
        assistant = { ...assistant, content: assistant.content + delta };
        putMessage(assistant);
      };
      try {
        if (signal.aborted) throw new ApiError('cancelled');
        assistant = { ...assistant, status: 'streaming' };
        putMessage(assistant);
        const completion = await deps.stream({ baseUrl: request.baseUrl, apiModel: model.apiModel, apiKey,
          messages: request.messages, requestParameters: request.requestParameters, streamOutput: settings.streamOutput, signal,
          allowJsonFallback: model.provider === 'custom',
          onContent: appendContent,
          onReasoning: (delta) => {
            if (signal.aborted || assistant.status !== 'streaming') return;
            assistant = { ...assistant, reasoning: assistant.reasoning + delta };
            putMessage(assistant);
          },
        });
        const lengthLimited = completion?.finishReason === 'length';
        if (!signal.aborted && !assistant.content.trim() && !(lengthLimited && assistant.reasoning.trim())) throw new ApiError('empty_response');
        // Existing persisted feedback holds a notice for done replies; done is never eligible for retry.
        assistant = { ...assistant, status: signal.aborted ? 'aborted' : 'done',
          error: signal.aborted ? CANCELLED : lengthLimited ? LENGTH_NOTICE : null };
      } catch (error) {
        const cancelled = signal.aborted || (error instanceof ApiError && error.code === 'cancelled');
        const safeError = cancelled ? CANCELLED : error instanceof ApiError ? error.message
          : '生成失败，请检查网络和模型设置后重试。';
        assistant = { ...assistant, status: cancelled ? 'aborted' : 'error', error: safeError };
      }
      putMessage(assistant);
      const finished = { ...assistant };
      const updatedAt = deps.now();
      const persist = async () => {
        const saved = await deps.repository.finishChatTurn(capturedSession.id, finished, updatedAt);
        put(saved, [finished]);
      };
      try { await persist(); }
      catch { remember(capturedSession.id, persist); }
    });
  }
  return {
    sendChatMessage: (text: string, onAccepted?: (sessionId: string) => void) => !text.trim() ? Promise.resolve() : execute(text, null, onAccepted),
    retryChatMessage: (id: string) => execute(null, id),
    stopGeneration: () => { controller?.abort(); },
    startNewConversation: () => {
      if (inFlight || persistence || deleting || maintenance || deps.isAppMaintenanceActive?.()) return;
      if (unsaved) { runtime({ error: '请先保存当前消息，再开始新会话。' }); return; }
      deps.setChat({ activeSessionId: null });
      runtime({ error: null });
    },
    openChatSession: async (id: string) => {
      await deps.initialize();
      if (!deps.getChat().sessions.some((session) => session.id === id)) return;
      // In-memory messages include partial output and unsaved drafts; loading must not replace them.
      deps.setChat({ activeSessionId: id });
      runtime({ error: null });
    },
    deleteChatSession: async (id: string) => {
      deleting += 1;
      try {
        if (generatingSession === id) { controller?.abort(); await inFlight; }
        if (persistence) await persistence;
        await deps.repository.deleteSession(id);
        const state = deps.getChat();
        deps.setChat({ sessions: state.sessions.filter((session) => session.id !== id),
          messages: state.messages.filter((message) => message.sessionId !== id),
          activeSessionId: state.activeSessionId === id ? null : state.activeSessionId });
        // Deleting this turn explicitly discards its draft; another session's draft is retained.
        if (unsavedSession === id) {
          unsaved = null;
          unsavedSession = null;
          runtime({ persistenceError: null, hasUnsaved: false });
        }
      } finally { deleting -= 1; }
    },
    retryChatPersistence: () => {
      if (!unsaved || inFlight || deleting || maintenance || deps.isAppMaintenanceActive?.()) return Promise.resolve();
      if (persistence) return persistence;
      const write = unsaved;
      persistence = write().then(() => {
        if (unsaved === write) { unsaved = null; unsavedSession = null; }
        runtime({ persistenceError: null, hasUnsaved: false, error: null });
      }).catch(() => { runtime({ persistenceError: SAVE_ERROR, hasUnsaved: true }); })
        .finally(() => { persistence = null; });
      return persistence;
    },
    withChatMaintenance: async <T,>(work: () => Promise<T>, options: { stop?: boolean; discardUnsaved?: boolean | (() => boolean) } = {}): Promise<T> => {
      if (maintenance || deleting) throw new Error('正在处理本地数据，请稍后重试。');
      if (inFlight && !options.stop) throw new Error('请等待回复完成后再导出。');
      maintenance = true;
      try {
        if (options.stop) controller?.abort();
        if (inFlight) await inFlight;
        if (persistence) await persistence;
        if (unsaved && !options.discardUnsaved) throw new Error('请先保存当前消息，再导出会话。');
        const result = await work();
        if (typeof options.discardUnsaved === 'function' ? options.discardUnsaved() : options.discardUnsaved) {
          unsaved = null; unsavedSession = null;
          runtime({ persistenceError: null, hasUnsaved: false, error: null });
        }
        return result;
      } finally { maintenance = false; }
    },
  };
}
