import { colors, fonts } from '@/theme';
import { Modal, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { ReactNode } from 'react';

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Eyebrow({ children }: { children: string }) {
  return <Text style={styles.eyebrow}>{children}</Text>;
}

export function Banner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <View style={styles.banner} testID="banner">
      <Text style={styles.bannerText}>{message}</Text>
      <Pressable onPress={onDismiss} hitSlop={8} accessibilityRole="button">
        <Text style={styles.bannerDismiss}>Dismiss</Text>
      </Pressable>
    </View>
  );
}

export function PillButton({
  label,
  onPress,
  testID,
  disabled,
  tone = 'solid',
}: {
  label: string;
  onPress: () => void;
  testID?: string;
  disabled?: boolean;
  tone?: 'solid' | 'ghost';
}) {
  return (
    <Pressable
      testID={testID}
      disabled={disabled}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        tone === 'ghost' && styles.pillGhost,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Text style={styles.pillText}>{label}</Text>
    </Pressable>
  );
}

export function CircleButton({
  label,
  onPress,
  testID,
  disabled,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  testID?: string;
  disabled?: boolean;
  accessibilityLabel: string;
}) {
  return (
    <Pressable
      testID={testID}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [styles.circle, disabled && styles.disabled, pressed && !disabled && styles.circlePressed]}
    >
      <Text style={styles.circleLabel}>{label}</Text>
    </Pressable>
  );
}

export function Sheet({
  visible,
  onClose,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={styles.modalRoot}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close sheet" />
        <View style={styles.sheet}>{children}</View>
      </View>
    </Modal>
  );
}

export function ConfirmDialog({
  visible,
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  visible: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalRoot}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={styles.confirm}>
          <Text style={styles.confirmTitle}>{title}</Text>
          <Text style={styles.confirmBody}>{body}</Text>
          <PillButton label={confirmLabel} onPress={onConfirm} testID="confirm-action" />
          <Pressable onPress={onClose} style={styles.confirmCancel}>
            <Text style={styles.confirmCancelText}>Not now</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

export function Stepper({
  value,
  onMinus,
  onPlus,
  minusLabel = 'Decrease',
  plusLabel = 'Increase',
  testID,
}: {
  value: string;
  onMinus: () => void;
  onPlus: () => void;
  minusLabel?: string;
  plusLabel?: string;
  testID?: string;
}) {
  return (
    <View style={styles.stepper}>
      <Pressable accessibilityRole="button" accessibilityLabel={minusLabel} onPress={onMinus} style={styles.stepperHit}>
        <Text style={styles.stepperGlyph}>−</Text>
      </Pressable>
      <Text testID={testID} style={styles.stepperValue}>
        {value}
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel={plusLabel} onPress={onPlus} style={styles.stepperHit}>
        <Text style={styles.stepperGlyph}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: 18,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.line,
  },
  eyebrow: {
    color: colors.muted,
    fontFamily: fonts.medium,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  banner: {
    backgroundColor: 'rgba(225,106,92,0.14)',
    borderRadius: 14,
    padding: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: 'rgba(225,106,92,0.35)',
  },
  bannerText: {
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 20,
  },
  bannerDismiss: {
    color: colors.neutral,
    fontFamily: fonts.medium,
    fontSize: 13,
  },
  pill: {
    backgroundColor: colors.raised,
    borderRadius: 999,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  pillGhost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.line,
  },
  pillText: {
    color: colors.text,
    fontFamily: fonts.semibold,
    fontSize: 16,
  },
  disabled: {
    opacity: 0.35,
  },
  pressed: {
    transform: [{ scale: 0.98 }],
  },
  circle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.raised,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.line,
  },
  circlePressed: {
    transform: [{ scale: 0.96 }],
  },
  circleLabel: {
    color: colors.text,
    fontFamily: fonts.medium,
    fontSize: 34,
    lineHeight: 38,
  },
  modalRoot: {
    flex: 1,
    justifyContent: 'flex-end',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  sheet: {
    width: '100%',
    maxWidth: 480,
    backgroundColor: colors.card,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 22,
    paddingTop: 18,
    paddingBottom: 28,
    gap: 14,
  },
  confirm: {
    width: '88%',
    maxWidth: 420,
    backgroundColor: colors.card,
    borderRadius: 22,
    padding: 20,
    gap: 12,
    marginBottom: 40,
  },
  confirmTitle: {
    color: colors.text,
    fontFamily: fonts.displayStrong,
    fontSize: 26,
  },
  confirmBody: {
    color: colors.muted,
    fontFamily: fonts.body,
    fontSize: 15,
    lineHeight: 22,
  },
  confirmCancel: {
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  confirmCancelText: {
    color: colors.muted,
    fontFamily: fonts.medium,
    fontSize: 15,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  stepperHit: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperGlyph: {
    color: colors.text,
    fontSize: 26,
    fontFamily: fonts.medium,
  },
  stepperValue: {
    color: colors.text,
    fontFamily: fonts.display,
    fontSize: 42,
    fontVariant: ['tabular-nums'],
  },
});
