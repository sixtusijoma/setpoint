import { PillButton, Sheet } from '@/components/ui';
import { calendarMonth, monthTitle, shiftMonth } from '@/domain/historyWindow';
import { colors, fonts } from '@/theme';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

export function DatePickerSheet({
  visible,
  selected,
  earliestDay,
  today,
  onPick,
  onClose,
}: {
  visible: boolean;
  selected: string;
  earliestDay: string | null;
  today: string;
  onPick: (date: string) => void;
  onClose: () => void;
}) {
  return (
    <Sheet visible={visible} onClose={onClose}>
      {visible ? (
        <MonthGrid selected={selected} earliestDay={earliestDay} today={today} onPick={onPick} onClose={onClose} />
      ) : null}
    </Sheet>
  );
}

function MonthGrid({
  selected,
  earliestDay,
  today,
  onPick,
  onClose,
}: {
  selected: string;
  earliestDay: string | null;
  today: string;
  onPick: (date: string) => void;
  onClose: () => void;
}) {
  const [month, setMonth] = useState(selected);
  const shown = month.slice(0, 7);
  const canBack = earliestDay === null || shown > earliestDay.slice(0, 7);
  const canForward = shown < today.slice(0, 7);
  const weeks = calendarMonth(month, earliestDay, today);

  return (
    <View testID="history-date-picker" style={styles.block}>
      <Text style={styles.title}>Jump to a date</Text>
      <Text style={styles.body}>The window ends on the day you pick.</Text>
      <View style={styles.monthRow}>
        <MonthArrow
          glyph="‹"
          label="Previous month"
          testID="history-picker-prev"
          disabled={!canBack}
          onPress={() => setMonth(shiftMonth(month, -1))}
        />
        <Text testID="history-picker-month" style={styles.month}>
          {monthTitle(month)}
        </Text>
        <MonthArrow
          glyph="›"
          label="Next month"
          testID="history-picker-next"
          disabled={!canForward}
          onPress={() => setMonth(shiftMonth(month, 1))}
        />
      </View>
      <View style={styles.week}>
        {WEEKDAYS.map((name) => (
          <Text key={name} style={styles.weekday}>
            {name}
          </Text>
        ))}
      </View>
      {weeks.map((week) => (
        <View key={week[0]?.date} style={styles.week}>
          {week.map((cell) =>
            cell.inMonth ? (
              <Pressable
                key={cell.date}
                testID={`history-picker-${cell.date}`}
                accessibilityRole="button"
                accessibilityLabel={cell.date}
                accessibilityState={{ disabled: !cell.enabled, selected: cell.date === selected }}
                disabled={!cell.enabled}
                onPress={() => onPick(cell.date)}
                style={[
                  styles.day,
                  cell.date === selected && styles.daySelected,
                  cell.date === today && cell.date !== selected && styles.dayToday,
                ]}
              >
                <Text style={[styles.dayText, !cell.enabled && styles.dayOff]}>{cell.label}</Text>
              </Pressable>
            ) : (
              <View key={cell.date} style={styles.day} />
            ),
          )}
        </View>
      ))}
      <PillButton label="Close" tone="ghost" testID="history-picker-close" onPress={onClose} />
    </View>
  );
}

function MonthArrow({
  glyph,
  label,
  testID,
  disabled,
  onPress,
}: {
  glyph: string;
  label: string;
  testID: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[styles.arrow, disabled && styles.arrowOff]}
    >
      <Text style={styles.arrowText}>{glyph}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  block: { gap: 10 },
  title: { color: colors.text, fontFamily: fonts.displayStrong, fontSize: 26 },
  body: { color: colors.muted, fontFamily: fonts.body, fontSize: 14, lineHeight: 20 },
  monthRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  month: { color: colors.text, fontFamily: fonts.semibold, fontSize: 17 },
  arrow: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowOff: { opacity: 0.35 },
  arrowText: { color: colors.text, fontFamily: fonts.medium, fontSize: 24, lineHeight: 28 },
  week: { flexDirection: 'row', justifyContent: 'space-between' },
  weekday: { width: 40, textAlign: 'center', color: colors.faint, fontFamily: fonts.medium, fontSize: 12 },
  day: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  daySelected: { backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.neutral },
  dayToday: { borderWidth: 1, borderColor: colors.line },
  dayText: { color: colors.text, fontFamily: fonts.medium, fontSize: 15, fontVariant: ['tabular-nums'] },
  dayOff: { color: colors.faint, opacity: 0.5 },
});
