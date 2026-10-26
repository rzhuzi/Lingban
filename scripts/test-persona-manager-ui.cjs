const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createUiHarness } = require('./helpers/ui-harness.cjs');

function environment({ activeId = 'a', ownerId = 'b', confirmed = true, failSwitch = false } = {}) {
  const calls = [];
  const personas = ['a', 'b', 'c'].map((id) => ({ id, profile: { name: id.toUpperCase() },
    configuration: { confirmed: id !== 'c' || confirmed, currentModelId: 'model' }, isActive: id === activeId }));
  const chat = { activeSessionId: 'history', sessions: [{ id: 'history', personaId: ownerId }],
    messages: [{ id: 'old-message', sessionId: 'history', content: '保留历史内容' }] };
  const state = { personas, activePersonaId: activeId, busy: false,
    switchPersona: async (id) => {
      calls.push(['switch', id]);
      if (failSwitch) throw new Error('fixture switch failed');
      state.activePersonaId = id;
    } };
  const store = (value) => Object.assign((select) => select ? select(value) : value, { getState: () => value });
  const app = createUiHarness('src/features/companion/persona-manager.tsx', 'PersonaManager', {
    'expo-router': { router: {
      replace: (route) => calls.push(['replace', route]), push: (route) => calls.push(['push', route]),
    } },
    '@/components/role-avatar': { RoleAvatar: 'RoleAvatar' },
    '@/lib/chat/engine': { startNewConversation: () => { calls.push(['new']); chat.activeSessionId = null; } },
    '@/lib/chat/runtime': { useChatRuntimeStore: store({ isSending: false, hasUnsaved: false }) },
    '@/stores/app-stores': { usePersonaStore: store(state), useChatStore: store(chat),
      useModelStore: store({ models: [] }), useAppMaintenanceStore: store({ active: false }) },
  });
  app.press('切换和管理角色');
  return { app, calls, chat, state };
}

test('choosing active role A from role B history starts A without changing the history owner', async () => {
  const { app, calls, chat, state } = environment();
  const originalHistory = structuredClone({ sessions: chat.sessions, messages: chat.messages });
  app.press('切换角色：A'); await app.settle();
  assert.equal(chat.activeSessionId, null, 'Selecting A must leave the B history session.');
  assert.equal(state.activePersonaId, 'a');
  assert.deepEqual(calls, [['switch', 'a'], ['new'], ['replace', '/(tabs)']]);
  assert.deepEqual({ sessions: chat.sessions, messages: chat.messages }, originalHistory);
});

test('selecting the current conversation role when it is also active preserves the current conversation', async () => {
  const { app, calls, chat } = environment({ ownerId: 'a' });
  app.press('切换角色：A'); await app.settle();
  assert.equal(chat.activeSessionId, 'history');
  assert.deepEqual(calls, [['replace', '/(tabs)']]);
});

test('selecting the viewed role or another role synchronizes the active role and starts a new conversation', async () => {
  for (const selectedId of ['b', 'c']) {
    const { app, calls, chat, state } = environment();
    app.press('切换角色：' + selectedId.toUpperCase()); await app.settle();
    assert.equal(state.activePersonaId, selectedId);
    assert.equal(chat.activeSessionId, null);
    assert.deepEqual(calls, [['switch', selectedId], ['new'], ['replace', '/(tabs)']]);
    assert.equal(chat.sessions[0].personaId, 'b');
  }
});

test('role manager marks the viewed conversation owner instead of the role used for new chats', () => {
  const { app } = environment();
  assert.equal(app.find('切换角色：A').props.accessibilityState.checked, false);
  assert.equal(app.find('切换角色：B').props.accessibilityState.checked, true);
});

test('switch failure preserves the viewed history and keeps the error retryable', async () => {
  const { app, calls, chat } = environment({ failSwitch: true });
  app.press('切换角色：C'); await app.settle();
  assert.equal(chat.activeSessionId, 'history');
  assert.deepEqual(calls, [['switch', 'c']]);
  assert.match(app.text(), /fixture switch failed/);
});

test('an unconfirmed selected role opens its configuration after leaving the prior conversation', async () => {
  const { app, calls, chat } = environment({ confirmed: false });
  app.press('切换角色：C'); await app.settle();
  assert.equal(chat.activeSessionId, null);
  assert.deepEqual(calls, [['switch', 'c'], ['new'], ['push', { pathname: '/role', params: { id: 'c' } }]]);
});
