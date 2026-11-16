export type AppMessage = {
  source: 'press' | 'schedule';
  text: string;
} | null;

const rank: Record<NonNullable<AppMessage>['source'], number> = {
  schedule: 1,
  press: 2,
};

export function pushMessage(current: AppMessage, next: AppMessage): AppMessage {
  if (!next) {
    return null;
  }
  if (!current) {
    return next;
  }
  if (rank[next.source] < rank[current.source]) {
    return current;
  }
  return next;
}
