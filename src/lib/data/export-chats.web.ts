import { buildChatExport, chatExportFilename, type ChatExportSnapshot } from './export-core';

/** Blob download avoids Web Share's HTTPS and local-file restrictions. */
export async function exportAllChats(snapshot: ChatExportSnapshot): Promise<void> {
  if (typeof document === 'undefined') throw new Error('请在浏览器中导出聊天记录。');
  let url: string | null = null;
  const link = document.createElement('a');
  try {
    const date = new Date();
    url = URL.createObjectURL(new Blob([buildChatExport(snapshot, date)], { type: 'application/json;charset=utf-8' }));
    link.href = url;
    link.download = chatExportFilename(date);
    document.body.appendChild(link);
    link.click();
  } catch { throw new Error('聊天记录导出失败，请重试。'); }
  finally {
    link.remove();
    if (url) { const objectUrl = url; setTimeout(() => URL.revokeObjectURL(objectUrl), 1000); }
  }
}
