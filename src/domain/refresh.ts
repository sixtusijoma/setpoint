export type RefreshPhase = 'idle' | 'background' | 'user';

export type Refresh = {
  phase: RefreshPhase;
  epoch: number;
};

export type RefreshEvent = { type: 'start'; source: 'user' | 'background' } | { type: 'settle'; epoch: number };

export function initialRefresh(): Refresh {
  return { phase: 'idle', epoch: 0 };
}

export function refreshSpinner(phase: RefreshPhase): boolean {
  return phase === 'user';
}

export function reduceRefresh(state: Refresh, event: RefreshEvent): Refresh {
  if (event.type === 'settle') {
    if (state.phase === 'idle' || state.epoch !== event.epoch) {
      return state;
    }
    return { phase: 'idle', epoch: state.epoch };
  }
  if (state.phase === 'idle') {
    return { phase: event.source === 'user' ? 'user' : 'background', epoch: state.epoch + 1 };
  }
  if (event.source === 'user' && state.phase === 'background') {
    return { phase: 'user', epoch: state.epoch };
  }
  return state;
}
