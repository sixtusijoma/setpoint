import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'json'],
      include: [
        'src/domain/scheduleApply.ts',
        'src/domain/schedule.ts',
        'src/domain/scheduleRunner.ts',
        'src/server/engine.ts',
        'src/server/mcp.ts',
        'src/storage/persist.ts',
      ],
    },
  },
});
