import { changeKey, type ChangePage, type SetpointChange } from './history';

export const CHANGE_LOG_PAGE_SIZE = 15;

export type ChangeLog =
  | { status: 'idle'; request: number }
  | { status: 'loading'; request: number; items: SetpointChange[]; cursor: string | null }
  | { status: 'loaded'; request: number; items: SetpointChange[]; cursor: string }
  | { status: 'error'; request: number; items: SetpointChange[]; cursor: string | null; message: string }
  | { status: 'exhausted'; request: number; items: SetpointChange[] };

export type ChangeLogEvent =
  | { type: 'start' }
  | { type: 'more' }
  | { type: 'retry' }
  | { type: 'reset' }
  | ({ type: 'page'; request: number } & ChangePage)
  | { type: 'fail'; request: number; message: string };

export function idleChangeLog(): ChangeLog {
  return { status: 'idle', request: 0 };
}

export function changeLogItems(log: ChangeLog): SetpointChange[] {
  return log.status === 'idle' ? [] : log.items;
}

export function pendingPage(log: ChangeLog): { request: number; cursor: string | null } | null {
  return log.status === 'loading' ? { request: log.request, cursor: log.cursor } : null;
}

export function reduceChangeLog(log: ChangeLog, event: ChangeLogEvent): ChangeLog {
  if (event.type === 'start') {
    if (log.status === 'idle') {
      return { status: 'loading', request: log.request + 1, items: [], cursor: null };
    }
    return log;
  }
  if (event.type === 'reset') {
    return { status: 'loading', request: log.request + 1, items: [], cursor: null };
  }
  if (event.type === 'more') {
    if (log.status === 'loaded') {
      return { status: 'loading', request: log.request + 1, items: log.items, cursor: log.cursor };
    }
    return log;
  }
  if (event.type === 'retry') {
    if (log.status === 'error') {
      return { status: 'loading', request: log.request + 1, items: log.items, cursor: log.cursor };
    }
    return log;
  }
  if (log.status !== 'loading' || event.request !== log.request) {
    return log;
  }
  if (event.type === 'fail') {
    return { status: 'error', request: log.request, items: log.items, cursor: log.cursor, message: event.message };
  }
  const seen = new Set(log.items.map(changeKey));
  const fresh = event.changes.filter((change) => !seen.has(changeKey(change)));
  const items = [...log.items, ...fresh];
  const stalled = fresh.length === 0 || event.nextCursor === log.cursor;
  if (event.nextCursor === null || stalled) {
    return { status: 'exhausted', request: log.request, items };
  }
  return { status: 'loaded', request: log.request, items, cursor: event.nextCursor };
}
