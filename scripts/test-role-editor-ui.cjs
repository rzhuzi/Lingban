const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createUiHarness } = require('./helpers/ui-harness.cjs');
const clone = (value) => JSON.parse(JSON.stringify(value));
const draft = (text = '') => ({ text, templateId: null, parametersJson: '{}', placement: 'system-start' });
const thinking = () => ({ version: 1, official: { draft: draft(), applied: null }, instruction: { draft: draft(), applied: null }, persona: { draft: draft(), applied: null } });
const model = (id) => ({ id, name: id, provider: 'custom', baseUrl: 'https://fixture.invalid/v1', apiModel: id, apiKeyAlias: null,
  isDefault: id === 'A', cotMode: 'off', cotPresetId: null, thinkingConfig: thinking(), createdAt: 'now', updatedAt: 'now' });
const configuration = () => ({ version: 1, confirmed: true, currentModelId: 'A', models: {
  A: { mode: 'off', thinking: thinking() }, B: { mode: 'off', thinking: thinking() } }, variables: [],
  chatSettings: { contextWindow: 20, streamOutput: true } });
const role = () => ({ id: 'role-a', profile: { name: '甲', description: '自定义人设', traits: [], avatarUri: null, coverUri: null },
  memories: [], interests: [], isActive: true, configuration: configuration() });

function environment(persona = role(), options = {}) {
  const calls = { saves: [], routes: [], confirmations: [], starts: 0, prevent: null };
  const state = { personas: persona ? [clone(persona)] : [], activePersonaId: persona?.id ?? '', busy: false, ready: true };
  state.saveRole = async (...args) => {
    calls.saves.push(clone(args));
    if (options.wait) await options.wait;
    if (options.fail) throw new Error('fixture save failure');
    state.personas = [clone(args[0])];
  };
  const globalThinking = { mode: 'off', prompt: '', nativeParameters: '{}', selectedTemplateId: null, templates: [], variables: [
    { id: 'global', name: 'user_name', value: '你' } ] };
  const models = options.models ?? [model('A'), model('B')];
  const store = (object) => Object.assign((select) => select ? select(object) : object, { getState: () => object });
  const nativeUi = { Card: 'Card', Chip: 'Chip', DetailScreen: 'DetailScreen', Field: 'Field', SectionHeading: 'SectionHeading',
    Sheet: 'Sheet', SmallAction: 'SmallAction', useConfirmation: () => ({ confirm: (request) => calls.confirmations.push(request), dialog: null }) };
  const app = createUiHarness('src/features/companion/role-editor.tsx', 'RoleEditor', {
    'expo-image': { Image: 'Image' },
    'expo-router': { router: { canGoBack: () => true, back: () => calls.routes.push('back'),
      replace: (target) => calls.routes.push(target), push: (target) => calls.routes.push(target),
      dismissTo: (target) => calls.routes.push(['dismissTo', target]) },
      useLocalSearchParams: () => ({}), usePreventRemove: (flag, callback) => { calls.prevent = { flag, callback }; return () => { calls.prevent.flag = false; }; } },
    '@/components/customization-ui': nativeUi,
    '@/components/role-avatar': { RoleAvatar: 'RoleAvatar' },
    '@/features/models/model-editor': { ModelEditor: 'ModelEditor' },
    '@/features/companion/instruction-preset-picker': { InstructionPresetPicker: 'InstructionPresetPicker' },
    '@/features/companion/persona-manager': { PersonaManager: 'PersonaManager' },
    '@/features/companion/pick-image': { pickProfileImage: async () => 'fixture-image' },
    '@/lib/chat/engine': { startNewConversation: () => { calls.starts += 1; } },
    '@/lib/chat/runtime': { useChatRuntimeStore: store({ isSending: false, hasUnsaved: false }) },
    '@/stores/app-stores': { usePersonaStore: store(state), useCotStore: store({ thinking: globalThinking }),
      useModelStore: store({ models }), useAppMaintenanceStore: store({ active: false }),
      useSettingsStore: store({ settings: { userName: '你', theme: 'system', contextWindow: 20, streamOutput: true } }) },
  }, { persona: persona ? clone(persona) : undefined, isNew: !persona, focusThinking: false, addModel: false });
  if (persona && options.edit !== false) app.press('编辑角色配置');
  return { app, calls, state, models, globalThinking };
}

function instructionPicker(app) {
  const control = app.nodes((node) => node.type === 'InstructionPresetPicker')[0];
  assert.ok(control, 'Expected the third-party instruction preset picker.');
  return control;
}

function instructionPreset(app, id = 'qwen3-think') {
  const { INSTRUCTION_PRESETS } = app.load(require.resolve('../src/features/companion/instruction-presets.ts'));
  const preset = INSTRUCTION_PRESETS.find((item) => item.id === id);
  assert.ok(preset, `Expected built-in instruction preset: ${id}`);
  return preset;
}

test('existing role overview reads the actual profile model memories and interests without opening the full editor', () => {
  const persona = role();
  persona.profile = { ...persona.profile, name: '自定义角色名', description: '这是此角色自己的背景与说话方式', traits: ['耐心'] };
  persona.memories = [{ id: 'memory-a', text: '你周五准备去看展', icon: 'bookmark', createdAt: '2026-10-20T09:00:00.000Z', updatedAt: '2026-10-20T09:00:00.000Z' }];
  persona.interests = ['建筑摄影'];
  persona.configuration.currentModelId = 'B';
  const configuredModel = { ...model('B'), name: '角色专属接入', apiModel: 'role-specific-model' };
  const { app, calls } = environment(persona, { edit: false, models: [model('A'), configuredModel] });
  for (const value of ['自定义角色名', '这是此角色自己的背景与说话方式', '你周五准备去看展', '建筑摄影', '角色专属接入']) {
    assert.ok(app.text().includes(value), `Overview displays saved role content: ${value}`);
  }
  assert.equal(app.nodes((node) => node.type === 'Field' && node.props.label === '名字').length, 0);
  assert.equal(calls.saves.length, 0);
});

test('editing from the role overview preserves both model snapshots variables and chat settings on one save', async () => {
  const persona = role();
  persona.configuration.models.B.mode = 'instruction';
  persona.configuration.models.B.thinking.instruction = { draft: draft('B 的独立配置'), applied: draft('B 的独立配置') };
  persona.configuration.variables = [{ id: 'local-variable', name: 'greeting', value: '你好' }];
  persona.configuration.chatSettings = { contextWindow: 47, streamOutput: false };
  persona.memories = [{ id: 'memory-a', text: '保留已有记忆', icon: 'heart', createdAt: 'now', updatedAt: 'now' }];
  const original = clone(persona), { app, calls } = environment(persona, { edit: false });
  app.press('编辑角色配置');
  assert.equal(app.find('名字').props.value, persona.profile.name);
  app.change('名字', '修改后的角色名');
  assert.equal(calls.saves.length, 0);
  app.press('保存角色配置'); await app.settle();
  assert.equal(calls.saves.length, 1);
  const [saved, baseline] = calls.saves[0];
  assert.equal(saved.profile.name, '修改后的角色名');
  assert.deepEqual(saved.configuration, original.configuration);
  assert.deepEqual(saved.memories, original.memories);
  assert.deepEqual(baseline, original);
  assert.deepEqual(persona, original);
});

test('new role collects persona model and thought then saves once without publishing intermediate edits', async () => {
  const { app, calls } = environment(null);
  app.change('名字', '小夏'); app.change('人设', '自定义人物设定');
  app.press('第三方指令配置'); app.change('自定义指令', 'LANG_ZH_CN_ONLY');
  assert.equal(calls.saves.length, 0);
  assert.equal(app.nodes((node) => node.props.accessibilityLabel === '应用到此模型').length, 0);
  app.press('保存角色并聊天'); await app.settle();
  assert.equal(calls.saves.length, 1);
  const [saved, baseline] = calls.saves[0];
  assert.equal(baseline, null); assert.equal(saved.profile.name, '小夏');
  assert.equal(saved.configuration.confirmed, true); assert.equal(saved.configuration.currentModelId, 'A');
  assert.equal(saved.configuration.models.A.thinking.instruction.applied.text, 'LANG_ZH_CN_ONLY');
  assert.equal(calls.starts, 1);
});

test('one save applies changed model A even after switching to model B; original role stays untouched', async () => {
  const original = role(), { app, calls } = environment(original);
  app.press('第三方指令配置'); app.change('自定义指令', 'A的新指令');
  app.press('为这个角色选择模型'); app.press('使用模型：B');
  app.press('普通提示词'); app.change('额外回答要求', 'B的额外要求');
  app.press('保存角色配置'); await app.settle();
  const saved = calls.saves[0][0];
  assert.equal(saved.configuration.currentModelId, 'B');
  assert.equal(saved.configuration.models.A.mode, 'instruction');
  assert.equal(saved.configuration.models.A.thinking.instruction.applied.text, 'A的新指令');
  assert.equal(saved.configuration.models.B.thinking.persona.applied.text, 'B的额外要求');
  assert.equal(original.configuration.models.A.mode, 'off');
});

test('first confirmation uses old applied content while preserving old unapplied draft in model archive', async () => {
  const persona = role(); persona.configuration = { ...configuration(), confirmed: false, currentModelId: null, models: {} };
  const a = model('A'); a.cotMode = 'instruction'; a.thinkingConfig.instruction = { draft: draft('旧未应用草稿'), applied: draft('旧生效内容') };
  const { app, calls } = environment(persona, { models: [a] });
  assert.equal(app.find('自定义指令').props.value, '旧生效内容');
  app.press('保存角色配置'); await app.settle();
  assert.equal(calls.saves[0][0].configuration.models.A.thinking.instruction.applied.text, '旧生效内容');
  assert.equal(a.thinkingConfig.instruction.draft.text, '旧未应用草稿');
});

test('switching to existing model shows its applied snapshot rather than silently activating an old draft', async () => {
  const persona = role();
  persona.configuration.models.B.mode = 'instruction';
  persona.configuration.models.B.thinking.instruction = { draft: draft('B的未应用草稿'), applied: draft('B的生效内容') };
  const { app, calls } = environment(persona);
  app.press('为这个角色选择模型'); app.press('使用模型：B');
  assert.equal(app.find('自定义指令').props.value, 'B的生效内容');
  app.change('自定义指令', '本轮编辑');
  app.press('为这个角色选择模型'); app.press('使用模型：A');
  app.press('为这个角色选择模型'); app.press('使用模型：B');
  assert.equal(app.find('自定义指令').props.value, '本轮编辑');
  app.press('保存角色配置'); await app.settle();
  assert.equal(calls.saves[0][0].configuration.models.B.thinking.instruction.applied.text, '本轮编辑');
});

test('blocked old template requires review; disabled mode preserves warning so switching back cannot bypass it', async () => {
  const persona = role(); persona.configuration.models.A.mode = 'instruction';
  persona.configuration.models.A.thinking.instruction = { draft: draft('原文'), applied: draft('原文') };
  persona.configuration.models.A.blockedReason = '旧模板已停用';
  const { app, calls } = environment(persona);
  app.press('第三方指令配置'); app.press('保存角色配置'); await app.settle();
  assert.equal(calls.saves.length, 0); assert.match(app.text(), /旧模板已停用/);
  app.press('关闭'); app.press('保存角色配置'); await app.settle();
  assert.equal(calls.saves.length, 1); assert.equal(calls.saves[0][0].configuration.models.A.blockedReason, '旧模板已停用');
  app.press('第三方指令配置'); app.press('保存角色配置'); await app.settle();
  assert.equal(calls.saves.length, 1);
  app.press('已检查，使用这段内容'); app.press('保存角色配置'); await app.settle();
  assert.equal(calls.saves.length, 2);
});

test('new model credentials stay local and are handed to a single role save without entering role data', async () => {
  const { app, calls } = environment(null);
  app.change('名字', '新角色'); app.press('添加模型');
  const control = app.nodes((node) => node.type === 'ModelEditor')[0];
  control.props.onComplete({ model: model('pending'), apiKey: 'fixture-local-credential' }); app.render();
  assert.equal(calls.saves.length, 0);
  app.press('保存角色并聊天'); await app.settle();
  assert.equal(calls.saves.length, 1);
  assert.equal(calls.saves[0][2].apiKey, 'fixture-local-credential');
  assert.ok(!JSON.stringify(calls.saves[0][0]).includes('fixture-local-credential'));
});

test('discarding an edited temporary model permits saving the selected existing model and other edits', async () => {
  const { app, calls } = environment();
  app.press('第三方指令配置'); app.change('自定义指令', '保留 A 的修改');
  app.press('添加模型');
  app.nodes((node) => node.type === 'ModelEditor')[0].props.onComplete({ model: model('temporary'), apiKey: 'temporary-key' }); app.render();
  app.press('普通提示词'); app.change('额外回答要求', '放弃临时模型的修改');
  app.press('为这个角色选择模型'); app.press('使用模型：B');
  app.press('保存角色配置'); await app.settle();
  assert.equal(calls.saves.length, 1);
  const [saved, , pending] = calls.saves[0];
  assert.equal(saved.configuration.currentModelId, 'B');
  assert.equal(saved.configuration.models.temporary, undefined);
  assert.equal(saved.configuration.models.A.thinking.instruction.applied.text, '保留 A 的修改');
  assert.equal(pending, null);
  assert.ok(!app.text().includes('编辑的模型已不存在'));
});

test('replacing an edited temporary model does not leave the discarded model blocking the role save', async () => {
  const { app, calls } = environment();
  app.press('添加模型');
  app.nodes((node) => node.type === 'ModelEditor')[0].props.onComplete({ model: model('temporary-old'), apiKey: 'old-local-key' }); app.render();
  app.press('第三方指令配置'); app.change('自定义指令', '放弃的指令');
  app.press('编辑待添加的模型');
  app.nodes((node) => node.type === 'ModelEditor')[0].props.onComplete({ model: model('temporary-new'), apiKey: 'new-local-key' }); app.render();
  app.press('普通提示词'); app.change('额外回答要求', '新模型的独立提示词');
  app.press('保存角色配置'); await app.settle();
  assert.equal(calls.saves.length, 1);
  const [saved, , pending] = calls.saves[0];
  assert.equal(saved.configuration.currentModelId, 'temporary-new');
  assert.equal(saved.configuration.models['temporary-old'], undefined);
  assert.equal(saved.configuration.models['temporary-new'].thinking.persona.applied.text, '新模型的独立提示词');
  assert.equal(pending.model.id, 'temporary-new');
  assert.equal(pending.apiKey, 'new-local-key');
});

test('an edited saved model deleted elsewhere still blocks saving after selecting another model', async () => {
  const { app, calls, models } = environment();
  app.press('第三方指令配置'); app.change('自定义指令', '不能静默丢弃的已保存模型修改');
  app.press('为这个角色选择模型'); app.press('使用模型：B');
  models.splice(models.findIndex((item) => item.id === 'A'), 1); app.render();
  app.press('保存角色配置'); await app.settle();
  assert.equal(calls.saves.length, 0);
  assert.match(app.text(), /编辑的模型已不存在/);
});

test('navigation remains blocked during the asynchronous save instead of discarding the in-flight edit', async () => {
  let resolve; const wait = new Promise((done) => { resolve = done; });
  const { app, calls } = environment(role(), { wait });
  app.change('名字', '新名字'); app.press('保存角色配置');
  assert.equal(calls.prevent.flag, true);
  calls.prevent.callback({ repeat: () => assert.fail('must not leave during save') });
  assert.equal(calls.confirmations.length, 0);
  resolve(); await app.settle(); assert.equal(calls.prevent.flag, false);
});

test('role variable renaming rewrites both model texts without editing other roles or escaped tokens', async () => {
  const persona = role();
  persona.configuration.variables = [{ id: 'var', name: 'word', value: '甲' }];
  for (const value of Object.values(persona.configuration.models)) {
    value.mode = 'instruction'; value.thinking.instruction = { draft: draft('{word} \\{word} {{word}}'), applied: draft('{word} \\{word} {{word}}') };
  }
  const { app, calls } = environment(persona);
  app.press('角色高级设置'); app.press('编辑变量 word'); app.change('名称', 'renamed');
  app.nodes((node) => node.type === 'Sheet' && node.props.visible && node.props.title === '角色变量')[0].props.onSave(); app.render();
  app.press('保存角色配置'); await app.settle();
  const saved = calls.saves[0][0];
  for (const value of Object.values(saved.configuration.models)) assert.equal(value.thinking.instruction.applied.text, '{renamed} \\{word} {{word}}');
  assert.equal(persona.configuration.variables[0].name, 'word');
});

test('discarding a local role edit leaves the saved role unchanged and never publishes a partial save', () => {
  const original = role(), { app, calls, state } = environment(original);
  app.change('名字', '尚未保存'); app.press('第三方指令配置'); app.change('自定义指令', '未保存指令');
  let repeated = 0;
  calls.prevent.callback({ repeat: () => { repeated += 1; } });
  assert.equal(repeated, 0); assert.equal(calls.confirmations.length, 1);
  assert.equal(calls.saves.length, 0); assert.equal(state.personas[0].profile.name, '甲');
  calls.confirmations[0].onConfirm(); app.render();
  assert.equal(repeated, 1); assert.equal(calls.prevent.flag, false);
  assert.deepEqual(state.personas[0], original);
});

test('using a template copies text without creating a shared binding or changing saved role before the final save', async () => {
  const { app, calls, globalThinking } = environment();
  globalThinking.templates.push({ id: 'fixture-template', name: '自定义模板', kind: 'instruction', prompt: '模板中的内容', description: '', icon: 'sparkles' });
  app.render(); app.press('第三方指令配置'); app.press('使用模板'); app.press('复制模板：自定义模板');
  assert.equal(app.find('自定义指令').props.value, '模板中的内容'); assert.equal(calls.saves.length, 0);
  globalThinking.templates[0].prompt = '模板原件已修改'; app.render();
  assert.equal(app.find('自定义指令').props.value, '模板中的内容');
  app.press('保存角色配置'); await app.settle();
  const applied = calls.saves[0][0].configuration.models.A.thinking.instruction.applied;
  assert.equal(applied.text, '模板中的内容'); assert.equal(applied.templateId, null);
});

test('an invalid edited model prevents the whole role save even after the user switches to another valid model', async () => {
  const { app, calls } = environment();
  app.press('官方 API 配置'); app.change('思考前缀', '本次编辑的前缀');
  app.press('为这个角色选择模型'); app.press('使用模型：B'); app.press('保存角色配置'); await app.settle();
  assert.equal(calls.saves.length, 0);
  assert.match(app.text(), /A：当前端点或型号的官方思考前缀尚未接入/);
});

test('return to conversation targets chat while retaining the dirty-role navigation guard', () => {
  const { app, calls } = environment(role(), { edit: false });
  app.press('回到对话');
  assert.deepEqual(calls.routes, [['dismissTo', '/(tabs)']]);
  app.press('编辑角色配置');
  app.change('名字', '尚未保存的名字');
  app.nodes((node) => node.type === 'DetailScreen')[0].props.onBack(); app.render();
  assert.equal(calls.prevent.flag, true);
  app.press('回到对话');
  assert.equal(calls.prevent.flag, true, 'Returning to chat must not bypass the unsaved role guard.');
  assert.deepEqual(calls.routes[1], ['dismissTo', '/(tabs)']);
  assert.equal(calls.saves.length, 0);
});

test('built-in instruction preset selection is available only in the third-party instruction mode', () => {
  const { app } = environment();
  const entries = () => app.nodes((node) => node.props.accessibilityLabel === '选择第三方指令预设');
  assert.equal(entries().length, 0);
  app.press('官方 API 配置'); assert.equal(entries().length, 0);
  app.press('普通提示词'); assert.equal(entries().length, 0);
  app.press('第三方指令配置'); assert.equal(entries().length, 1);
  app.press('选择第三方指令预设');
  assert.equal(instructionPicker(app).props.visible, true);
  app.press('关闭'); assert.equal(entries().length, 0);
});

test('a chosen instruction preset stays editable and saves only to the current role and model while preserving other modes and parameters', async () => {
  const persona = role();
  persona.configuration.models.A.mode = 'instruction';
  persona.configuration.models.A.thinking.instruction = {
    draft: { ...draft('A 原来的指令'), parametersJson: '{"seed":7}' },
    applied: { ...draft('A 原来的指令'), parametersJson: '{"seed":7}' },
  };
  persona.configuration.models.A.thinking.official = { draft: { ...draft('官方思考前缀'), parametersJson: '{"reasoning_effort":"max"}' }, applied: null };
  persona.configuration.models.A.thinking.persona = { draft: draft('普通提示词保留'), applied: draft('普通提示词保留') };
  persona.configuration.models.B.mode = 'instruction';
  persona.configuration.models.B.thinking.instruction = { draft: draft('B 的独立指令'), applied: draft('B 的独立指令') };
  const original = clone(persona);
  const a = { ...model('A'), apiModel: 'Qwen/Qwen3-8B' };
  const { app, calls, state, models, globalThinking } = environment(persona, { models: [a, model('B')] });
  const other = { ...role(), id: 'role-b', profile: { ...role().profile, name: '乙' } };
  state.personas.push(clone(other));
  const beforeModels = clone(models), beforeGlobal = clone(globalThinking);
  const preset = instructionPreset(app);
  app.press('选择第三方指令预设');
  instructionPicker(app).props.onSelect(preset); app.render();
  assert.equal(app.find('自定义指令').props.value, preset.prompt);
  assert.equal(app.nodes((node) => node.type === 'InstructionPresetPicker').length, 0);
  assert.equal(calls.saves.length, 0);
  assert.deepEqual(state.personas, [original, other]);
  assert.deepEqual(models, beforeModels);
  assert.deepEqual(globalThinking, beforeGlobal);
  const customized = preset.prompt + '\n这是角色自己补充的要求';
  app.change('自定义指令', customized);
  assert.equal(calls.saves.length, 0);
  app.press('保存角色配置'); await app.settle();
  assert.equal(calls.saves.length, 1);
  const [saved, baseline] = calls.saves[0];
  assert.equal(saved.id, original.id);
  assert.deepEqual(baseline, original);
  assert.equal(saved.configuration.models.A.mode, 'instruction');
  assert.deepEqual(saved.configuration.models.A.thinking.instruction.applied, {
    text: customized, templateId: null, parametersJson: '{"seed":7}', placement: preset.placement,
  });
  assert.deepEqual(saved.configuration.models.A.thinking.instruction.draft, saved.configuration.models.A.thinking.instruction.applied);
  assert.deepEqual(saved.configuration.models.A.thinking.official, original.configuration.models.A.thinking.official);
  assert.deepEqual(saved.configuration.models.A.thinking.persona, original.configuration.models.A.thinking.persona);
  assert.deepEqual(saved.configuration.models.B, original.configuration.models.B);
  assert.deepEqual(persona, original);
  assert.deepEqual(models, beforeModels);
});

test('closing the instruction picker invalidates its previous selection callback even before another render', () => {
  const { app, calls } = environment();
  app.press('第三方指令配置'); app.change('自定义指令', '保留这个草稿');
  app.press('选择第三方指令预设');
  const control = instructionPicker(app), preset = instructionPreset(app);
  control.props.onClose();
  control.props.onSelect(preset); app.render();
  assert.equal(app.find('自定义指令').props.value, '保留这个草稿');
  assert.equal(app.nodes((node) => node.type === 'InstructionPresetPicker').length, 0);
  assert.equal(calls.saves.length, 0);
  app.press('选择第三方指令预设');
  control.props.onSelect(preset); app.render();
  assert.equal(app.find('自定义指令').props.value, '保留这个草稿', 'Reopening must not revive the previous picker session.');
  assert.equal(instructionPicker(app).props.visible, true);
});

test('a stale instruction preset callback cannot change a role after its store becomes busy or the editor unmounts', () => {
  const { app, calls, state } = environment();
  app.press('第三方指令配置'); app.change('自定义指令', '忙碌之前的草稿');
  app.press('选择第三方指令预设');
  const control = instructionPicker(app), preset = instructionPreset(app);
  state.busy = true;
  control.props.onSelect(preset); app.render();
  assert.equal(app.find('自定义指令').props.value, '忙碌之前的草稿');
  assert.equal(app.find('选择第三方指令预设').props.disabled, true);
  assert.equal(app.nodes((node) => node.type === 'InstructionPresetPicker').length, 0);
  state.busy = false; app.render();
  app.press('选择第三方指令预设');
  const lastControl = instructionPicker(app);
  app.unmount();
  lastControl.props.onSelect(preset); app.render();
  assert.equal(app.find('自定义指令').props.value, '忙碌之前的草稿');
  assert.equal(calls.saves.length, 0);
});

test('a stale instruction preset callback cannot replace official content after the role changes thought modes', async () => {
  const persona = role();
  persona.configuration.models.A.thinking.official.draft = { ...draft('原生思考前缀'), parametersJson: '{"reasoning_effort":"low"}' };
  const { app, calls } = environment(persona);
  app.press('第三方指令配置'); app.change('自定义指令', '自己的第三方指令');
  app.press('选择第三方指令预设');
  const control = instructionPicker(app), preset = instructionPreset(app);
  app.press('官方 API 配置');
  control.props.onSelect(preset); app.render();
  assert.equal(app.find('思考前缀').props.value, '原生思考前缀');
  app.press('第三方指令配置');
  assert.equal(app.find('自定义指令').props.value, '自己的第三方指令');
  app.press('保存角色配置'); await app.settle();
  assert.equal(calls.saves.length, 1);
  assert.deepEqual(calls.saves[0][0].configuration.models.A.thinking.official, persona.configuration.models.A.thinking.official);
});

test('a stale instruction preset callback cannot leak into another model selected by the same role', async () => {
  const persona = role();
  for (const [id, binding] of Object.entries(persona.configuration.models)) {
    binding.mode = 'instruction'; binding.thinking.instruction = { draft: draft(id + ' 自己的指令'), applied: draft(id + ' 自己的指令') };
  }
  const { app, calls } = environment(persona);
  app.press('选择第三方指令预设');
  const control = instructionPicker(app), preset = instructionPreset(app);
  app.press('为这个角色选择模型'); app.press('使用模型：B');
  control.props.onSelect(preset); app.render();
  assert.equal(app.find('自定义指令').props.value, 'B 自己的指令');
  app.press('保存角色配置'); await app.settle();
  assert.equal(calls.saves.length, 1);
  const saved = calls.saves[0][0];
  assert.deepEqual(saved.configuration.models.A, persona.configuration.models.A);
  assert.deepEqual(saved.configuration.models.B, persona.configuration.models.B);
});

test('instruction picker selection uses the built-in catalog text and ignores unknown preset identities', () => {
  const { app } = environment();
  app.press('第三方指令配置'); app.change('自定义指令', '原草稿');
  app.press('选择第三方指令预设');
  const preset = instructionPreset(app);
  instructionPicker(app).props.onSelect({ ...preset, id: 'unknown-preset' }); app.render();
  assert.equal(app.find('自定义指令').props.value, '原草稿');
  instructionPicker(app).props.onSelect({ ...preset, prompt: '目录之外的替换内容', placement: 'system-start' }); app.render();
  assert.equal(app.find('自定义指令').props.value, preset.prompt);
});
