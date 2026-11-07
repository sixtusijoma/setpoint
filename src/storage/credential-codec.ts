export type SavedCredentials = {
  token: string;
  secret: string;
};

export function maskSecret(secret: string): string {
  if (secret.length <= 4) {
    return '••••';
  }
  return `••••${secret.slice(-4)}`;
}

export function parseCredentials(raw: string | null): SavedCredentials | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SavedCredentials>;
    if (typeof parsed.token !== 'string' || typeof parsed.secret !== 'string') {
      return null;
    }
    if (!parsed.token || !parsed.secret) {
      return null;
    }
    return { token: parsed.token, secret: parsed.secret };
  } catch {
    return null;
  }
}
