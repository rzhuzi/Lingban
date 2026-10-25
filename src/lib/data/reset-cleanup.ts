import { Directory, File, Paths } from 'expo-file-system';

/** Only app-owned copies and export cache are removed. Original photo-library files are untouched. */
const ownedDirectories = () => [new Directory(Paths.document, 'companion-images'), new Directory(Paths.cache, 'chat-exports')];

export async function collectAppFiles(): Promise<string[]> {
  return ownedDirectories().flatMap((directory) => directory.exists
    ? directory.list().filter((entry): entry is File => entry instanceof File).map((file) => file.uri) : []);
}

export async function cleanupAppFiles(files: string[]) {
  const parents = ownedDirectories().map((directory) => directory.uri);
  for (const uri of files) {
    const file = new File(uri);
    if (!parents.includes(file.parentDirectory.uri)) throw new Error('清理文件不属于应用副本目录。');
    if (file.exists) file.delete();
  }
}
