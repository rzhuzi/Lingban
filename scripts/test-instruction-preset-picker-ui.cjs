const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createUiHarness } = require('./helpers/ui-harness.cjs');

const emptyDraft = () => ({ text: '', templateId: null, parametersJson: '{}', placement: 'system-start' });
const model = (apiModel = 'Qwen/Qwen3-8B') => ({
  id: 'fixture', name: '我的模型', provider: 'custom', baseUrl: 'https://fixture.invalid/v1', apiModel,
  apiKeyAlias: null, isDefault: false, cotMode: 'off', cotPresetId: null, createdAt: 'now', updatedAt: 'now',
});

function environment(overrides = {}, openURL) {
  const calls = { selected: [], closed: 0, sources: [] };
  let props = { visible: true, disabled: false, model: model(), value: emptyDraft(),
    onClose: () => { calls.closed += 1; }, onSelect: (preset) => calls.selected.push(preset), ...overrides };
  const app = createUiHarness('src/features/companion/instruction-preset-picker.tsx', 'InstructionPresetPicker', {
    'react-native': { Pressable: 'Pressable', View: 'View', StyleSheet: { create: (styles) => styles, hairlineWidth: 1 },
      Linking: { openURL: (url) => { calls.sources.push(url); return openURL ? openURL(url) : Promise.resolve(); } } },
  }, props);
  const { INSTRUCTION_PRESETS } = app.load(require.resolve('../src/features/companion/instruction-presets.ts'));
  const update = (patch) => { props = { ...props, ...patch }; app.render(props); };
  const sheet = () => app.nodes((node) => node.type === 'Sheet')[0];
  const preset = (id) => {
    const result = INSTRUCTION_PRESETS.find((item) => item.id === id);
    assert.ok(result, `Expected catalog entry: ${id}`);
    return result;
  };
  const choose = (id) => {
    if (!app.nodes((node) => node.props.accessibilityRole === 'radio').length) app.press('重新选择指令预设');
    app.press('选择指令预设：' + preset(id).name);
  };
  return { app, calls, update, sheet, preset, choose, props };
}

test('choosing a preset shows its usage scope and source without modifying the role draft or filling it', () => {
  const value = { ...emptyDraft(), text: '我自己写的指令' }, before = structuredClone(value);
  const { app, calls, choose, preset, sheet } = environment({ value });
  assert.equal(app.nodes((node) => node.props.accessibilityRole === 'radio').length, 7);
  assert.equal(sheet().props.saveDisabled, true);
  choose('qwen3-think');
  assert.equal(app.nodes((node) => node.props.accessibilityRole === 'radio').length, 0, 'Selection leaves the list and shows only its details.');
  const selected = preset('qwen3-think');
  assert.match(app.text(), /适用模型：.*Qwen\/Qwen3-8B/);
  assert.match(app.text(), /怎么用：/);
  assert.ok(app.text().includes(selected.usage));
  assert.match(app.text(), /当前插入：.*本次用户消息之前/);
  assert.ok(app.text().includes(selected.caveat));
  assert.match(app.text(), /官方模型文档中的软指令/);
  assert.equal(app.find('查看预设来源：' + selected.sourceLabel).props.accessibilityRole, 'link');
  assert.deepEqual(calls.selected, []);
  assert.equal(calls.closed, 0);
  assert.deepEqual(value, before);
  app.press('查看预设内容');
  assert.ok(app.nodes((node) => node.type === 'ThemedText' && node.props.selectable && node.props.children === '/think').length);
  choose('llama3-assistant');
  assert.match(app.text(), /模型对话模板标记/);
  assert.equal(app.nodes((node) => node.props.selectable).length, 0, 'Changing selection collapses the previous preview.');
  assert.deepEqual(calls.selected, []);
  assert.deepEqual(value, before);
});

test('only explicit fill passes the current canonical catalog object even through an earlier save callback', () => {
  const { app, calls, choose, preset, sheet } = environment();
  const earlySave = sheet().props.onSave;
  earlySave();
  assert.deepEqual(calls.selected, []);
  choose('qwen3-think');
  choose('harmony-analysis');
  assert.deepEqual(calls.selected, []);
  assert.equal(sheet().props.saveLabel, '填入当前指令');
  earlySave();
  assert.equal(calls.selected.length, 1);
  assert.equal(calls.selected[0], preset('harmony-analysis'));
  assert.equal(calls.closed, 0, 'The parent decides when to close after accepting the draft.');
  app.press('重新选择指令预设');
  assert.equal(app.find('选择指令预设：' + preset('harmony-analysis').name).props.accessibilityState.checked, true);
  assert.equal(sheet().props.saveDisabled, true);
  earlySave();
  assert.equal(calls.selected.length, 1, 'Returning to the list invalidates old fill callbacks until an item is chosen.');
});

test('compatibility updates when the selected target changes from documented Qwen3-8B to another version', () => {
  const { app, calls, choose, update } = environment();
  choose('qwen3-think');
  assert.match(app.text(), /型号有文档说明，服务端待确认/);
  assert.match(app.text(), /enable_thinking=True/);
  update({ model: model('Qwen3.5-8B') });
  assert.match(app.text(), /当前型号待确认/);
  assert.match(app.text(), /不能外推到当前型号/);
  assert.doesNotMatch(app.text(), /型号有文档说明，服务端待确认/);
  update({ model: model('qwen3-8b') });
  assert.match(app.text(), /型号有文档说明，服务端待确认/);
  choose('harmony-analysis');
  assert.match(app.text(), /协议标记，当前接口未适配/);
  assert.doesNotMatch(app.text(), /型号有文档说明，服务端待确认/);
  assert.deepEqual(calls.selected, []);
});

test('replacing nonempty custom text is stated on the action and explains that placement also changes', () => {
  const { app, calls, choose, sheet } = environment({ value: { ...emptyDraft(), text: '我的原有指令' } });
  choose('persona-load');
  assert.equal(sheet().props.saveLabel, '替换当前指令');
  assert.match(app.text(), /将替换当前指令文本和插入位置/);
  assert.match(app.text(), /保存角色后生效/);
  assert.deepEqual(calls.selected, []);
  sheet().props.onSave();
  assert.equal(calls.selected[0].prompt, '【PERSONA_LOAD】');
  assert.equal(calls.selected[0].placement, 'system-start');
});

test('without a model the user can inspect presets but an old or direct save callback cannot fill one', () => {
  const { app, calls, choose, sheet } = environment({ model: undefined });
  const staleSave = sheet().props.onSave;
  choose('qwen3-think');
  assert.match(app.text(), /请先为角色选择模型/);
  assert.match(app.text(), /尚未选择模型/);
  assert.equal(sheet().props.saveDisabled, true);
  staleSave();
  sheet().props.onSave();
  assert.deepEqual(calls.selected, []);
});

test('disabled state prevents selection and saving including callbacks captured while previously enabled', () => {
  const value = { ...emptyDraft(), text: '/think', placement: 'user-prefix' };
  const { app, calls, preset, sheet, update } = environment({ value });
  const staleSave = sheet().props.onSave;
  app.press('重新选择指令预设');
  const staleChoose = app.find('选择指令预设：' + preset('persona-load').name).props.onPress;
  update({ disabled: true });
  assert.equal(sheet().props.saveDisabled, true);
  assert.ok(app.nodes((node) => node.props.accessibilityRole === 'radio').every((node) => node.props.disabled));
  staleChoose(); app.render(); staleSave();
  assert.equal(app.find('选择指令预设：' + preset('qwen3-think').name).props.accessibilityState.checked, true);
  assert.deepEqual(calls.selected, []);
  update({ disabled: false });
  app.press('选择指令预设：' + preset('qwen3-think').name);
  sheet().props.onSave();
  assert.equal(calls.selected.length, 1);
  assert.equal(calls.selected[0], preset('qwen3-think'));
});

test('closing the sheet blocks old selection and save callbacks until it is visible again', () => {
  const { app, calls, choose, preset, sheet, update } = environment();
  choose('qwen3-think');
  const staleSave = sheet().props.onSave;
  app.press('重新选择指令预设');
  const staleChoose = app.find('选择指令预设：' + preset('persona-load').name).props.onPress;
  update({ visible: false });
  staleChoose(); staleSave();
  assert.deepEqual(calls.selected, []);
  update({ visible: true });
  assert.equal(app.find('选择指令预设：' + preset('qwen3-think').name).props.accessibilityState.checked, true);
  app.press('选择指令预设：' + preset('qwen3-think').name);
  sheet().props.onSave();
  assert.equal(calls.selected[0], preset('qwen3-think'));
});

test('an unmounted picker never writes through its last save callback', () => {
  const { app, calls, choose, sheet } = environment();
  choose('qwen3-think');
  const staleSave = sheet().props.onSave;
  app.unmount();
  staleSave();
  assert.deepEqual(calls.selected, []);
});

test('source actions open the selected documented URL without filling a preset or using a real network request', async () => {
  const { app, calls, choose, preset } = environment();
  choose('llama3-assistant');
  const selected = preset('llama3-assistant');
  app.press('查看预设来源：' + selected.sourceLabel);
  await app.settle();
  assert.deepEqual(calls.sources, [selected.sourceUrl]);
  assert.deepEqual(calls.selected, []);
  assert.equal(app.nodes((node) => node.props.accessibilityRole === 'alert').length, 0);
});

test('source failures display a fixed retry message and a failure for the previous selection stays hidden', async () => {
  let rejectSource;
  const { app, choose, preset } = environment({}, () => new Promise((resolve, reject) => { rejectSource = reject; }));
  choose('llama3-assistant');
  app.press('查看预设来源：' + preset('llama3-assistant').sourceLabel);
  rejectSource(new Error('fixture-private-source-error'));
  await app.settle();
  assert.match(app.text(), /暂时无法打开来源，请稍后重试/);
  assert.doesNotMatch(app.text(), /fixture-private-source-error/);
  choose('harmony-analysis');
  assert.equal(app.nodes((node) => node.props.accessibilityRole === 'alert').length, 0);
  app.press('查看预设来源：' + preset('harmony-analysis').sourceLabel);
  choose('qwen3-think');
  rejectSource(new Error('fixture-delayed-source-error'));
  await app.settle();
  assert.equal(app.nodes((node) => node.props.accessibilityRole === 'alert').length, 0);
});
