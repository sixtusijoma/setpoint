export type Lifecycle =
  | { kind: 'boot' }
  | { kind: 'active' }
  | { kind: 'paused'; press: 'none' | 'interrupted' };

export type LifecycleEvent = 'booted' | 'foreground' | 'background' | 'press-interrupted' | 'press-cleared';

export type AppActivity = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';

export function lifecycleEventForAppState(state: Lifecycle, status: AppActivity): LifecycleEvent | null {
  if (status === 'background') {
    return state.kind === 'boot' ? null : 'background';
  }
  if (status === 'active' && state.kind === 'paused') {
    return 'foreground';
  }
  return null;
}

export function reduceLifecycle(state: Lifecycle, event: LifecycleEvent): Lifecycle {
  if (event === 'booted') {
    if (state.kind === 'boot') {
      return { kind: 'active' };
    }
    return state;
  }
  if (event === 'background') {
    if (state.kind === 'boot') {
      return state;
    }
    return { kind: 'paused', press: 'none' };
  }
  if (event === 'press-interrupted') {
    return { kind: 'paused', press: 'interrupted' };
  }
  if (event === 'foreground' || event === 'press-cleared') {
    return { kind: 'active' };
  }
  return state;
}
