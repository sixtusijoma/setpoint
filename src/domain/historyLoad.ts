import type { HistorySpan } from './history';

export type HistoryLoad =
  | { status: 'off'; request: number }
  | { status: 'loading'; request: number; span: HistorySpan }
  | { status: 'ready'; request: number; span: HistorySpan }
  | { status: 'error'; request: number; span: HistorySpan; message: string };

export type HistoryLoadEvent =
  | { type: 'fetch'; span: HistorySpan }
  | { type: 'loaded'; request: number }
  | { type: 'fail'; request: number; message: string }
  | { type: 'off' };

export function offHistoryLoad(): HistoryLoad {
  return { status: 'off', request: 0 };
}

export function reduceHistoryLoad(load: HistoryLoad, event: HistoryLoadEvent): HistoryLoad {
  if (event.type === 'fetch') {
    return { status: 'loading', request: load.request + 1, span: event.span };
  }
  if (event.type === 'off') {
    return load.status === 'off' ? load : { status: 'off', request: load.request + 1 };
  }
  if (load.status !== 'loading' || event.request !== load.request) {
    return load;
  }
  if (event.type === 'loaded') {
    return { status: 'ready', request: load.request, span: load.span };
  }
  return { status: 'error', request: load.request, span: load.span, message: event.message };
}
