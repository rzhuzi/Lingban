/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function harness() {
  const slots = [];
  let cursor = 0;
  const react = {
    memo: (component) => component,
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useMemo(factory, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        slots[index] = { deps, value: factory() };
      }
      return slots[index].value;
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
  };
  function load(relative, seams) {
    const filename = path.resolve(__dirname, '..', relative);
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: filename,
    }).outputText;
    const loaded = { exports: {} };
    vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`, { filename })(
      (name) => { assert.ok(name in seams, name); return seams[name]; }, loaded, loaded.exports);
    return loaded.exports;
  }
  // Execute the installed FlashList hook so its real dependency-reset behavior is covered.
  const { useRecyclingState } = load('node_modules/@shopify/flash-list/src/recyclerview/hooks/useRecyclingState.ts', {
    react, './useLayoutState': { useLayoutState: react.useState },
  });
  const element = (type, props) => ({ type, props: props || {} });
  const { MessageBubble } = load('src/features/chat/message-bubble.tsx', {
    react, 'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': { ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', View: 'View',
      StyleSheet: { create: (styles) => styles } },
    '@shopify/flash-list': { useRecyclingState },
    '@/components/app-icon': { AppIcon: 'AppIcon' },
    '@/components/themed-text': { ThemedText: 'ThemedText' },
    '@/constants/typography': { Typography: {} },
    '@/hooks/use-theme': { useTheme: () => ({}) },
    '@/lib/chat/engine': { retryChatMessage() {} },
    './audit-sheet': { AuditSheet: 'AuditSheet' },
  });
  let message = { id: 'reply-a', role: 'assistant', content: '', reasoning: '正在返回的思考', status: 'streaming' };
  let block;
  let toggles = 0;
  function render(patch = {}) {
    message = { ...message, ...patch };
    cursor = 0;
    const bubble = MessageBubble({ message, canRetry: false, onReasoningToggle: () => { toggles += 1; } });
    const reasoning = bubble.props.children.find((child) => child && typeof child.type === 'function');
    assert.ok(reasoning, 'The actual message bubble must contain a reasoning block.');
    block = reasoning.type(reasoning.props);
  }
  render();
  return {
    render,
    expanded: () => block.props.children[0].props.accessibilityState.expanded,
    visibleReasoning: () => block.props.children[1]?.props.children,
    toggle: () => { block.props.children[0].props.onPress(); render(); },
    toggles: () => toggles,
  };
}

test('manually expanded reasoning remains open when the first answer content arrives', () => {
  const app = harness();
  app.toggle();
  assert.equal(app.expanded(), true);
  app.render({ content: '正文首片段' });
  assert.equal(app.expanded(), true);
  assert.equal(app.visibleReasoning(), '正在返回的思考');
  app.render({ content: '正文继续增长', status: 'done' });
  assert.equal(app.expanded(), true);
  assert.equal(app.toggles(), 1);
});

test('manually closed reasoning stays closed through answer and completion updates', () => {
  const app = harness();
  app.toggle(); app.toggle();
  app.render({ content: '正文首片段', reasoning: '思考更新' });
  assert.equal(app.expanded(), false);
  app.render({ content: '完整正文', status: 'done' });
  assert.equal(app.expanded(), false);
  assert.equal(app.visibleReasoning(), undefined);
});

test('a recycled bubble resets reasoning expansion for a different message identity', () => {
  const app = harness();
  app.toggle();
  app.render({ id: 'reply-b', content: '另一条正文', reasoning: '另一条思考', status: 'done' });
  assert.equal(app.expanded(), false);
  app.toggle();
  assert.equal(app.visibleReasoning(), '另一条思考');
  app.render({ id: 'reply-a', content: '', reasoning: '原思考', status: 'streaming' });
  assert.equal(app.expanded(), false);
});

test('reasoning remains collapsed by default without a user toggle', () => {
  const app = harness();
  app.render({ content: '正文首片段' });
  assert.equal(app.expanded(), false);
  assert.equal(app.toggles(), 0);
});
