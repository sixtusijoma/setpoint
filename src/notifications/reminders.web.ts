import type { ScheduleEvent } from '@/domain/schedule';

export async function syncReminders(_events: ScheduleEvent[], _now: Date): Promise<void> {
  return;
}

export async function requestReminderPermission(): Promise<string> {
  if (typeof Notification === 'undefined') {
    return 'Reminders stay listed in Setpoint. This browser cannot schedule them.';
  }
  try {
    const result = await Notification.requestPermission();
    if (result !== 'granted') {
      return 'Notification permission was not granted. Upcoming changes still show in Setpoint.';
    }
    new Notification('Setpoint', {
      body: 'Reminders stay listed in the app. This browser cannot run them while the tab is closed.',
    });
  } catch {
    return 'Reminders stay listed in Setpoint. This browser cannot schedule them.';
  }
  return 'This browser can notify you now, but it cannot be trusted to fire later. Upcoming changes stay listed in Setpoint.';
}

export function watchNotificationOpen(_onOpen: () => void): () => void {
  return () => undefined;
}
