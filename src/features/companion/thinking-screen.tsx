import { AppIcon as Ionicons } from '@/components/app-icon';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, useWindowDimensions, View, type TextInputInstance } from 'react-native';

import { Card, Chip, DetailScreen, Field, IconButton, SectionHeading, Sheet, SmallAction, useConfirmation } from '@/components/customization-ui';
import { ThemedText } from '@/components/themed-text';
import { Fonts } from '@/constants/theme';
import { Typography } from '@/constants/typography';
import { useTheme } from '@/hooks/use-theme';
import { buildRequestMessages } from '@/lib/cot/inject';
import { renderTemplate, templateValues } from '@/lib/cot/template';
import { useAppMaintenanceStore, useCotStore, useModelStore } from '@/stores/app-stores';
import { useThinkingEditorStore } from '@/stores/thinking-editor-store';

import { useCompanion } from './companion-store';
import { createId, DEFAULT_PROMPT } from './defaults';
import { NativeThinkingCard } from './native-thinking-card';
import { renderPrompt } from './prompt-utils';
import { createThinkingDraft, getModelThinkingConfig, reconcileThinkingTemplates, templateMatchesMode, THINKING_CONTENT_MODES, THINKING_MODE_LABELS } from './thinking-config';
import type { ModelThinkingConfig, PromptTemplate, PromptVariable, TemplateIcon, ThinkingDraft, ThinkingMode } from './types';

const PROMPT_LIMIT = 4000;
const modes: ThinkingMode[] = ['off', 'official', 'instruction', 'persona'];
const templateIcons: TemplateIcon[] = ['heart', 'analytics', 'sunny', 'sparkles'];
const modeHints: Record<ThinkingMode, string> = {
  off: '关闭额外配置，人设、记忆和聊天历史仍会发送。',
  official: '通过已接入的官方协议传入思考前缀。文档支持与真实模型效果分别验证。',
  instruction: '按所选位置拼接自定义文本，标记本身不会执行应用命令。',
  persona: '将自然语言要求追加到会话所属人设的系统提示词。',
};
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
function renameToken(text: string, oldName: string, newName: string) {
  return text.replace(/\\\{([^{}]+)\}|\{\{([^{}]+)\}\}|\{([^{}]+)\}/g,
    (token, escaped: string | undefined, doubled: string | undefined, name: string | undefined) => (
      escaped === undefined && doubled === undefined && name === oldName ? `{${newName}}` : token
    ));
}

export function ThinkingScreen() {
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const modeHeight = Math.ceil(52 * Math.max(1, fontScale));
  const params = useLocalSearchParams<{ id?: string; editorId?: string }>();
  const editorId = first(params.editorId);
  const { data, updateThinking } = useCompanion();
  const config = data.thinking;
  const { confirm, dialog } = useConfirmation();
  const models = useModelStore((state) => state.models);
  const maintenance = useAppMaintenanceStore((state) => state.active);
  const editorSession = useThinkingEditorStore((state) => editorId ? state.sessions[editorId] : undefined);
  const [targetId, setTargetId] = useState(first(params.id) ?? '');
  const target = editorId ? editorSession?.model : models.find((model) => model.id === targetId);
  const [mode, setMode] = useState<ThinkingMode>(() => target?.cotMode ?? config.mode);
  const [overlays, setOverlays] = useState<Record<string, ModelThinkingConfig>>({});
  const [jsonDrafts, setJsonDrafts] = useState<Record<string, string | null>>({});
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [targetPicker, setTargetPicker] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [managingTemplates, setManagingTemplates] = useState(false);
  const [variableManagerOpen, setVariableManagerOpen] = useState(false);
  const [variableDraft, setVariableDraft] = useState<PromptVariable | null>(null);
  const [variableError, setVariableError] = useState<string | null>(null);
  const [templateDraft, setTemplateDraft] = useState<PromptTemplate | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const renaming = useRef(false);
  const promptInput = useRef<TextInputInstance>(null);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const editorUnavailable = !!editorId && !editorSession;
  const targetMissing = !editorId && !!targetId && !target;
  const locked = maintenance || renameBusy || editorUnavailable || targetMissing;

  const workspaceId = editorId ? `editor:${editorId}` : target?.id ?? 'public';
  const stored = target ? getModelThinkingConfig(target) : null;
  const modelConfig = stored ? reconcileThinkingTemplates({ ...stored,
    ...Object.fromEntries(THINKING_CONTENT_MODES.map((item) => [item, { ...stored[item],
      draft: overlays[workspaceId]?.[item].draft ?? stored[item].draft }])) }, config.templates) : null;
  const contentMode = mode === 'off' ? null : mode;
  const draft = contentMode ? modelConfig?.[contentMode].draft ?? config.drafts?.[contentMode] ?? createThinkingDraft() : createThinkingDraft();
  const selectedTemplate = draft.templateId ? config.templates.find((template) => template.id === draft.templateId) : undefined;
  const source = selectedTemplate?.prompt ?? draft.text;
  const rendered = renderTemplate(source, templateValues(data));
  const rawJson = jsonDrafts[workspaceId] ?? null;
  const templates = contentMode ? config.templates.filter((template) => templateMatchesMode(template, contentMode)) : [];
  const applied = target && target.cotMode !== 'off' ? modelConfig?.[target.cotMode].applied : null;
  const variableNames = ['persona', ...config.variables.filter((item) => item.name === 'user_name').map((item) => item.name),
    'date', ...config.variables.filter((item) => item.name !== 'user_name').map((item) => item.name)];
  const bindingCount = (id: string) => models.filter((model) => THINKING_CONTENT_MODES.some((item) => getModelThinkingConfig(model)[item].applied?.templateId === id)).length;

  let requestPreview: ReturnType<typeof buildRequestMessages> | null = null;
  let previewError: string | null = null;
  if (target && contentMode && modelConfig) {
    try {
      const candidate = { ...modelConfig, [contentMode]: { ...modelConfig[contentMode], applied: { ...draft } } };
      requestPreview = buildRequestMessages({ ...target, cotMode: contentMode, thinkingConfig: candidate }, data,
        [{ role: 'user', content: '（本次提问）' }]);
    } catch (failure) { previewError = failure instanceof Error ? failure.message : '配置无法使用，请检查后重试。'; }
  }

  async function persist(next: ModelThinkingConfig, activeMode?: ThinkingMode) {
    if (locked) { setError(editorUnavailable ? '模型编辑会话已结束。' : targetMissing ? '目标模型已删除，请重新选择。' : '正在处理本地数据，请稍后重试。'); throw new Error('当前无法保存配置草稿。'); }
    if (!target) return;
    const id = target.id;
    if (editorId) {
      const session = useThinkingEditorStore.getState().sessions[editorId];
      if (!session) throw new Error('模型编辑会话已结束，请返回模型页面重新打开。');
      const latest = reconcileThinkingTemplates(getModelThinkingConfig(session.model), config.templates);
      const merged = { ...latest };
      if (contentMode) merged[contentMode] = { ...latest[contentMode], draft: { ...next[contentMode].draft },
        applied: activeMode === contentMode ? next[contentMode].applied : latest[contentMode].applied };
      useThinkingEditorStore.getState().update(editorId, { thinkingConfig: merged, ...(activeMode ? { cotMode: activeMode } : {}) });
      return;
    }
    setPending((value) => value + 1);
    try { await useModelStore.getState().saveThinkingConfiguration(id, next, activeMode, contentMode ?? undefined); }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : '草稿保存失败，请重试。'); throw failure; }
    finally { if (mounted.current) setPending((value) => value - 1); }
  }

  function changeDraft(patch: Partial<ThinkingDraft>) {
    if (!contentMode || locked) return;
    setError(null); setNotice(null);
    const nextDraft = { ...draft, ...patch };
    if (!target || !modelConfig) {
      updateThinking({ drafts: { official: config.drafts?.official ?? createThinkingDraft(),
        instruction: config.drafts?.instruction ?? createThinkingDraft(), persona: config.drafts?.persona ?? createThinkingDraft(), [contentMode]: nextDraft } });
      return;
    }
    const next = { ...modelConfig, [contentMode]: { ...modelConfig[contentMode], draft: nextDraft } };
    setOverlays((current) => ({ ...current, [workspaceId]: next }));
    void persist(next).catch(() => {});
  }

  function changePrompt(text: string) {
    changeDraft({ text, templateId: selectedTemplate?.prompt === text ? selectedTemplate.id : null });
  }

  async function apply() {
    if (!target || !modelConfig || pending || locked) return;
    setError(null); setNotice(null);
    if (mode !== 'off' && (previewError || (mode === 'official' && rawJson !== null))) {
      setError(previewError ?? '请先修正未完成的接口参数草稿。'); return;
    }
    const next = mode === 'off' ? modelConfig : { ...modelConfig, [mode]: { ...modelConfig[mode], applied: { ...draft } } };
    try {
      await persist(next, mode);
      if (mounted.current) setNotice(editorId ? '已应用到模型表单，保存模型后生效。' : '已应用，之后的请求使用此配置。');
    } catch { /* Preserve the draft and show the persistence error. */ }
  }

  function insertVariable(name: string) {
    const token = `{${name}}`;
    const start = Math.min(selection.start, source.length), end = Math.min(selection.end, source.length);
    const next = source.slice(0, start) + token + source.slice(end);
    if (next.length > PROMPT_LIMIT) { setError(`最多可输入 ${PROMPT_LIMIT} 个字符。`); return; }
    changePrompt(next); setSelection({ start: start + token.length, end: start + token.length }); promptInput.current?.focus();
  }

  async function saveVariable() {
    if (!variableDraft || locked || renaming.current) return;
    const name = variableDraft.name.trim();
    if (!name || /[{}\s]/u.test(name)) { setVariableError('变量名不能为空，也不能包含空格或大括号。'); return; }
    if (name === 'persona' || name === 'date') { setVariableError('persona 和 date 由人设与当前日期提供。'); return; }
    if (config.variables.some((item) => item.id !== variableDraft.id && item.name === name)) { setVariableError('这个变量名已存在。'); return; }
    const previous = config.variables.find((item) => item.id === variableDraft.id);
    const next = { ...variableDraft, name };
    const variables = previous ? config.variables.map((item) => item.id === next.id ? next : item) : [...config.variables, next];
    if (previous && previous.name !== name) {
      if (config.templates.some((template) => renameToken(template.prompt, previous.name, name).length > PROMPT_LIMIT)) {
        setVariableError('新变量名会使模板超过字符上限，请使用更短的名称。'); return;
      }
      renaming.current = true; setRenameBusy(true);
      try { await useCotStore.getState().renameThinkingVariable(previous.name, name, variables); setOverlays({}); }
      catch (failure) { setVariableError(failure instanceof Error ? failure.message : '重命名失败，请重试。'); return; }
      finally { renaming.current = false; if (mounted.current) setRenameBusy(false); }
    } else updateThinking({ variables });
    setVariableDraft(null); setVariableError(null);
  }

  function deleteVariable(variable: PromptVariable) {
    if (locked) return;
    confirm({ title: `删除 {${variable.name}}？`, message: '已有提示词中的占位符会保留。', confirmLabel: '删除', destructive: true,
      onConfirm: () => updateThinking({ variables: config.variables.filter((item) => item.id !== variable.id) }) });
  }

  function saveTemplate() {
    if (!templateDraft || locked) return;
    const next = { ...templateDraft, name: templateDraft.name.trim(), description: templateDraft.description.trim() };
    if (!next.name || !next.prompt.trim()) return;
    const exists = config.templates.some((template) => template.id === next.id);
    const save = () => { updateThinking({ templates: exists ? config.templates.map((template) => template.id === next.id ? next : template) : [...config.templates, next] }); setTemplateDraft(null); };
    const count = bindingCount(next.id);
    if (exists && count) confirm({ title: '保存共享模板？', message: `将影响绑定此模板的 ${count} 个模型之后的请求。`, confirmLabel: '保存', onConfirm: save });
    else save();
  }

  function deleteTemplate(template: PromptTemplate) {
    if (locked) return;
    const count = bindingCount(template.id);
    confirm({ title: `删除“${template.name}”？`, message: count ? `绑定的 ${count} 个模型需要重新应用配置；文本草稿保留。` : '模板会删除，已有文本草稿保留。',
      confirmLabel: '删除', destructive: true,
      onConfirm: () => updateThinking({ templates: config.templates.filter((item) => item.id !== template.id) }) });
  }

  return <DetailScreen title="思维配置" footer={
    <Pressable accessibilityRole="button" accessibilityLabel="应用到此模型" disabled={!target || !!pending || locked || !!previewError || (mode === 'official' && rawJson !== null)}
      accessibilityState={{ disabled: !target || !!pending || locked || !!previewError || (mode === 'official' && rawJson !== null) }}
      onPress={() => { void apply(); }} style={[styles.apply, { backgroundColor: theme.primaryStrong, opacity: !target || pending || locked || previewError || (mode === 'official' && rawJson !== null) ? 0.4 : 1 }]}>
      <ThemedText style={[styles.applyLabel, { color: theme.onPrimary }]}>{pending ? '保存草稿中…' : '应用到此模型'}</ThemedText>
    </Pressable>
  }>
    <Card>
      <SectionHeading title="目标模型" />
      {editorId ? <ThemedText style={styles.target}>{target ? `${target.name} · ${target.apiModel}` : '编辑会话已结束，请返回模型页面重新打开。'}</ThemedText>
        : <Pressable accessibilityRole="button" accessibilityLabel="选择目标模型" onPress={() => setTargetPicker(true)} style={styles.targetButton}>
          <ThemedText style={styles.target}>{target ? `${target.name} · ${target.apiModel}` : '选择目标模型'}</ThemedText><Ionicons name="chevron-down" size={17} color={theme.textSecondary} />
        </Pressable>}
      <ThemedText themeColor="textSecondary" style={styles.note}>{editorId ? '配置随模型表单一起保存，离开未保存的模型不会另存。' : target ? `此模型当前使用：${THINKING_MODE_LABELS[target.cotMode]}` : targetMissing ? '目标模型已删除，请重新选择后编辑。' : '尚未选择模型，以下内容仅保存为公共草稿。'}</ThemedText>
      {editorId && target ? <ThemedText themeColor="textSecondary" style={styles.note}>模型表单选择：{THINKING_MODE_LABELS[target.cotMode]}</ThemedText> : null}
      {target && target.cotMode !== 'off' && !applied ? <ThemedText accessibilityRole="alert" style={[styles.note, { color: theme.danger }]}>当前模式需要重新应用；已有草稿保留。</ThemedText> : null}
    </Card>
    <View style={[styles.segmented, { backgroundColor: theme.backgroundElement }]}>{[modes.slice(0, 2), modes.slice(2)].map((row) => (
      <View key={row[0]} style={styles.segmentRow}>{row.map((item) => <Pressable key={item} accessibilityRole="radio"
        accessibilityLabel={`编辑模式：${THINKING_MODE_LABELS[item]}`} accessibilityState={{ checked: mode === item }}
        disabled={locked} onPress={() => { setMode(item); setSelection({ start: 0, end: 0 }); setError(null); setNotice(null); }}
        style={[styles.segment, { height: modeHeight }, mode === item && { backgroundColor: theme.primaryStrong }]}>
        <ThemedText numberOfLines={2} style={[styles.segmentText, { color: mode === item ? theme.onPrimary : theme.textSecondary }]}>{THINKING_MODE_LABELS[item]}</ThemedText>
      </Pressable>)}</View>
    ))}</View>
    <ThemedText themeColor="textSecondary" style={styles.note}>{modeHints[mode]} 切换编辑页不会改变已应用配置。</ThemedText>
    {contentMode ? <>
      <Card>
        <SectionHeading title={mode === 'official' ? '思考前缀' : mode === 'instruction' ? '自定义指令' : '普通提示词'}
          action={mode === 'persona' ? '恢复默认草稿' : '清空草稿'} onAction={() => confirm({ title: '替换当前草稿？', message: '已应用配置与其他模式草稿保持不变。',
            confirmLabel: '确定', onConfirm: () => changeDraft({ text: mode === 'persona' ? DEFAULT_PROMPT : '', templateId: null }) })} />
        {draft.templateId ? <ThemedText themeColor="textSecondary" style={styles.note}>草稿模板：{selectedTemplate?.name ?? '模板已不存在'}；直接改写文本将使用内联草稿。</ThemedText> : null}
        <View style={[styles.promptBox, { borderColor: theme.border, backgroundColor: theme.backgroundElement }]}>
          <TextInput ref={promptInput} accessibilityLabel={mode === 'official' ? '思考前缀草稿' : mode === 'instruction' ? '第三方指令草稿' : '普通提示词草稿'}
            multiline maxLength={PROMPT_LIMIT} editable={!locked} value={source} onChangeText={changePrompt}
            selection={selection} onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
            placeholder={mode === 'official' ? '填写你的思考前缀' : mode === 'instruction' ? '填写自定义标记与指令，内容由你决定' : '填写自然语言要求'}
            placeholderTextColor={theme.textSecondary} selectionColor={theme.primary} textAlignVertical="top" style={[styles.promptInput, { color: theme.text }]} />
          <ThemedText themeColor="textSecondary" style={styles.counter}>{source.length}/{PROMPT_LIMIT}</ThemedText>
        </View>
        <View style={styles.chips}>{variableNames.map((name) => <Chip key={name} label={`{${name}}`} onPress={() => insertVariable(name)} tone="accent" />)}
          <IconButton name="options-outline" label="管理提示词变量" onPress={() => setVariableManagerOpen(true)} tone="accent" />
        </View>
        {target && config.drafts?.[contentMode]?.text ? <SmallAction label="复制公共草稿" onPress={() => {
          const shared = config.drafts?.[contentMode]; if (shared) changeDraft({ ...shared });
        }} /> : null}
        {config.legacyMode ? <SmallAction label="复用旧提示词为草稿" onPress={() => changeDraft({ text: config.prompt, templateId: null })} /> : null}
      </Card>
      {mode === 'official' ? <NativeThinkingCard key={workspaceId} model={target} prefix={rendered.text} parameters={draft.parametersJson}
        active={target?.cotMode === 'official'} disabled={locked} onChange={(parametersJson) => changeDraft({ parametersJson })}
        parameterDraft={rawJson} onDraftChange={(value) => setJsonDrafts((current) => ({ ...current, [workspaceId]: value }))} /> : null}
      {mode === 'instruction' ? <Card>
        <SectionHeading title="注入位置" action={advanced ? '收起高级' : '高级'} onAction={() => setAdvanced(!advanced)} />
        <ThemedText style={styles.note}>{draft.placement === 'system-start' ? '系统提示词最前：自定义指令 → 人设与记忆 → 历史与本次提问' : '本次消息之前：人设与记忆 → 历史 → 自定义指令＋本次提问'}</ThemedText>
        {advanced ? <View style={styles.chips}>{([{ value: 'system-start', label: '系统提示词最前' }, { value: 'user-prefix', label: '本次消息之前' }] as const).map((placement) =>
          <Chip key={placement.value} label={placement.label} selected={draft.placement === placement.value} onPress={() => changeDraft({ placement: placement.value })} />)}</View> : null}
        <ThemedText themeColor="textSecondary" style={styles.note}>只修改发送副本；聊天原文保留，不追加 assistant 或启用接口思考字段。</ThemedText>
      </Card> : null}
      <Card>
        <SectionHeading title="提示词模板" action={managingTemplates ? '完成' : '管理'} onAction={() => setManagingTemplates(!managingTemplates)} />
        {templates.map((template) => <View key={template.id} style={[styles.templateRow, { borderColor: theme.border, backgroundColor: template.id === draft.templateId ? theme.primarySurface : theme.background }]}>
          <Pressable accessibilityRole="button" accessibilityLabel={`使用模板：${template.name}`} disabled={locked || template.enabled === false}
            accessibilityState={{ selected: draft.templateId === template.id, disabled: locked || template.enabled === false }}
            onPress={() => changeDraft({ text: template.prompt, templateId: template.id })} style={styles.templateMain}>
            <Ionicons name={template.icon} size={18} color={theme.textSecondary} />
            <View style={styles.templateCopy}><ThemedText style={styles.templateName}>{template.name}</ThemedText>
              <ThemedText themeColor="textSecondary" style={styles.meta}>{THINKING_MODE_LABELS[contentMode]} · 绑定 {bindingCount(template.id)} 个模型{template.enabled === false ? ' · 已停用' : ''}</ThemedText>
            </View>
          </Pressable>
          {managingTemplates ? <View style={styles.rowActions}>
            <IconButton name="power-outline" label={`${template.enabled === false ? '启用' : '停用'}模板：${template.name}`} onPress={() => updateThinking({ templates: config.templates.map((item) => item.id === template.id ? { ...item, enabled: item.enabled === false } : item) })} />
            <IconButton name="create-outline" label={`编辑模板：${template.name}`} onPress={() => setTemplateDraft({ ...template })} />
            <IconButton name="trash-outline" label={`删除模板：${template.name}`} onPress={() => deleteTemplate(template)} tone="danger" />
          </View> : null}
        </View>)}
        <SmallAction label="新建此类模板" icon="add" onPress={() => setTemplateDraft({ id: createId(), name: '', description: '', prompt: source, icon: 'sparkles', kind: contentMode })} />
      </Card>
      <Card>
        <SectionHeading title="发送草稿预览" action={previewExpanded ? '收起' : '展开'} onAction={() => setPreviewExpanded(!previewExpanded)} />
        <ThemedText themeColor="textSecondary" style={styles.note}>预览人设：{data.profile.name}；实际发送使用会话所属人设。此预览尚未应用。</ThemedText>
        {previewError ? <ThemedText accessibilityRole="alert" style={[styles.note, { color: theme.danger }]}>{previewError}</ThemedText> : null}
        <ThemedText selectable accessibilityLabel="渲染后的配置文本" numberOfLines={previewExpanded ? undefined : 4} style={styles.note}>{rendered.text || '填写内容后查看预览。'}</ThemedText>
        {previewExpanded && requestPreview ? <ThemedText selectable accessibilityLabel="请求消息顺序预览" style={styles.code}>{JSON.stringify(requestPreview.messages, null, 2)}</ThemedText> : null}
        {rendered.warnings.map((warning) => <ThemedText key={warning} style={[styles.note, { color: theme.primary }]}>{warning}</ThemedText>)}
      </Card>
    </> : null}
    {error ? <View><ThemedText accessibilityRole="alert" style={[styles.note, { color: theme.danger }]}>{error}</ThemedText>
      {modelConfig && target ? <SmallAction label="重试保存草稿" onPress={() => { setError(null); void persist(modelConfig).catch(() => {}); }} /> : null}</View> : null}
    {notice ? <ThemedText accessibilityRole="alert" style={[styles.note, { color: theme.primary }]}>{notice}</ThemedText> : null}
    <Sheet visible={targetPicker} title="选择目标模型" onClose={() => setTargetPicker(false)}>
      {models.map((model) => <SmallAction key={model.id} label={`${model.name} · ${model.apiModel}`} onPress={() => { setTargetId(model.id); setTargetPicker(false); setError(null); setNotice(null); }} />)}
      <SmallAction label="公共草稿（不应用到模型）" onPress={() => { setTargetId(''); setTargetPicker(false); }} />
    </Sheet>
    <Sheet visible={variableManagerOpen && !variableDraft} title="提示词变量" onClose={() => setVariableManagerOpen(false)}>
      <VariableSummary name="persona" value={data.profile.name} /><VariableSummary name="date" value={renderPrompt('{date}', data)} />
      {config.variables.map((variable) => <View key={variable.id} style={styles.variableRow}>
        <View style={styles.templateCopy}><ThemedText style={styles.templateName}>{`{${variable.name}}`}</ThemedText><ThemedText style={styles.note}>{variable.value}</ThemedText></View>
        <IconButton name="create-outline" label={`编辑变量：${variable.name}`} onPress={() => { setVariableError(null); setVariableDraft({ ...variable }); }} />
        <IconButton name="trash-outline" label={`删除变量：${variable.name}`} onPress={() => deleteVariable(variable)} tone="danger" />
      </View>)}
      <SmallAction label="添加变量" icon="add" onPress={() => { setVariableError(null); setVariableDraft({ id: createId(), name: '', value: '' }); }} />
    </Sheet>
    <Sheet visible={!!variableDraft} title={config.variables.some((item) => item.id === variableDraft?.id) ? '编辑变量' : '添加变量'}
      onClose={() => { if (!renameBusy) { setVariableDraft(null); setVariableError(null); } }} onSave={() => { void saveVariable(); }} saveDisabled={locked || !variableDraft?.name.trim()}>
      <Field label="变量名" value={variableDraft?.name ?? ''} editable={!locked} maxLength={40} autoCapitalize="none" autoCorrect={false}
        onChangeText={(name) => { if (variableDraft) setVariableDraft({ ...variableDraft, name }); setVariableError(null); }} />
      <Field label="内容" value={variableDraft?.value ?? ''} editable={!locked} multiline maxLength={PROMPT_LIMIT} onChangeText={(value) => variableDraft && setVariableDraft({ ...variableDraft, value })} />
      {variableError ? <ThemedText accessibilityRole="alert" style={[styles.note, { color: theme.danger }]}>{variableError}</ThemedText> : null}
    </Sheet>
    <Sheet visible={!!templateDraft} title={config.templates.some((item) => item.id === templateDraft?.id) ? '编辑共享模板' : '新建模板'}
      onClose={() => setTemplateDraft(null)} onSave={saveTemplate} saveDisabled={locked || !templateDraft?.name.trim() || !templateDraft.prompt.trim()}>
      <ThemedText style={styles.note}>用途：{templateDraft?.kind && templateDraft.kind !== 'unclassified' ? THINKING_MODE_LABELS[templateDraft.kind] : '普通提示词（旧模板）'} · 绑定 {templateDraft ? bindingCount(templateDraft.id) : 0} 个模型</ThemedText>
      <Field label="名称" value={templateDraft?.name ?? ''} maxLength={40} onChangeText={(name) => templateDraft && setTemplateDraft({ ...templateDraft, name })} />
      <Field label="描述" value={templateDraft?.description ?? ''} maxLength={160} onChangeText={(description) => templateDraft && setTemplateDraft({ ...templateDraft, description })} />
      <View style={styles.chips}>{templateIcons.map((icon) => <Chip key={icon} label={icon} selected={templateDraft?.icon === icon}
        onPress={() => templateDraft && setTemplateDraft({ ...templateDraft, icon })} />)}</View>
      <Field label="模板内容" value={templateDraft?.prompt ?? ''} multiline maxLength={PROMPT_LIMIT} onChangeText={(prompt) => templateDraft && setTemplateDraft({ ...templateDraft, prompt })} />
    </Sheet>
    {dialog}
  </DetailScreen>;
}

function VariableSummary({ name, value }: { name: string; value: string }) {
  return <View style={styles.variableRow}><ThemedText style={styles.templateName}>{`{${name}}`}</ThemedText><ThemedText style={styles.note}>{value}</ThemedText></View>;
}

const styles = StyleSheet.create({
  target: { ...Typography.rowTitle, flex: 1 }, targetButton: { flexDirection: 'row', gap: 10, alignItems: 'center', minHeight: 36 },
  segmented: { padding: 5, borderRadius: 13, gap: 5 },
  segmentRow: { flexDirection: 'row', gap: 5 },
  segment: { flex: 1, minWidth: 0, minHeight: 52, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center', borderRadius: 9 },
  segmentText: { ...Typography.compact, textAlign: 'center' },
  note: { ...Typography.secondary }, code: { ...Typography.code, fontFamily: 'monospace' },
  promptBox: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  promptInput: { ...Typography.input, fontFamily: Fonts.sans, minHeight: 140, maxHeight: 300, padding: 13 },
  counter: { ...Typography.caption, textAlign: 'right', paddingHorizontal: 13, paddingBottom: 9 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 7 },
  templateRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, paddingRight: 0 },
  templateMain: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 160, minHeight: 64, paddingVertical: 12, paddingHorizontal: 4 },
  templateCopy: { flex: 1, gap: 3 }, templateName: { ...Typography.rowTitle }, meta: { ...Typography.caption },
  rowActions: { flexDirection: 'row', marginLeft: 'auto' }, variableRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 9 },
  apply: { minHeight: 48, paddingVertical: 10, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  applyLabel: { ...Typography.button },
});
