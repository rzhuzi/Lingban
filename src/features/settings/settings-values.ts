/** Keep partially typed form values local until both fields are valid. */
export function chatSettingsValues(userName: string, contextWindow: string): { userName: string; contextWindow: number } | null {
  const name = userName.trim();
  if (!name || Array.from(name).length > 100 || !/^\d{1,3}$/.test(contextWindow)) return null;
  const count = Number(contextWindow);
  return count >= 1 && count <= 100 ? { userName: name, contextWindow: count } : null;
}
