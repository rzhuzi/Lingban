import { Redirect } from 'expo-router';
import { useChatRole } from '@/features/chat/use-chat-role';

/** Old links now edit the viewed role; there is no global model-thinking workspace. */
export default function ThinkingRoute() {
  const { roleId } = useChatRole();
  return <Redirect href={{ pathname: '/role', params: { ...(roleId ? { id: roleId } : {}), section: 'thinking' } }} />;
}
