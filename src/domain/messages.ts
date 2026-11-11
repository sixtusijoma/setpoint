export type AppMessage = {
  source: 'press' | 'schedule' | 'meter' | 'link';
  text: string;
} | null;

const rank: Record<NonNullable<AppMessage>['source'], number> = {
  meter: 1,
  link: 1,
  schedule: 2,
  press: 3,
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
