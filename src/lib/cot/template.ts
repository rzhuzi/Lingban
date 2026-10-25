import type { CompanionData } from '../../features/companion/types';

export function templateValues(data: CompanionData, date = new Date()) {
  const values = new Map(data.thinking.variables.map((variable) => [variable.name, variable.value]));
  values.set('persona', data.profile.name);
  values.set('date', `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`);
  return values;
}

/** Rendering is deliberately one pass: inserted values cannot introduce new substitutions. */
export function renderTemplate(source: string, values: ReadonlyMap<string, string>) {
  const unknown = new Set<string>();
  const text = source.replace(/\\\{([^{}]+)\}|\{\{([^{}]+)\}\}|\{([^{}]+)\}/g,
    (token, escaped: string | undefined, doubleBraced: string | undefined, name: string | undefined) => {
      if (escaped !== undefined) return `{${escaped}}`;
      if (doubleBraced !== undefined) return `{${doubleBraced}}`;
      if (name !== undefined && values.has(name)) return values.get(name)!;
      if (name !== undefined) unknown.add(name);
      return token;
    });
  return { text, warnings: [...unknown].map((name) => `未定义变量：{${name}}`) };
}
