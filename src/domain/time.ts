import { DateTime } from 'luxon';

export const TIME_ZONE = 'America/New_York';
export const TIME_ZONE_LABEL = 'Eastern Time';

export function to24Hour(hour12: number, period: 'AM' | 'PM'): number {
  if (period === 'AM') {
    if (hour12 === 12) {
      return 0;
    }
    return hour12;
  }
  if (hour12 === 12) {
    return 12;
  }
  return hour12 + 12;
}

export function to12Hour(hour: number): { hour12: number; period: 'AM' | 'PM' } {
  const period = hour >= 12 ? 'PM' : 'AM';
  let hour12 = hour % 12;
  if (hour12 === 0) {
    hour12 = 12;
  }
  return { hour12, period };
}

export function formatClock(hour: number, minute: number): string {
  const suffix = hour >= 12 ? 'PM' : 'AM';
  let hour12 = hour % 12;
  if (hour12 === 0) {
    hour12 = 12;
  }
  const minutes = minute.toString().padStart(2, '0');
  return `${hour12}:${minutes} ${suffix}`;
}

export function formatInstant(iso: string, withWeekday = false): string {
  const instant = DateTime.fromISO(iso, { setZone: true }).setZone(TIME_ZONE);
  if (!instant.isValid) {
    return '';
  }
  if (withWeekday) {
    return instant.toFormat('ccc h:mm a');
  }
  return instant.toFormat('h:mm a');
}

export function formatStamp(iso: string): string {
  const instant = DateTime.fromISO(iso, { setZone: true }).setZone(TIME_ZONE);
  if (!instant.isValid) {
    return '';
  }
  return instant.toFormat('h:mm:ss a');
}

export function dayNames(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  const key = sorted.join(',');
  if (key === '1,2,3,4,5,6,7') {
    return 'Every day';
  }
  if (key === '1,2,3,4,5') {
    return 'Weekdays';
  }
  if (key === '6,7') {
    return 'Weekends';
  }
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return sorted.map((day) => names[day - 1] ?? '').join(' ');
}
