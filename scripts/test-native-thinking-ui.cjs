const assert = require('node:assert/strict');
const test = require('node:test');
const { createUiHarness } = require('./helpers/ui-harness.cjs');

const deepseek = { id: 'official-fixture', name: '目标模型', provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1', apiModel: 'deepseek-flash', cotMode: 'off' };
function harness(options = {}) {
  const changes = [];
  const props = { model: options.model === null ? undefined : options.model ?? deepseek,
    prefix: options.prefix ?? '先理解问题，再给出回应。', parameters: options.parameters ?? '{}',
    active: options.active ?? false, disabled: options.disabled ?? false,
    onChange(value) { changes.push(value); props.parameters = value; } };
  const app = createUiHarness('src/features/companion/native-thinking-card.tsx', 'NativeThinkingCard', {}, props);
  const preview = (label) => {
    const node = app.nodes((item) => item.props.accessibilityLabel === label)[0];
    return node ? JSON.parse(app.text(node)) : null;
  };
  return { ...app, props, changes,
    parameters: () => preview('官方接口参数预览'), assistant: () => preview('官方末消息预览') };
}

test('official card starts with no JSON field and previews the real special assistant and merged parameters', () => {
  const app = harness();
  assert.equal(app.nodes((node) => node.type === 'Field').length, 0);
  assert.match(app.text(), /文档已接入.*实际效果待联调/);
  assert.match(app.text(), /此模型当前未启用官方模式/);
  assert.deepEqual(app.parameters(), { thinking: { type: 'enabled' } });
  assert.deepEqual(app.assistant(), { role: 'assistant', content: '', prefix: true, reasoning_content: '先理解问题，再给出回应。' });
  const endpoint = app.nodes((node) => node.props.selectable && Array.isArray(node.props.children) && node.props.children[0] === 'https://api.deepseek.com/beta')[0];
  assert.ok(endpoint, 'Preview must render the official beta endpoint.');
  assert.equal(endpoint.props.children.join(''), 'https://api.deepseek.com/beta/chat/completions');
  assert.deepEqual(app.changes, []);
});

test('advanced interface parameters represent automatic defaults as a blank field instead of braces', () => {
  for (const parameters of ['{}', ' \n{ }\t']) {
    const app = harness({ parameters });
    app.press('高级接口参数');
    assert.equal(app.find('官方参数 JSON').props.value, '');
    assert.match(app.text(), /仅保存此目标模型的官方参数草稿/);
    assert.deepEqual(app.changes, []);
  }
});

test('valid parameter overrides save only to the parent draft and preview the actual official adapter result', () => {
  const app = harness({ active: true });
  app.press('高级接口参数');
  const override = ' {"reasoning_effort":"high"} ';
  app.change('官方参数 JSON', override);
  assert.deepEqual(app.changes, [override]);
  assert.deepEqual(app.parameters(), { reasoning_effort: 'high', thinking: { type: 'enabled' } });
  assert.match(app.text(), /已启用官方模式.*正在编辑的草稿/);
  app.press('高级接口参数');
  assert.equal(app.nodes((node) => node.type === 'Field').length, 0);
  assert.deepEqual(app.parameters(), { reasoning_effort: 'high', thinking: { type: 'enabled' } });
});

test('malformed JSON is held locally and never replaces valid saved parameters or the effective preview', () => {
  const app = harness({ parameters: '{"reasoning_effort":"high"}' });
  app.press('高级接口参数');
  const parameters = app.parameters(), assistant = app.assistant();
  for (const value of ['{ unfinished', '[]', 'null', 'false']) {
    app.change('官方参数 JSON', value);
    assert.equal(app.find('官方参数 JSON').props.value, value);
    assert.deepEqual(app.changes, []);
    assert.deepEqual(app.parameters(), parameters);
    assert.deepEqual(app.assistant(), assistant);
    assert.match(app.text(), /草稿未保存.*已应用配置保持不变/);
  }
});

test('empty input and reset both persist canonical empty parameter overrides without claiming to Apply', () => {
  const app = harness({ parameters: '{"reasoning_effort":"high"}' });
  app.press('高级接口参数'); app.change('官方参数 JSON', ' \n ');
  assert.deepEqual(app.changes, ['{}']); assert.equal(app.find('官方参数 JSON').props.value, '');
  app.change('官方参数 JSON', '{ unfinished'); app.press('清除参数覆盖');
  assert.deepEqual(app.changes, ['{}', '{}']);
  assert.deepEqual(app.parameters(), { thinking: { type: 'enabled' } });
  assert.match(app.text(), /明确应用后才替换已应用配置/);
});

test('empty prefix and an absent target do not display an enabled special assistant', () => {
  const app = harness({ prefix: '   ' });
  assert.equal(app.assistant(), null);
  assert.match(app.text(), /填写思考前缀/);
  assert.deepEqual(app.parameters(), { thinking: { type: 'enabled' } });
  const noModel = harness({ model: null });
  assert.equal(noModel.assistant(), null); assert.equal(noModel.parameters(), null);
  assert.match(noModel.text(), /请先选择目标模型/);
});

test('custom and unadapted official targets never claim that the official protocol is connected', () => {
  for (const model of [{ ...deepseek, provider: 'custom' }, { ...deepseek, apiModel: 'unknown-model' },
    { ...deepseek, baseUrl: 'https://proxy.invalid/v1' }]) {
    const app = harness({ model });
    assert.equal(app.assistant(), null); assert.equal(app.parameters(), null);
    assert.doesNotMatch(app.text(), /文档已接入/);
    assert.match(app.text(), /未接入|不可用|不支持/);
  }
});

test('JSON that disables thinking cannot masquerade as a valid official thinking-prefix preview', () => {
  for (const parameters of ['{"reasoning_effort":"none"}', '{"thinking":{"type":"disabled"}}', '{"messages":[]}']) {
    const app = harness({ parameters });
    assert.equal(app.assistant(), null); assert.equal(app.parameters(), null);
    assert.match(app.text(), /配置不可用/);
  }
});

test('strength controls write per-target parameter drafts and restore defaults explicitly', () => {
  const app = harness();
  app.press('high');
  assert.deepEqual(app.parameters(), { reasoning_effort: 'high', thinking: { type: 'enabled' } });
  app.press('默认');
  assert.equal(app.props.parameters, '{}');
  assert.deepEqual(app.parameters(), { thinking: { type: 'enabled' } });
});

test('maintenance disables native parameter input and strength writes', () => {
  const app = harness({ disabled: true });
  app.press('高级接口参数');
  assert.equal(app.find('官方参数 JSON').props.editable, false);
  assert.equal(app.find('high').props.onPress, undefined);
  app.find('官方参数 JSON').props.onChangeText('{"reasoning_effort":"high"}'); app.render();
  assert.deepEqual(app.changes, []);
});
