import type { CompanionData } from '../../features/companion/types';

/** User-authored identity precedes memories, then the optional thinking framework. */
export function buildPersonaSystem(data: CompanionData, framework = '') {
  const { profile } = data;
  return [
    `你是${profile.name.trim() || '零伴'}。`,
    profile.description.trim(),
    profile.traits.length ? `性格：${profile.traits.join('、')}` : '',
    data.memories.length ? `【记忆】\n${data.memories.map((memory) => `- ${memory.text}`).join('\n')}` : '',
    data.interests.length ? `【兴趣与标签】\n${data.interests.join('、')}` : '',
    framework ? `【思维框架】\n${framework}` : '',
  ].filter(Boolean).join('\n\n');
}
