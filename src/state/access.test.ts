import { describe, expect, it } from 'vitest';

import { reduceAppAccess, type AppAccess } from './model';

const locked: AppAccess = { status: 'locked' };
const checking: AppAccess = { status: 'checking' };
const unlocked: AppAccess = { status: 'unlocked' };
const wrong: AppAccess = { status: 'wrong-key' };
const unused: AppAccess = { status: 'unused' };

describe('app access', () => {
  it('starts locked when a server is configured and no key is saved', () => {
    expect(reduceAppAccess(unused, { type: 'no-key' })).toEqual(locked);
    expect(reduceAppAccess(unused, { type: 'server-off' })).toEqual(unused);
  });

  it('checks a saved key by leaving unused before the check', () => {
    const withServer = reduceAppAccess(unused, { type: 'no-key' });
    const pending = reduceAppAccess(withServer, { type: 'submit' });
    expect(pending).toEqual(checking);
    expect(reduceAppAccess(pending, { type: 'accepted' })).toEqual(unlocked);
  });

  it('unlocks only after a check accepts the key', () => {
    expect(reduceAppAccess(locked, { type: 'accepted' })).toEqual(locked);
    const pending = reduceAppAccess(locked, { type: 'submit' });
    expect(pending).toEqual(checking);
    expect(reduceAppAccess(pending, { type: 'accepted' })).toEqual(unlocked);
  });

  it('moves a rejected check to wrong-key and lets the next try start again', () => {
    const pending = reduceAppAccess(locked, { type: 'submit' });
    const rejected = reduceAppAccess(pending, { type: 'rejected' });
    expect(rejected).toEqual(wrong);
    expect(reduceAppAccess(rejected, { type: 'submit' })).toEqual(checking);
    expect(reduceAppAccess(checking, { type: 'accepted' })).toEqual(unlocked);
  });

  it('locks again when the saved key is cleared or the user asks to change it', () => {
    expect(reduceAppAccess(unlocked, { type: 'clear' })).toEqual(locked);
    expect(reduceAppAccess(wrong, { type: 'clear' })).toEqual(locked);
    expect(reduceAppAccess(unlocked, { type: 'change' })).toEqual(locked);
    expect(reduceAppAccess(unused, { type: 'clear' })).toEqual(unused);
    expect(reduceAppAccess(unused, { type: 'submit' })).toEqual(unused);
  });

  it('treats a later rejection as wrong-key and a network miss as locked', () => {
    expect(reduceAppAccess(unlocked, { type: 'rejected' })).toEqual(wrong);
    expect(reduceAppAccess(checking, { type: 'unreachable' })).toEqual(locked);
    expect(reduceAppAccess(locked, { type: 'rejected' })).toEqual(locked);
  });
});
