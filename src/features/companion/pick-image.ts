import { Directory, File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

export async function pickProfileImage(kind: 'cover' | 'avatar'): Promise<string | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: kind === 'avatar' ? [1, 1] : [2, 1],
    quality: 0.85,
    base64: Platform.OS === 'web',
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (Platform.OS === 'web') {
    if (!asset.base64) throw new Error('无法读取这张图片，请重试。');
    return `data:image/jpeg;base64,${asset.base64}`;
  }
  const directory = new Directory(Paths.document, 'companion-images');
  directory.create({ idempotent: true, intermediates: true });
  const source = new File(asset.uri);
  const extension = source.extension || '.jpg';
  const destination = new File(directory, `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`);
  await source.copy(destination);
  return destination.uri;
}
