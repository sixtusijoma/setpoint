import { describe, expect, it } from 'vitest';

import { importSheetTitle, importSheetWarning, titleFor } from './meter-import-copy';

const base = {
  inserted: 0,
  duplicates: 0,
  skipped: 0,
  firstAt: null as string | null,
  lastAt: null as string | null,
  skipReasons: [] as string[],
};

describe('meter import sheet copy', () => {
  it('shows counts as complete when any rows were stored', () => {
    const summary = { ...base, inserted: 12, duplicates: 3, skipped: 1, skipReasons: ['Could not read the timestamp.'] };
    expect(importSheetTitle(summary)).toBe('Import complete');
    expect(importSheetWarning(summary)).toBeNull();
    expect(titleFor({ status: 'done', summary })).toBe('Import complete');
  });

  it('warns when every row was skipped and never says finished', () => {
    const summary = {
      ...base,
      skipped: 5,
      skipReasons: ['Could not read the timestamp.'],
    };
    expect(importSheetTitle(summary)).toBe('Nothing was imported');
    expect(importSheetWarning(summary)).toBe('Every row was skipped. Nothing was stored.');
    expect(titleFor({ status: 'done', summary })).not.toMatch(/finished/i);
  });

  it('treats an already-stored file as complete, not as a skip warning', () => {
    const summary = { ...base, duplicates: 5, firstAt: '2025-11-22T19:17:43.000Z', lastAt: '2025-11-22T19:17:43.000Z' };
    expect(importSheetTitle(summary)).toBe('Import complete');
    expect(importSheetWarning(summary)).toBeNull();
  });
});
