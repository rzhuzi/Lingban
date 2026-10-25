import type { CompanionData, ModelThinkingConfig, PromptVariable } from './types';
import { copyModelThinkingConfig, THINKING_CONTENT_MODES } from './thinking-config';

export function renameThinkingToken(text: string, oldName: string, newName: string) {
  return text.replace(/\\\{([^{}]+)\}|\{\{([^{}]+)\}\}|\{([^{}]+)\}/g,
    (token, escaped: string | undefined, doubleEscaped: string | undefined, name: string | undefined) =>
      escaped === undefined && doubleEscaped === undefined && name === oldName ? `{${newName}}` : token);
}
export function renameModelThinkingVariable(config: ModelThinkingConfig, oldName: string, newName: string) {
  const next = copyModelThinkingConfig(config);
  for (const mode of THINKING_CONTENT_MODES) {
    next[mode].draft.text = renameThinkingToken(next[mode].draft.text, oldName, newName);
    if (next[mode].applied) next[mode].applied!.text = renameThinkingToken(next[mode].applied!.text, oldName, newName);
    if (next[mode].draft.text.length > 32768 || (next[mode].applied?.text.length ?? 0) > 32768) throw new Error('新变量名会使模型配置超过字符上限。');
  }
  return next;
}
export function renameCompanionThinkingVariable(data: CompanionData, oldName: string, newName: string, variables: PromptVariable[]) {
  if (!newName.trim() || /[{}\s]/u.test(newName) || ['persona', 'date'].includes(newName)) throw new Error('变量名无效。');
  if (new Set(variables.map((item) => item.name)).size !== variables.length) throw new Error('变量名重复。');
  const next: CompanionData = JSON.parse(JSON.stringify(data));
  next.thinking.variables = JSON.parse(JSON.stringify(variables));
  next.thinking.prompt = renameThinkingToken(next.thinking.prompt, oldName, newName);
  for (const template of next.thinking.templates) template.prompt = renameThinkingToken(template.prompt, oldName, newName);
  for (const draft of Object.values(next.thinking.drafts ?? {})) draft.text = renameThinkingToken(draft.text, oldName, newName);
  if (next.thinking.prompt.length > 32768 || next.thinking.templates.some((item) => item.prompt.length > 32768)) throw new Error('新变量名会使提示词超过字符上限。');
  return next;
}
