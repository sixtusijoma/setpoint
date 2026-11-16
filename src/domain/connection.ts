export const CONNECTION_DOWN_AFTER_MS = 10_000;
export const CONNECTION_FAILURES_BEFORE_DOWN = 2;

export type Connection =
  | { status: 'ok' }
  | { status: 'flaky'; failures: number; since: number; lastError: string }
  | { status: 'down'; error: string };

export type ConnectionEvent =
  | { type: 'success' }
  | { type: 'transient-failure'; error: string; at: number }
  | { type: 'hard-failure'; error: string }
  | { type: 'foreground'; at: number }
  | { type: 'dismiss' };

export function initialConnection(): Connection {
  return { status: 'ok' };
}

export function connectionBanner(state: Connection): string | null {
  if (state.status === 'down') {
    return state.error;
  }
  return null;
}

export function reduceConnection(state: Connection, event: ConnectionEvent): Connection {
  switch (event.type) {
    case 'success':
      return state.status === 'ok' ? state : { status: 'ok' };
    case 'hard-failure':
      return state.status === 'down' && state.error === event.error ? state : { status: 'down', error: event.error };
    case 'transient-failure':
      return onTransient(state, event.error, event.at);
    case 'foreground':
      return onForeground(state, event.at);
    case 'dismiss':
      return state.status === 'down' ? { status: 'ok' } : state;
  }
}

function onTransient(state: Connection, error: string, at: number): Connection {
  if (state.status === 'down') {
    return state.error === error ? state : { status: 'down', error };
  }
  if (!Number.isFinite(at)) {
    return state;
  }
  if (state.status === 'ok') {
    return { status: 'flaky', failures: 1, since: at, lastError: error };
  }
  const failures = state.failures + 1;
  if (failures >= CONNECTION_FAILURES_BEFORE_DOWN) {
    return { status: 'down', error };
  }
  return { status: 'flaky', failures, since: state.since, lastError: error };
}

function onForeground(state: Connection, at: number): Connection {
  if (state.status !== 'flaky') {
    return state;
  }
  if (!Number.isFinite(at) || !Number.isFinite(state.since) || at - state.since < CONNECTION_DOWN_AFTER_MS) {
    return state;
  }
  return { status: 'down', error: state.lastError };
}
