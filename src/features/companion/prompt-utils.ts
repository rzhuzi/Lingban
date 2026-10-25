import { renderTemplate, templateValues } from '../../lib/cot/template';
import type { CompanionData } from './types';

/** Unknown tokens stay intact; backslashes and double braces escape literal tokens. */
export function renderPrompt(prompt: string, data: CompanionData, date = new Date()): string {
  return renderTemplate(prompt, templateValues(data, date)).text;
}
