/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const NEW_KEY = 'fixture-editor-new-credential';
const STORED_KEY = 'fixture-editor-stored-credential';
const NEW_URL = 'https://new-endpoint.invalid/v1';
const FINAL_URL = 'https://final-endpoint.invalid/api/v3';
const existingModel = {
  id: 'fixture-model', name: 'Fixture', provider: 'deepseek', baseUrl: 'https://api.deepseek.com',
  apiModel: 'fixture-model', apiKeyAlias: 'fixture-model-alias', isDefault: true,
  cotMode: 'off', cotPresetId: null, createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z',
};

// Run the real component with persistent state/ref slots and controlled mount effects.
// Hold entry-time auto-discovery timers so tests drive explicit rendered input events.
async function harness(model, extraProps = {}, controls = {}) {
  const slots = [];
  const effects = [];
  let cursor = 0;
  let tree;
  const calls = { list: [], storedKeyReads: [], saves: [], confirmations: [], routes: [], prevent: null, disabled: 0 };
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
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
  const element = (type, props, key) => ({ type, props: props || {}, key });
  const ui = Object.fromEntries(['Card', 'DetailScreen', 'Field', 'Sheet', 'SmallAction'].map((name) => [name, name]));
  const native = Object.fromEntries(['ActivityIndicator', 'Pressable', 'Switch', 'View'].map((name) => [name, name]));
  native.Platform = { OS: 'android' };
  native.StyleSheet = { create: (value) => value, hairlineWidth: 1 };
  const cache = new Map();
  const editorState = { sessions: {}, begin: (input) => {
    editorState.sessions['fixture-session'] = { model: structuredClone(input) };
    return 'fixture-session';
  }, update: (id, patch) => { Object.assign(editorState.sessions[id].model, structuredClone(patch)); },
  remove: (id) => { delete editorState.sessions[id]; } };
  const useThinkingEditorStore = Object.assign((select) => select(editorState), { getState: () => editorState });
  const seams = {
    react,
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
    'react-native': native,
    '@/components/app-icon': { AppIcon: 'Ionicons' },
    'expo-router': { router: { canGoBack: () => false, back: () => calls.routes.push('back'), replace: (route) => calls.routes.push(route), push() {} },
      usePreventRemove: (flag, callback) => { calls.prevent = { flag, callback }; return () => { calls.disabled += 1; }; } },
    '@/components/customization-ui': { ...ui, useConfirmation: () => ({ confirm: (request) => calls.confirmations.push(request), dialog: null }) },
    '@/components/themed-text': { ThemedText: 'ThemedText' },
    '@/features/companion/defaults': { createId: () => 'new-fixture-model' },
    '@/hooks/use-theme': { useTheme: () => ({}) },
    '@/stores/thinking-editor-store': { useThinkingEditorStore },
    '@/stores/app-stores': {
      useCotStore: (select) => select({ thinking: { templates: [] } }),
      usePersonaStore: (select) => select({ personas: [] }),
      useModelStore: { getState: () => ({ models: model ? [model] : [] }) },
    },
    './model-service': {
      getModelKeySummary: async () => ({ configured: !!model?.apiKeyAlias, lastFour: 'tial' }),
      getModelApiKey: async (alias) => { calls.storedKeyReads.push(alias); return STORED_KEY; },
      saveModelConfiguration: async (...args) => { calls.saves.push(args); if (controls.save) await controls.save(); },
    },
    './model-cleanup-warning': { ModelCleanupWarning: 'ModelCleanupWarning' },
    './remote-model-picker': { RemoteModelPicker: 'RemoteModelPicker' },
  };
  function load(relative) {
    const absolute = path.resolve(__dirname, '..', relative);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const sourcePath = relative === 'src/features/models/model-editor.tsx' && process.env.MODEL_EDITOR_TEST_SOURCE
      ? path.resolve(__dirname, '..', process.env.MODEL_EDITOR_TEST_SOURCE) : absolute;
    const source = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      fileName: absolute,
    }).outputText;
    const module = { exports: {} };
    cache.set(absolute, module);
    const localRequire = (id) => {
      if (id in seams) return seams[id];
      if (id.startsWith('@/')) return load(`src/${id.slice(2)}.ts`);
      if (id.startsWith('.')) return load(path.relative(path.resolve(__dirname, '..'), path.resolve(path.dirname(absolute), `${id}.ts`)));
      throw new Error('Unexpected dependency in model editor harness.');
    };
    vm.runInThisContext(`(function(require,module,exports,setTimeout,clearTimeout){${source}\n})`, { filename: absolute })(
      localRequire, module, module.exports, () => 0, () => {},
    );
    return module.exports;
  }
  const modelsApi = load('src/lib/api/models.ts');
  seams['@/lib/api/models'] = {
    ...modelsApi,
    listModels: async (options) => { calls.list.push(options); return [{ id: 'fixture-discovered-model' }]; },
  };
  const { ModelEditor } = load('src/features/models/model-editor.tsx');
  function render() { cursor = 0; tree = ModelEditor({ model, ...extraProps }); return tree; }
  function find(predicate, node) {
    if (!node || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) {
      for (const child of node) { const match = find(predicate, child); if (match) return match; }
      return undefined;
    }
    if (predicate(node)) return node;
    return find(predicate, node.props?.children);
  }
  function field(label) {
    const node = find((item) => item.type === 'Field' && item.props.label === label, tree);
    assert.ok(node, `Expected rendered field: ${label}`);
    return node;
  }
  function change(label, value) { field(label).props.onChangeText(value); render(); }
  async function fetchModels() {
    const action = find((item) => item.props.accessibilityLabel === '获取模型列表' || item.props.accessibilityLabel === '刷新模型列表', tree);
    assert.ok(action, 'Expected rendered model discovery action.');
    action.props.onPress();
    await new Promise((resolve) => setImmediate(resolve));
    render();
  }
  render();
  for (let i = 0; i < 3; i += 1) {
    for (const effect of effects.splice(0)) effect();
    await Promise.resolve();
    render();
    if (!effects.length) break;
  }
  return { calls, change, field, fetchModels, render, async settle() { await new Promise((resolve) => setImmediate(resolve)); render(); }, async press(label) {
    const node = find((item) => item.props.accessibilityLabel === label, tree);
    assert.ok(node, `Expected action: ${label}`);
    node.props.onPress(); await new Promise((resolve) => setImmediate(resolve)); render();
  }, back() { find((item) => item.type === 'DetailScreen', tree).props.onBack(); }, text: () => {
    const texts = [];
    function collect(node) {
      if (Array.isArray(node)) node.forEach(collect);
      else if (typeof node === 'string') texts.push(node);
      else if (node && typeof node === 'object') collect(node.props?.children);
    }
    collect(tree);
    return texts.join(' ');
  } };
}

test('standalone editor protects edits but not an untouched or restored form', async () => {
  const app = await harness(existingModel);
  assert.equal(app.calls.prevent?.flag, false);
  app.change('API Key', NEW_KEY);
  assert.equal(app.calls.prevent?.flag, true);
  let repeated = 0;
  app.calls.prevent.callback({ repeat: () => { repeated += 1; } });
  assert.equal(repeated, 0);
  assert.equal(app.calls.confirmations.length, 1);
  assert.equal(app.field('API Key').props.value, NEW_KEY);
  app.calls.confirmations[0].onConfirm(); app.render();
  assert.equal(repeated, 1); assert.equal(app.calls.prevent.flag, false);
  assert.equal(app.calls.saves.length, 0);

  const restored = await harness(existingModel);
  restored.change('模型名称', '修改名称'); assert.equal(restored.calls.prevent.flag, true);
  restored.change('模型名称', existingModel.name); assert.equal(restored.calls.prevent.flag, false);
});

test('new untouched model and embedded model draft do not add a second leave guard', async () => {
  const untouched = await harness();
  assert.equal(untouched.calls.prevent?.flag, false);
  const embedded = await harness(undefined, { initialApiKey: NEW_KEY, onComplete() {} });
  embedded.change('API 地址', NEW_URL);
  assert.equal(embedded.calls.prevent?.flag, false);
  assert.equal(embedded.calls.confirmations.length, 0);
});

test('standalone save blocks removal while pending and disables protection only after success', async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const app = await harness(existingModel, {}, { save: () => pending });
  app.change('模型名称', '已修改');
  await app.press('保存模型');
  assert.equal(app.calls.prevent?.flag, true);
  app.calls.prevent.callback({ repeat: () => assert.fail('saving must not leave') });
  assert.equal(app.calls.confirmations.length, 0);
  assert.deepEqual(app.calls.routes, []);
  resolve(); await app.settle();
  assert.equal(app.calls.disabled, 1);
  assert.equal(app.calls.prevent.flag, false);
  assert.deepEqual(app.calls.routes, ['/models']);
});

test('failed standalone save keeps edits protected and retryable', async () => {
  const app = await harness(existingModel, {}, { save: () => { throw new Error('fixture save failed'); } });
  app.change('模型名称', '仍需保存'); await app.press('保存模型');
  assert.equal(app.calls.prevent?.flag, true);
  assert.equal(app.calls.disabled, 0); assert.deepEqual(app.calls.routes, []);
  assert.equal(app.field('模型名称').props.value, '仍需保存');
});

test('new model retains an explicitly entered key across repeated URL edits and discovers at the final URL', async () => {
  const app = await harness();
  app.change('API Key', NEW_KEY);
  app.change('API 地址', NEW_URL);
  assert.ok(app.field('API Key').props.value === NEW_KEY, 'Editing the URL must preserve the key entered in this form.');
  app.change('API 地址', FINAL_URL);
  assert.ok(app.field('API Key').props.value === NEW_KEY, 'Repeated URL edits must preserve the key entered in this form.');
  await app.fetchModels();
  assert.equal(app.calls.list.length, 1);
  assert.equal(app.calls.list[0].baseUrl, FINAL_URL);
  assert.ok(app.calls.list[0].apiKey === NEW_KEY, 'Discovery must use the explicitly entered key.');
  assert.equal(app.calls.storedKeyReads.length, 0);
});

test('existing model with an empty key input never reads or sends its stored key after a URL change', async () => {
  const app = await harness(existingModel);
  assert.equal(app.field('API Key').props.value, '');
  await app.fetchModels();
  assert.equal(app.calls.storedKeyReads.length, 1, 'The original target can read its configured stored credential.');
  assert.equal(app.calls.list.length, 1);
  assert.equal(app.calls.list[0].baseUrl, existingModel.baseUrl);
  assert.ok(app.calls.list[0].apiKey === STORED_KEY, 'The original target uses the configured stored credential.');
  app.calls.list.length = 0;
  app.calls.storedKeyReads.length = 0;
  app.change('API 地址', NEW_URL);
  await app.fetchModels();
  assert.equal(app.calls.storedKeyReads.length, 0, 'Changing the target must not load the old secure-store credential.');
  assert.equal(app.calls.list.length, 0, 'Changing the target without an explicit key must not send a request.');
  assert.match(app.text(), /更换服务商或地址后，请重新填写 API Key/);
});

test('existing model uses the newly entered key rather than its stored key after editing the URL', async () => {
  const app = await harness(existingModel);
  app.change('API Key', NEW_KEY);
  app.change('API 地址', NEW_URL);
  assert.ok(app.field('API Key').props.value === NEW_KEY, 'Editing the URL must preserve the explicit replacement key.');
  await app.fetchModels();
  assert.equal(app.calls.list.length, 1);
  assert.equal(app.calls.list[0].baseUrl, NEW_URL);
  assert.ok(app.calls.list[0].apiKey === NEW_KEY, 'The changed target must receive only the explicit replacement key.');
  assert.ok(app.calls.list[0].apiKey !== STORED_KEY, 'The stored credential must never be reused for the changed target.');
  assert.equal(app.calls.storedKeyReads.length, 0);
});

test('embedded model completion returns a local draft without persisting or embedding credentials in the model', async () => {
  const completed = [];
  const app = await harness(undefined, { onComplete: (value) => completed.push(value) });
  app.change('API Key', NEW_KEY); app.change('API 地址', NEW_URL);
  await app.press('完成模型配置');
  assert.equal(app.calls.saves.length, 0);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].model.baseUrl, NEW_URL);
  assert.equal(completed[0].apiKey, NEW_KEY);
  assert.ok(!JSON.stringify(completed[0].model).includes(NEW_KEY));
  assert.doesNotMatch(app.text(), /设为默认模型|应用到模型|编辑模式与配置/);
});

test('embedded editor restores the parent credential draft and returns through the parent cancel handler', async () => {
  let cancelled = 0;
  const app = await harness(undefined, { initialApiKey: NEW_KEY, onComplete() {}, onCancel() { cancelled += 1; } });
  assert.equal(app.field('API Key').props.value, NEW_KEY);
  app.back();
  assert.equal(cancelled, 1);
  assert.equal(app.calls.saves.length, 0);
});
