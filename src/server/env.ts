export type ServerEnv = {
  appKeyHash?: Uint8Array<ArrayBufferLike>;
  cronSecret?: string;
  mcpKey?: string;
  switchbotToken?: string;
  switchbotSecret?: string;
  supabaseUrl?: string;
  serviceRoleKey?: string;
  webOrigin?: string;
};

export function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const fromProcess = proc?.env?.[name];
  if (fromProcess) {
    return fromProcess;
  }
  const deno = (globalThis as { Deno?: { env: { get: (key: string) => string | undefined } } }).Deno;
  return deno?.env.get(name);
}

export async function runtimeEnv(): Promise<ServerEnv> {
  const rawAppKey = readEnv('SETPOINT_APP_KEY');
  const appKeyHash = rawAppKey ? await hashAppKey(rawAppKey) : undefined;
  return {
    appKeyHash,
    cronSecret: readEnv('CRON_SECRET'),
    mcpKey: readEnv('SETPOINT_MCP_KEY'),
    switchbotToken: readEnv('SWITCHBOT_TOKEN'),
    switchbotSecret: readEnv('SWITCHBOT_SECRET'),
    supabaseUrl: readEnv('SUPABASE_URL'),
    serviceRoleKey: readEnv('SUPABASE_SERVICE_ROLE_KEY'),
    webOrigin: readEnv('SETPOINT_WEB_ORIGIN'),
  };
}

export async function hashAppKey(value: string): Promise<Uint8Array<ArrayBufferLike>> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

export function sameBytes(left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): boolean {
  if (left.length !== right.length || left.length === 0) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

export async function appKeyMatches(provided: string, expectedHash: Uint8Array | undefined): Promise<boolean> {
  if (!expectedHash || expectedHash.length === 0) {
    return false;
  }
  const actual = await hashAppKey(provided);
  return sameBytes(actual, expectedHash);
}

export function sameSecret(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length || a.length === 0) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a[index] ^ b[index];
  }
  return diff === 0;
}
