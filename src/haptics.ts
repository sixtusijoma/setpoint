import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

function vibrate(pattern: number | number[]): void {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    navigator.vibrate(pattern);
  }
}

export function pressFeedback(): void {
  if (Platform.OS === 'web') {
    vibrate(12);
    return;
  }
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
}

export function selectionFeedback(): void {
  if (Platform.OS === 'web') {
    vibrate(4);
    return;
  }
  void Haptics.selectionAsync();
}

export function successFeedback(): void {
  if (Platform.OS === 'web') {
    vibrate([8, 24, 12]);
    return;
  }
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
}

export function errorFeedback(): void {
  if (Platform.OS === 'web') {
    vibrate([18, 36, 18]);
    return;
  }
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
}
