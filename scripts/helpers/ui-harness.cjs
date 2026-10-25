/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function createUiHarness(file, exported, seams = {}, initialProps = {}) {
  const slots = [], effects = [], cache = new Map();
  let cursor = 0, dirty = true, props = initialProps, tree;
  const react = {
    memo: (component) => component,
    useMemo: (factory) => factory(),
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
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        slots[index] = { deps, cleanup: previous?.cleanup };
        effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = effect(); });
      }
    },
  };
  const element = (type, elementProps, key) => ({ type, props: elementProps || {}, key });
  const mocks = {
    react, 'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
    '@/components/app-icon': { AppIcon: 'Ionicons' },
    'react-native': { ...Object.fromEntries(['ActivityIndicator', 'Pressable', 'Switch', 'TextInput', 'View'].map((name) => [name, name])),
      Platform: { OS: 'android', select: (options) => options.android ?? options.default },
      useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
      StyleSheet: { create: (styles) => styles, hairlineWidth: 1 } },
    '@/components/customization-ui': { ...Object.fromEntries(['Card', 'Chip', 'DetailScreen', 'Field', 'IconButton', 'SectionHeading', 'Sheet', 'SmallAction'].map((name) => [name, name])),
      useConfirmation: () => ({ confirm: (request) => request.onConfirm(), dialog: null }) },
    '@/components/themed-text': { ThemedText: 'ThemedText' }, '@/hooks/use-theme': { useTheme: () => ({}) }, ...seams,
  };
  function load(absolute) {
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} }; cache.set(absolute, module);
    const output = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: absolute,
    }).outputText;
    const localRequire = (id) => {
      if (id in mocks) return mocks[id];
      const base = id.startsWith('@/') ? path.resolve(__dirname, '../../src', id.slice(2))
        : id.startsWith('.') ? path.resolve(path.dirname(absolute), id) : null;
      assert.ok(base, `Unexpected UI dependency: ${id}`);
      const alias = `@/${path.relative(path.resolve(__dirname, '../../src'), base).replaceAll('\\', '/')}`;
      if (alias in mocks) return mocks[alias];
      const target = ['.ts', '.tsx'].map((extension) => base + extension).find((candidate) => fs.existsSync(candidate));
      assert.ok(target, `Expected source dependency: ${id}`);
      return load(target);
    };
    vm.runInThisContext(`(function(require,module,exports,setTimeout,clearTimeout){${output}\n})`, { filename: absolute })(localRequire, module, module.exports, () => 0, () => {});
    return module.exports;
  }
  const component = load(path.resolve(__dirname, '../..', file))[exported];
  function render(nextProps = props) {
    props = nextProps; dirty = true;
    let attempts = 0;
    while (dirty) {
      assert.ok(attempts++ < 30, 'UI hooks must settle.');
      dirty = false; cursor = 0; tree = component(props);
      for (const effect of effects.splice(0)) effect();
    }
    return tree;
  }
  function nodes(predicate, node = tree, matches = []) {
    if (Array.isArray(node)) node.forEach((child) => nodes(predicate, child, matches));
    else if (node && typeof node === 'object') {
      if (predicate(node)) matches.push(node);
      if (node.type !== 'Sheet' || node.props.visible) {
        if (node.props?.children !== undefined) nodes(predicate, node.props.children, matches);
        if (node.type === 'DetailScreen') {
          if (node.props.right !== undefined) nodes(predicate, node.props.right, matches);
          if (node.props.footer !== undefined) nodes(predicate, node.props.footer, matches);
        }
      }
    }
    return matches;
  }
  function text(node = tree, expandFunctions = false) {
    if (Array.isArray(node)) return node.map((child) => text(child, expandFunctions)).join(' ');
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (node && expandFunctions && typeof node.type === 'function') return text(node.type(node.props), true);
    if (node?.type === 'DetailScreen') {
      return [node.props.right, node.props.children, node.props.footer].filter((child) => child !== undefined).map((child) => text(child, expandFunctions)).join(' ');
    }
    return node?.props?.children === undefined ? '' : text(node.props.children, expandFunctions);
  }
  function find(label) {
    const node = nodes((item) => item.props.accessibilityLabel === label || item.props.label === label || item.type === 'SectionHeading' && item.props.title === label)[0];
    assert.ok(node, `Expected UI control: ${label}`); return node;
  }
  render();
  return { render, nodes, text, find, load,
    change: (label, value) => { find(label).props.onChangeText(value); render(); },
    press: (label) => { const control = find(label); assert.ok(!control.props.disabled, `Control disabled: ${label}`); control.props.onPress(); render(); },
    settle: async () => { for (let i = 0; i < 8; i += 1) { await Promise.resolve(); render(); } },
    unmount: () => slots.forEach((slot) => slot?.cleanup?.()),
  };
}
module.exports = { createUiHarness };
