/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const LIMIT_NOTICE = '回复已达长度上限，可继续提问让模型接着回答。';
const element = (type, props) => ({ type, props: props ?? {} });
function renderComponent(file, name, props, recovery = { notice: null }) {
  const native = Object.fromEntries(['ActivityIndicator', 'Pressable', 'View'].map((key) => [key, key]));
  native.StyleSheet = { create: (styles) => styles, hairlineWidth: 1 };
  const seams = {
    ...require('./helpers/style-constants.cjs'),
    react: { memo: (component) => component },
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': native,
    '@/components/app-icon': { AppIcon: 'Ionicons' },
    '@shopify/flash-list': { useRecyclingState: (value) => [value, () => {}] },
    '@/components/themed-text': { ThemedText: 'ThemedText' },
    '@/hooks/use-theme': { useTheme: () => ({}) },
    '@/lib/chat/engine': { retryChatMessage: () => { throw new Error('Unexpected network retry'); } },
    '@/stores/app-stores': { useAppRecoveryStore: (select) => select(recovery) },
    './audit-sheet': { AuditSheet: 'AuditSheet' },
  };
  const module = { exports: {} };
  const filename = path.resolve(__dirname, '..', file);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports: module.exports, module, require(id) {
    if (id in seams) return seams[id];
    throw new Error(`Unexpected import: ${id}`);
  } }, { filename });
  return module.exports[name](props);
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...nodes(tree.props.children)];
}
function textContent(tree) {
  if (Array.isArray(tree)) return tree.map(textContent).join('');
  if (typeof tree === 'string') return tree;
  return tree && typeof tree === 'object' ? textContent(tree.props.children) : '';
}
const message = { id: 'reply', role: 'assistant', content: '已有正文', reasoning: '', status: 'done', error: null };

test('LB-0506: length-limited done message displays a neutral persisted notice without retry', () => {
  const tree = renderComponent('src/features/chat/message-bubble.tsx', 'MessageBubble', {
    message: { ...message, error: LIMIT_NOTICE }, canRetry: false,
  });
  assert.ok(textContent(tree).includes(LIMIT_NOTICE));
  assert.ok(textContent(tree).includes('已有正文'));
  assert.equal(nodes(tree).some((node) => node.props.accessibilityRole === 'alert'), false);
  assert.equal(nodes(tree).some((node) => node.props.accessibilityLabel === '重试回复'), false);
});
test('ordinary done message has no truncation notice and real failures remain alerts', () => {
  const done = renderComponent('src/features/chat/message-bubble.tsx', 'MessageBubble', { message, canRetry: false });
  assert.equal(textContent(done).includes(LIMIT_NOTICE), false);
  const failed = renderComponent('src/features/chat/message-bubble.tsx', 'MessageBubble', {
    message: { ...message, status: 'error', error: '请求失败' }, canRetry: true,
  });
  assert.ok(nodes(failed).some((node) => node.props.accessibilityRole === 'alert'));
});
test('LB-0504: recovery information is visible and dismissible without retrying a write', () => {
  const state = { notice: '个别历史消息的配置快照已忽略。', dismissNotice() { this.notice = null; } };
  // Zustand actions do not rely on their receiver.
  state.dismissNotice = () => { state.notice = null; };
  const render = () => renderComponent('src/components/recovery-notice.tsx', 'RecoveryNotice', {}, state);
  const tree = render();
  assert.ok(textContent(tree).includes(state.notice));
  const close = nodes(tree).find((node) => node.props.accessibilityLabel === '关闭恢复提示');
  assert.ok(close);
  close.props.onPress();
  assert.equal(render(), null);
});
