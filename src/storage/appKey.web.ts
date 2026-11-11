const KEY = 'setpoint.app-key';

function storage(): Storage | null {
  if (typeof sessionStorage === 'undefined') {
    return null;
  }
  return sessionStorage;
}

export async function loadAppKey(): Promise<string | null> {
  const store = storage();
  if (!store) {
    return null;
  }
  return store.getItem(KEY);
}

export async function saveAppKey(value: string): Promise<void> {
  const store = storage();
  if (!store) {
    return;
  }
  store.setItem(KEY, value);
}

export async function deleteAppKey(): Promise<void> {
  const store = storage();
  if (!store) {
    return;
  }
  store.removeItem(KEY);
}
