/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

// Execute the real UI with persistent hooks. Native rendering/keyboard motion still
// needs device QA; this seam verifies the actual props, callbacks and animation tree.
function componentHarness(file, component, seams, initialProps) {
  const slots = [];
  const effects = [];
  let cursor = 0;
  let dirty = true;
  let tree;
  let props = initialProps;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (next) => {
        const value = typeof next === 'function' ? next(slots[index]) : next;
        if (!Object.is(slots[index], value)) { slots[index] = value; dirty = true; }
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        slots[index] = { deps, cleanup: previous?.cleanup };
        effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = effect(); });
      }
    },
  };
  const element = (type, elementProps) => ({ type, props: elementProps || {} });
  const dependencies = {
    ...require('./helpers/style-constants.cjs'),
    react,
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
    '@/components/app-icon': { AppIcon: 'Ionicons' },
    'expo-router': { router: {} },
    '@/components/themed-text': { ThemedText: 'ThemedText' },
    '@/hooks/use-theme': { useTheme: () => ({}) },
    ...seams,
  };
  const absolute = path.resolve(__dirname, '..', file);
  const compiled = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: absolute,
  }).outputText;
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`, { filename: absolute })(
    (id) => { assert.ok(id in dependencies, `Unexpected UI dependency: ${id}`); return dependencies[id]; }, module, module.exports,
  );
  const render = (nextProps = props) => {
    props = nextProps;
    dirty = true;
    let attempts = 0;
    while (dirty) {
      assert.ok(attempts++ < 20, 'UI effects should settle.');
      dirty = false;
      cursor = 0;
      tree = module.exports[component](props);
      for (const effect of effects.splice(0)) effect();
    }
    return tree;
  };
  const nodes = (predicate, node = tree, ancestors = [], matches = []) => {
    if (Array.isArray(node)) node.forEach((child) => nodes(predicate, child, ancestors, matches));
    else if (node && typeof node === 'object') {
      if (predicate(node)) matches.push({ node, ancestors });
      if (node.props?.children !== undefined) nodes(predicate, node.props.children, [...ancestors, node], matches);
    }
    return matches;
  };
  render();
  return { render, nodes, unmount: () => slots.forEach((slot) => slot?.cleanup?.()),
    settle: async () => { await Promise.resolve(); await Promise.resolve(); render(); } };
}

function nativeSeam() {
  return {
    ...Object.fromEntries(['ActivityIndicator', 'KeyboardAvoidingView', 'Modal', 'Pressable', 'ScrollView', 'TextInput', 'View'].map((name) => [name, name])),
    Platform: { OS: 'android' },
    StyleSheet: { create: (styles) => styles, hairlineWidth: 1, absoluteFill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } },
    Keyboard: { dismiss() {} },
    useWindowDimensions: () => ({ height: 800, width: 400, scale: 1, fontScale: 1 }),
  };
}

const flatten = (style) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));

function sheetHarness({ reduced = false, deferred = false } = {}) {
  const runs = [];
  const listeners = new Set();
  let resolvePreference;
  const native = nativeSeam();
  class Value {
    constructor(value) { this.value = value; }
    setValue(value) { this.value = value; }
    stopAnimation() { this.run?.stop(); }
    interpolate(config) { return { source: this, ...config }; }
  }
  native.Animated = {
    Value, View: 'Animated.View',
    timing(value, config) {
      const run = { value, config, stopped: false,
        start(callback) { this.callback = callback; value.run = this; runs.push(this); },
        stop() { this.stopped = true; this.callback?.({ finished: false }); },
        finish() { if (!this.stopped) { value.setValue(config.toValue); this.callback?.({ finished: true }); } },
      };
      return run;
    },
  };
  native.AccessibilityInfo = {
    isReduceMotionEnabled: () => deferred ? new Promise((resolve) => { resolvePreference = resolve; }) : Promise.resolve(reduced),
    addEventListener: (name, listener) => {
      assert.equal(name, 'reduceMotionChanged');
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
  };
  let closed = 0;
  const props = { visible: true, title: '选择模型', onClose: () => { closed += 1; }, children: '可编辑内容' };
  const app = componentHarness('src/components/customization-ui.tsx', 'Sheet', {
    'react-native': native,
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ bottom: 24 }) },
    '@/features/companion/companion-store': { useCompanion: () => ({}) },
  }, props);
  const modal = () => app.nodes((node) => node.type === 'Modal')[0].node;
  const show = () => { modal().props.onShow?.(); app.render(); };
  return { ...app, props, runs, listeners, modal, show, closed: () => closed,
    preference: (value) => { listeners.forEach((listener) => listener(value)); app.render(); },
    resolvePreference: (value) => resolvePreference(value) };
}

test('LB-0501: backdrop stays full-screen outside panel translation and keyboard resizing', async () => {
  const app = sheetHarness();
  await app.settle();
  app.show();
  assert.equal(app.modal().props.animationType, 'none', 'The native Modal must not slide its entire subtree.');
  const { node: backdrop, ancestors } = app.nodes((node) => node.type === 'Pressable' && node.props.accessibilityLabel === '关闭选择模型')[0];
  assert.equal(ancestors.some((node) => node.type === 'KeyboardAvoidingView'), false, 'The backdrop must cover the window even while the keyboard moves the panel.');
  assert.ok(ancestors.every((node) => !flatten(node.props.style).transform), 'No translated ancestor may contain the backdrop.');
  assert.deepEqual({ ...flatten(backdrop.props.style), opacity: undefined }, {
    position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, opacity: undefined,
  });
  const panel = app.nodes((node) => node.type === 'Animated.View' && flatten(node.props.style).transform)[0]?.node;
  assert.ok(panel, 'The panel alone must have its own slide animation.');
  assert.equal(app.runs.length, 1);
  assert.equal(app.runs[0].config.useNativeDriver, true);
  app.modal().props.onRequestClose();
  backdrop.props.onPress();
  assert.equal(app.closed(), 2, 'Both Android back and the backdrop must still request closure.');
});

test('LB-0501: closing cancels an opening animation; reopening starts a fresh one', async () => {
  const app = sheetHarness();
  await app.settle();
  app.show();
  assert.equal(app.runs.length, 1);
  const first = app.runs[0];
  first.value.setValue(0.4);
  app.render({ ...app.props, visible: false });
  assert.equal(app.modal().props.visible, false, 'Do not keep a hidden native modal blocking another Sheet.');
  assert.equal(first.stopped, true);
  app.render(app.props);
  app.show();
  await app.settle();
  assert.equal(app.runs.length, 2);
  assert.equal(app.runs[1].value.value, 0);
  first.finish();
  assert.equal(app.modal().props.visible, true, 'A stale animation cannot hide the newly opened Sheet.');
  app.unmount();
  assert.equal(app.runs[1].stopped, true);
  assert.equal(app.listeners.size, 0);
});

test('LB-0501: reduced motion skips sliding and reacts to a changed system preference', async () => {
  const app = sheetHarness({ reduced: true });
  await app.settle();
  app.show();
  assert.equal(app.runs.length, 0);
  const panelStyle = flatten(app.nodes((node) => node.type === 'Animated.View' && flatten(node.props.style).transform)[0].node.props.style);
  assert.equal(panelStyle.transform[0].translateY.source.value, 1);
  app.preference(false);
  app.render({ ...app.props, visible: false });
  app.render(app.props);
  app.show();
  await app.settle();
  const run = app.runs.at(-1);
  assert.ok(run);
  app.preference(true);
  assert.equal(run.stopped, true);
  assert.equal(run.value.value, 1);
});

test('LB-0501: an old preference lookup cannot override a newer system event', async () => {
  const app = sheetHarness({ deferred: true });
  app.show();
  app.preference(true);
  app.resolvePreference(false);
  await app.settle();
  assert.equal(app.runs.length, 0);
});

function composerHarness() {
  const runtime = { isSending: false, hasUnsaved: false };
  const maintenance = { active: false };
  const personas = { personas: [], busy: false };
  const models = { models: [{}] };
  const sends = [];
  let stops = 0;
  let selections = 0;
  const app = componentHarness('src/features/chat/chat-composer.tsx', 'ChatComposer', {
    'react-native': nativeSeam(),
    '@/features/companion/companion-store': { useCompanion: () => ({ data: { profile: { name: '伙伴' } } }) },
    '@/lib/chat/runtime': { useChatRuntimeStore: (select) => select(runtime) },
    '@/lib/chat/engine': {
      sendChatMessage: async (text, accepted) => { sends.push({ text, accepted }); runtime.isSending = true; },
      stopGeneration: () => { stops += 1; runtime.isSending = false; },
    },
    '@/stores/app-stores': {
      useChatStore: (select) => select({ sessions: [], activeSessionId: null }),
      useModelStore: { getState: () => models },
      usePersonaStore: (select) => select(personas),
      useAppMaintenanceStore: (select) => select(maintenance),
    },
  }, { onSelectModel: () => { selections += 1; } });
  const input = () => app.nodes((node) => node.type === 'TextInput')[0].node;
  const button = () => app.nodes((node) => node.type === 'Pressable')[0].node;
  const change = (value) => { input().props.onChangeText(value); app.render(); };
  const press = () => { assert.equal(button().props.disabled, false); button().props.onPress(); app.render(); };
  return { ...app, runtime, maintenance, personas, models, sends, input, button, change, press,
    stops: () => stops, selections: () => selections };
}

test('LB-0508: return inserts a newline while the explicit button sends the multiline text', () => {
  const app = composerHarness();
  assert.equal(app.input().props.multiline, true);
  assert.equal(app.input().props.submitBehavior, 'newline');
  assert.equal(app.input().props.returnKeyType, 'default');
  assert.equal(app.input().props.onSubmitEditing, undefined, 'Return should not submit or clear the draft.');
  app.change('第一行\n第二行');
  app.press();
  assert.equal(app.sends[0].text, '第一行\n第二行');
  app.sends[0].accepted();
  app.render();
  assert.equal(app.input().props.value, '');
});

test('LB-0508: generating keeps the next draft editable, with the button still stopping generation', () => {
  const app = composerHarness();
  app.change('第一条');
  app.press();
  app.sends[0].accepted();
  app.render();
  assert.equal(app.input().props.editable, true);
  app.change('下一条\n继续编辑');
  assert.equal(app.button().props.accessibilityLabel, '停止生成');
  app.press();
  assert.equal(app.stops(), 1);
  assert.equal(app.sends.length, 1);
  assert.equal(app.input().props.value, '下一条\n继续编辑');
  assert.equal(app.button().props.accessibilityLabel, '发送消息');
  app.press();
  assert.equal(app.sends[1].text, '下一条\n继续编辑');
});

test('LB-0508: delayed acceptance never clears an edited draft, even when text matches again', () => {
  const app = composerHarness();
  app.change('同一句');
  app.press();
  app.change('改过');
  app.change('同一句');
  app.sends[0].accepted();
  app.render();
  assert.equal(app.input().props.value, '同一句');
  app.runtime.isSending = false;
  app.render();
  assert.equal(app.input().props.value, '同一句', 'Finishing generation must preserve the next draft.');
});

test('LB-0508: blocked operations and missing-model selection retain the draft', () => {
  const app = composerHarness();
  app.change('保存草稿');
  app.runtime.hasUnsaved = true;
  app.render();
  assert.equal(app.button().props.disabled, true);
  app.runtime.hasUnsaved = false;
  app.maintenance.active = true;
  app.render();
  assert.equal(app.input().props.editable, false);
  assert.equal(app.button().props.disabled, true);
  app.maintenance.active = false;
  app.personas.busy = true;
  app.render();
  assert.equal(app.input().props.editable, false);
  app.personas.busy = false;
  app.models.models = [];
  app.render();
  app.press();
  assert.equal(app.selections(), 1);
  assert.equal(app.sends.length, 0);
  assert.equal(app.input().props.value, '保存草稿');
});
