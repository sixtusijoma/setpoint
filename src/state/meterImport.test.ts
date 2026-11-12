import { describe, expect, it } from 'vitest';

import { idleMeterImport, reduceMeterImport, type MeterImportState } from './model';

const summary = {
  inserted: 2,
  duplicates: 1,
  skipped: 1,
  firstAt: '2026-04-21T17:39:04.000Z',
  lastAt: '2026-11-11T23:51:00.000Z',
};

describe('meter import state', () => {
  const idle = idleMeterImport();
  const picking: MeterImportState = { status: 'picking' };
  const uploading: MeterImportState = { status: 'uploading' };
  const done: MeterImportState = { status: 'done', summary };
  const error: MeterImportState = { status: 'error', message: 'Could not read that file.' };

  it('walks idle, picking, uploading, and done', () => {
    expect(reduceMeterImport(idle, { type: 'pick' })).toEqual(picking);
    expect(reduceMeterImport(picking, { type: 'chosen' })).toEqual(uploading);
    expect(reduceMeterImport(uploading, { type: 'succeed', summary })).toEqual(done);
    expect(reduceMeterImport(done, { type: 'dismiss' })).toEqual(idle);
  });

  it('cancels a pick, fails a read, and fails an upload', () => {
    expect(reduceMeterImport(picking, { type: 'cancel' })).toEqual(idle);
    expect(reduceMeterImport(picking, { type: 'fail', message: 'Could not read that file.' })).toEqual(error);
    expect(reduceMeterImport(uploading, { type: 'fail', message: 'Could not read that file.' })).toEqual(error);
    expect(reduceMeterImport(error, { type: 'dismiss' })).toEqual(idle);
    expect(reduceMeterImport(error, { type: 'pick' })).toEqual(picking);
    expect(reduceMeterImport(done, { type: 'pick' })).toEqual(picking);
  });

  it('ignores events that do not belong to the current state', () => {
    expect(reduceMeterImport(idle, { type: 'chosen' })).toEqual(idle);
    expect(reduceMeterImport(idle, { type: 'succeed', summary })).toEqual(idle);
    expect(reduceMeterImport(idle, { type: 'fail', message: 'nope' })).toEqual(idle);
    expect(reduceMeterImport(idle, { type: 'cancel' })).toEqual(idle);
    expect(reduceMeterImport(idle, { type: 'dismiss' })).toEqual(idle);
    expect(reduceMeterImport(picking, { type: 'pick' })).toEqual(picking);
    expect(reduceMeterImport(picking, { type: 'succeed', summary })).toEqual(picking);
    expect(reduceMeterImport(picking, { type: 'dismiss' })).toEqual(picking);
    expect(reduceMeterImport(uploading, { type: 'pick' })).toEqual(uploading);
    expect(reduceMeterImport(uploading, { type: 'cancel' })).toEqual(uploading);
    expect(reduceMeterImport(uploading, { type: 'chosen' })).toEqual(uploading);
    expect(reduceMeterImport(uploading, { type: 'dismiss' })).toEqual(uploading);
    expect(reduceMeterImport(done, { type: 'chosen' })).toEqual(done);
    expect(reduceMeterImport(done, { type: 'cancel' })).toEqual(done);
    expect(reduceMeterImport(error, { type: 'chosen' })).toEqual(error);
    expect(reduceMeterImport(error, { type: 'cancel' })).toEqual(error);
  });
});
