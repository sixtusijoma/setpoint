import * as SecureStore from 'expo-secure-store';

const KEY = 'setpoint.app-key';

export async function loadAppKey(): Promise<string | null> {
  try {
    const value = await SecureStore.getItemAsync(KEY);
    if (!value) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export async function saveAppKey(value: string): Promise<void> {
  await SecureStore.setItemAsync(KEY, value);
}

export async function deleteAppKey(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY);
  } catch {
    return;
  }
}
