export type ServerEnv = {
  anonKey?: string;
  cronSecret?: string;
  mcpKey?: string;
  switchbotToken?: string;
  switchbotSecret?: string;
  supabaseUrl?: string;
  serviceRoleKey?: string;
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

export function runtimeEnv(): ServerEnv {
  return {
    anonKey: readEnv('SUPABASE_ANON_KEY'),
    cronSecret: readEnv('CRON_SECRET'),
    mcpKey: readEnv('SETPOINT_MCP_KEY'),
    switchbotToken: readEnv('SWITCHBOT_TOKEN'),
    switchbotSecret: readEnv('SWITCHBOT_SECRET'),
    supabaseUrl: readEnv('SUPABASE_URL'),
    serviceRoleKey: readEnv('SUPABASE_SERVICE_ROLE_KEY'),
  };
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
