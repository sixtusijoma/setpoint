import * as SecureStore from 'expo-secure-store';

import { parseCredentials, type SavedCredentials } from '@/storage/credential-codec';

const KEY = 'setpoint.switchbot.credentials';

export { maskSecret } from '@/storage/credential-codec';
export type { SavedCredentials } from '@/storage/credential-codec';

export async function saveCredentials(token: string, secret: string): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify({ token, secret }));
}

export async function loadCredentials(): Promise<SavedCredentials | null> {
  const raw = await SecureStore.getItemAsync(KEY);
  return parseCredentials(raw);
}

export async function clearCredentials(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
