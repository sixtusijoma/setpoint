import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { upcomingOccurrences, type ScheduleEvent } from '@/domain/schedule';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export async function syncReminders(events: ScheduleEvent[], now: Date): Promise<void> {
  const current = await Notifications.getPermissionsAsync();
  if (!current.granted) {
    return;
  }
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('setpoint', {
      name: 'Schedules',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }
  const upcoming = upcomingOccurrences(events, now, 14).slice(0, 60);
  await Notifications.cancelAllScheduledNotificationsAsync();
  for (const item of upcoming) {
    const when = new Date(item.at);
    if (when.getTime() <= now.getTime()) {
      continue;
    }
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `${item.label} · set to ${item.targetF}°`,
        body: 'Open Setpoint to run it.',
        data: { eventId: item.eventId, at: item.at },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: when,
        channelId: 'setpoint',
      },
    });
  }
}

export async function requestReminderPermission(): Promise<string> {
  const current = await Notifications.getPermissionsAsync();
  let granted = current.granted;
  if (!granted) {
    const asked = await Notifications.requestPermissionsAsync();
    granted = asked.granted;
  }
  if (!granted) {
    return 'Notification permission was not granted. Upcoming changes still show in Setpoint.';
  }
  return 'Reminders will ask you to open Setpoint when a change is due.';
}

export function watchNotificationOpen(onOpen: () => void): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener(() => {
    onOpen();
  });
  return () => {
    subscription.remove();
  };
}
