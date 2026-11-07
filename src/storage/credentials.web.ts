import { parseCredentials, type SavedCredentials } from '@/storage/credential-codec';

const KEY = 'setpoint.switchbot.credentials';

export { maskSecret } from '@/storage/credential-codec';
export type { SavedCredentials } from '@/storage/credential-codec';

export async function saveCredentials(token: string, secret: string): Promise<void> {
  sessionStorage.setItem(KEY, JSON.stringify({ token, secret }));
}

export async function loadCredentials(): Promise<SavedCredentials | null> {
  return parseCredentials(sessionStorage.getItem(KEY));
}

export async function clearCredentials(): Promise<void> {
  sessionStorage.removeItem(KEY);
}
