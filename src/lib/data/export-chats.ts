import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { buildChatExport, chatExportFilename, type ChatExportSnapshot } from './export-core';

/** Opens only the OS share chooser. The user chooses where, whether, and to whom to save/share. */
export async function exportAllChats(snapshot: ChatExportSnapshot): Promise<void> {
  try {
    if (!await Sharing.isAvailableAsync()) throw new Error('unavailable');
    const date = new Date();
    const folder = new Directory(Paths.cache, 'chat-exports');
    folder.create({ intermediates: true, idempotent: true });
    const file = new File(folder, chatExportFilename(date));
    file.create({ overwrite: true });
    await file.write(buildChatExport(snapshot, date));
    await Sharing.shareAsync(file.uri, { mimeType: 'application/json', UTI: 'public.json', dialogTitle: '导出聊天记录' });
  } catch { throw new Error('聊天记录导出失败，请检查设备是否支持文件分享后重试。'); }
}
