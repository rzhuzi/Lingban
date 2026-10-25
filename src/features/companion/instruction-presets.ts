import type { ModelRecord } from '../../lib/db/types';
import type { InstructionPlacement } from './types';

export type InstructionPreset = {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly prompt: string;
  readonly placement: InstructionPlacement;
  readonly modelScope: string;
  readonly usage: string;
  readonly caveat: string;
  readonly sourceUrl?: string;
  readonly sourceLabel?: string;
  readonly provenance: 'protocol-example' | 'community-example' | 'source-excerpt';
  readonly modelIds?: readonly string[];
};

export type InstructionPresetCompatibility = {
  level: 'no-model' | 'documented' | 'unverified';
  label: string;
  detail: string;
};

function freezePreset(preset: InstructionPreset): InstructionPreset {
  if (preset.modelIds) Object.freeze(preset.modelIds);
  return Object.freeze(preset);
}

/** Presets are copied into the role draft; they never replace saved configuration automatically. */
export const INSTRUCTION_PRESETS: readonly InstructionPreset[] = Object.freeze(([
  {
    id: 'harmony-analysis',
    name: 'Harmony analysis 消息头',
    summary: 'OpenAI Harmony 的 assistant analysis 通道前缀。',
    prompt: '<|start|>assistant<|channel|>analysis<|message|>',
    placement: 'user-prefix',
    modelScope: '仅供采用 Harmony 原始文本格式的兼容推理端尝试；本 App 的通用聊天 API 未核验。',
    usage: '只在服务端明确要求 Harmony 原始消息流时尝试；当前 App 会把它插在本次用户消息正文前。',
    caveat: '这是消息头与通道元数据，不是通用思考指令。analysis 通道不会因这段文本自动变成 API 参数，也不保证服务端返回或显示推理内容。',
    sourceUrl: 'https://github.com/openai/openai-cookbook/blob/main/articles/openai-harmony.md',
    sourceLabel: 'OpenAI Harmony 格式说明',
    provenance: 'protocol-example',
  },
  {
    id: 'deepseek-thinking-marker',
    name: 'DeepSeek 思考标记',
    summary: '社区 DeepSeek V4 角色对话提示中出现的思考块标记。',
    prompt: '<｜begin▁of▁thinking｜>',
    placement: 'user-prefix',
    modelScope: '社区写法指向 DeepSeek V4 思考式角色对话；当前 DeepSeek API 是否接受此标记未确认。',
    usage: '若要尝试，放在本次用户消息之前；先用普通问题对照测试，观察是否被识别为标记或普通文本。',
    caveat: '这是社区提示写法，不是已核验的官方 API 参数。V3.1 官方格式示例使用其他前缀；不能据此推断各代 DeepSeek 或第三方接口都支持。',
    sourceUrl: 'https://www.reddit.com/r/SillyTavernAI/comments/1su8x8p/deepseek_v4_rp_guide_how_to_switch_between/',
    sourceLabel: 'DeepSeek V4 社区角色对话示例',
    provenance: 'community-example',
  },
  {
    id: 'qwen3-think',
    name: 'Qwen3 /think 软指令',
    summary: '通过 /think 请求启用思考模式。',
    prompt: '/think',
    placement: 'user-prefix',
    modelScope: '仅核验 Qwen/Qwen3-8B 文档；服务端需兼容其聊天模板且 enable_thinking=True。',
    usage: '放在本次用户消息之前；在服务端启用思考软开关时，Qwen3 文档说明可逐轮切换。',
    caveat: '这只是软指令，不能覆盖服务端关闭思考的设置。其他型号、代理或云端产品的支持情况未确认，也未做真实 API 测试。',
    sourceUrl: 'https://huggingface.co/Qwen/Qwen3-8B',
    sourceLabel: 'Qwen3-8B 官方模型卡',
    provenance: 'source-excerpt',
    modelIds: ['Qwen/Qwen3-8B'],
  },
  {
    id: 'chatml-assistant',
    name: 'ChatML assistant 消息头',
    summary: 'ChatML 对话模板中用于开始 assistant 消息的前缀。',
    prompt: '<|im_start|>assistant',
    placement: 'user-prefix',
    modelScope: '采用 ChatML 模板、并允许原始提示续写的推理端；本 App 通用聊天 API 未核验。',
    usage: '底层模板通常把它放在 assistant 生成位置；本 App 目前只能将原文插到用户消息正文前。',
    caveat: '这是对话结构标记，不是输入框内的通用命令。普通 Chat Completions 请求仍按 API 的 messages/role 结构发送，不会因此创建 assistant 前缀。',
    sourceUrl: 'https://github.com/QwenLM/Qwen3/blob/main/docs/source/getting_started/concepts.md',
    sourceLabel: 'Qwen3 ChatML 格式说明',
    provenance: 'protocol-example',
  },
  {
    id: 'llama3-assistant',
    name: 'Llama 3 assistant 消息头',
    summary: 'Llama 3 对话模板中的 assistant 生成前缀。',
    prompt: '<|start_header_id|>assistant<|end_header_id|>',
    placement: 'user-prefix',
    modelScope: 'Llama 3 模板的原始文本推理端；型号和 API 服务端兼容性需分别核对。',
    usage: '原生模板通常把它放在 assistant 回复开始处；当前 App 只会将文本插到用户消息正文前，不能设置原生续写位置。',
    caveat: '不能将它粘贴进普通 API 聊天内容就视作 Llama 3 模板已启用；API 通常由服务端 tokenizer/chat template 组织消息。',
    sourceUrl: 'https://huggingface.co/meta-llama/Meta-Llama-3-8B-Instruct',
    sourceLabel: 'Meta Llama 3 官方模型卡',
    provenance: 'protocol-example',
  },
  {
    id: 'gemma-model-turn',
    name: 'Gemma model 回合前缀',
    summary: 'Gemma 指令格式中开始模型回复的标记。',
    prompt: '<start_of_turn>model',
    placement: 'user-prefix',
    modelScope: 'Gemma 指令微调模型及其兼容 tokenizer/chat template；当前通用 API 适配未核验。',
    usage: 'Gemma 原生模板会在 model 回合标记后接换行和模型输出；本 App 只能将你提供的原文加在用户消息正文前。',
    caveat: 'Google 文档将这些标记定义为 tokenizer 专用控制 token。当前 App 不会替换消息角色或把文本放到模型回复位置。',
    sourceUrl: 'https://ai.google.dev/gemma/docs/core/prompt-structure',
    sourceLabel: 'Google Gemma 提示格式说明',
    provenance: 'protocol-example',
  },
  {
    id: 'persona-load',
    name: 'PERSONA_LOAD 人设标记',
    summary: '一个可自行搭配人设内容尝试的社区/自定义触发标记。',
    prompt: '【PERSONA_LOAD】',
    placement: 'system-start',
    modelScope: '未确认官方支持或可适配的模型；效果取决于具体模型是否学过这段文本。',
    usage: '放在系统提示词开头，并在后续人设内容中写清角色规则；保存后用新对话比较效果。',
    caveat: '本条按你提供的全角方括号原文保存。公开报道提到过相近但不同括号的写法，不能证明此精确文本是官方指令或一定生效。',
    sourceUrl: 'https://en.theblockbeats.news/flash/361860',
    sourceLabel: '相近触发写法的媒体报道',
    provenance: 'community-example',
  },
] satisfies InstructionPreset[]).map(freezePreset));

function normalizeModelId(modelId: string) {
  return modelId.trim().toLowerCase().replace(/^qwen\//, '');
}

export function getInstructionPresetCompatibility(
  preset: InstructionPreset,
  model?: Pick<ModelRecord, 'apiModel'>,
): InstructionPresetCompatibility {
  if (!model?.apiModel.trim()) {
    return { level: 'no-model', label: '尚未选择模型', detail: '选择目标模型后查看对应提示；预设的适用范围和使用条件仍需确认。' };
  }
  if (preset.modelIds?.some((id) => normalizeModelId(id) === normalizeModelId(model.apiModel))) {
    return {
      level: 'documented',
      label: '型号有文档说明，服务端待确认',
      detail: '当前型号与 Qwen3-8B 文档范围一致；服务端需兼容聊天模板并允许 enable_thinking=True。未验证当前接口实际效果。',
    };
  }
  if (preset.modelIds?.length) {
    return {
      level: 'unverified',
      label: '当前型号待确认',
      detail: '仅核验 Qwen/Qwen3-8B 文档，不能外推到当前型号。可以编辑文本后自行实测，但不代表已适配。',
    };
  }
  if (preset.provenance === 'protocol-example') {
    return {
      level: 'unverified',
      label: '协议标记，当前接口未适配',
      detail: '它属于模型对话模板的结构标记；当前 App 只会把它放进系统或用户消息正文，不会设置原生 assistant 续写前缀。',
    };
  }
  return preset.provenance === 'community-example'
    ? { level: 'unverified', label: '社区写法，适配未核实', detail: '当前没有确认支持的型号；按普通提示文本插入，是否生效取决于模型与接口。' }
    : { level: 'unverified', label: '通用文本，待实测', detail: '按普通提示词组织内容，没有型号专属开关或适配保证；请用当前模型比较实际效果。' };
}

/** A modified draft is custom text, even when it retains part of a preset. */
export function findInstructionPreset(text: string, placement: InstructionPlacement): InstructionPreset | undefined {
  return INSTRUCTION_PRESETS.find((preset) => preset.prompt === text && preset.placement === placement);
}
