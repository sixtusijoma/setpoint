import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import { fetchState, ServerAuthError } from './appClient';
import { APP_KEY_HEADER } from './http';

const root = process.cwd();

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      found.push(...sourceFiles(full));
      continue;
    }
    if (full.endsWith('.test.ts') || full.endsWith('.test.tsx')) {
      continue;
    }
    if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      found.push(full);
    }
  }
  return found;
}

describe('app key secrecy', () => {
  it('keeps the app key out of client source', () => {
    const files = [
      ...sourceFiles(path.join(root, 'src/app')),
      ...sourceFiles(path.join(root, 'src/components')),
      ...sourceFiles(path.join(root, 'src/state')),
      ...sourceFiles(path.join(root, 'src/storage')),
      path.join(root, 'src/server/appClient.ts'),
    ];
    const blob = files.map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(blob.includes('EXPO_PUBLIC_SETPOINT_APP_KEY')).toBe(false);
    expect(blob.includes('SETPOINT_APP_KEY')).toBe(false);
    expect(blob.includes('process.env.SETPOINT_APP_KEY')).toBe(false);
    expect(blob.includes(APP_KEY_HEADER)).toBe(true);
  });

  it('sends the key only as a header and keeps it out of errors and logs', async () => {
    const appKey = `k-${crypto.randomUUID()}`;
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((item) => String(item)).join(' '));
      }),
    );
    const original = globalThis.fetch;
    let headerMatched = false;
    let url = '';
    globalThis.fetch = async (input, init) => {
      url = String(input);
      headerMatched = new Headers(init?.headers).get(APP_KEY_HEADER) === appKey;
      return new Response(JSON.stringify({ error: `rejected ${appKey}` }), { status: 401 });
    };
    let thrown = '';
    try {
      await fetchState({ url: 'http://local', publishableKey: 'publishable-placeholder' }, appKey);
    } catch (error) {
      thrown = error instanceof Error ? error.message : '';
      expect(error).toBeInstanceOf(ServerAuthError);
    } finally {
      globalThis.fetch = original;
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
    expect(headerMatched).toBe(true);
    expect(url.includes(appKey)).toBe(false);
    expect(thrown.includes(appKey)).toBe(false);
    expect(lines.some((line) => line.includes(appKey))).toBe(false);

    globalThis.fetch = async () => new Response(JSON.stringify({ version: 4 }), { status: 200 });
    try {
      const snap = await fetchState({ url: 'http://local', publishableKey: 'publishable-placeholder' }, appKey);
      expect(snap.version).toBe(4);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('does not inline the app key into the web bundle', () => {
    const secret = `bundle-${crypto.randomUUID()}`;
    const output = path.join('/tmp', `setpoint-export-${crypto.randomUUID()}`);
    const result = spawnSync('npx', ['expo', 'export', '--platform', 'web', '--output-dir', output], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        CI: '1',
        EXPO_NO_TELEMETRY: '1',
        SETPOINT_APP_KEY: secret,
        EXPO_PUBLIC_SETPOINT_APP_KEY: secret,
      },
    });
    const rendered = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.split(secret).join('[redacted]');
    expect(result.status, rendered).toBe(0);
    const hits = sourceFiles(output).filter((file) => readFileSync(file, 'utf8').includes(secret));
    const extra = readdirSync(output, { recursive: true })
      .map((entry) => path.join(output, String(entry)))
      .filter((file) => {
        try {
          return statSync(file).isFile();
        } catch {
          return false;
        }
      })
      .filter((file) => readFileSync(file, 'utf8').includes(secret));
    expect(hits).toEqual([]);
    expect(extra).toEqual([]);
  }, 180000);
});
