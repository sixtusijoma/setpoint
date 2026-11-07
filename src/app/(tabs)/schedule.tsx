import { ConfirmDialog, PillButton, Sheet, Stepper } from '@/components/ui';
import { latestRecord, nextOccurrence, upcomingOccurrences, type ScheduleEvent } from '@/domain/schedule';
import { TIME_ZONE_LABEL, dayNames, formatClock, formatInstant, to12Hour, to24Hour } from '@/domain/time';
import { useApp } from '@/state/store';
import { colors, fonts } from '@/theme';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

export default function ScheduleScreen() {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const [editing, setEditing] = useState<ScheduleEvent | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const last = latestRecord(app.state.records, ['ran', 'already']);
  const missed = latestRecord(app.state.records, ['missed']);
  const next = nextOccurrence(app.state.events, app.clock);
  const reminders = upcomingOccurrences(app.state.events, app.clock, 14).slice(0, 8);
  const cancelled = app.state.records.filter((record) => record.status === 'cancelled');

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: Math.max(insets.top, 16), paddingBottom: 96 }]}
    >
      <Text style={styles.title}>Schedule</Text>
      <Text style={styles.zone}>{TIME_ZONE_LABEL}</Text>
      <View style={styles.summary}>
        <Summary label="Last run" value={last ? `${last.label} · ${formatInstant(last.occurrenceAt, true)}` : 'None yet'} />
        <Summary label="Next run" value={next ? `${next.label} · ${formatInstant(next.at, true)} · ${next.targetF}°` : 'None'} />
        <Summary
          label="Missed run"
          value={missed ? `${missed.label} · ${formatInstant(missed.occurrenceAt, true)}` : 'None'}
        />
      </View>
      <Text style={styles.body}>
        {app.state.hold
          ? 'A temporary hold is on. The next due change ends it, or you can resume from Home.'
          : 'Following the schedule. Due changes run while Setpoint is open.'}
      </Text>
      {cancelled.map((record) => (
        <View key={record.key} style={styles.cancelled}>
          <Text style={styles.eventTitle}>
            Cancelled {record.label} · {record.targetF}°
          </Text>
          <Text style={styles.body}>{record.message}</Text>
          <PillButton
            label="Apply now"
            testID={`apply-${record.eventId}`}
            onPress={() => {
              void app.applyCancelled(record.key);
            }}
          />
        </View>
      ))}
      {app.state.events.length === 0 ? (
        <Text style={styles.body}>No events. The thermostat stays where you set it until you add one.</Text>
      ) : null}
      {app.state.events.map((event) => (
        <Pressable key={event.id} testID={`event-${event.id}`} style={styles.event} onPress={() => setEditing(event)}>
          <View style={styles.eventTop}>
            <Text style={styles.eventTitle}>{event.label}</Text>
            <Text style={styles.eventTemp}>{event.targetF}°</Text>
          </View>
          <Text style={styles.body}>
            {dayNames(event.days)} · {formatClock(event.hour, event.minute)}
            {event.enabled ? '' : ' · off'}
          </Text>
        </Pressable>
      ))}
      <PillButton label="Add event" onPress={app.addEvent} />
      <Text style={styles.section}>Reminders</Text>
      <Text style={styles.body}>Open Setpoint to run each one. A suspended phone will not press the bots on its own.</Text>
      {reminders.map((item) => (
        <Text key={item.key} style={styles.reminder}>
          {item.label} · set to {item.targetF}° · {formatInstant(item.at, true)}
        </Text>
      ))}
      <PillButton label="Restore defaults" tone="ghost" testID="restore-defaults" onPress={() => setRestoreOpen(true)} />
      {editing ? (
        <Editor
          event={editing}
          minF={app.state.settings.minF}
          maxF={app.state.settings.maxF}
          onClose={() => setEditing(null)}
          onSave={(event) => {
            app.saveEvent(event);
            setEditing(null);
          }}
          onDelete={() => {
            app.deleteEvent(editing.id);
            setEditing(null);
          }}
        />
      ) : null}
      <ConfirmDialog
        visible={restoreOpen}
        title="Restore defaults?"
        body="Replace your weekly schedule with Sleep on weekday nights at 11:45 PM, 61°, and Wake every morning at 6:45 AM, 70°."
        confirmLabel="Restore"
        onClose={() => setRestoreOpen(false)}
        onConfirm={() => {
          setRestoreOpen(false);
          app.restoreDefaults();
        }}
      />
    </ScrollView>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryCard}>
      <Text style={styles.kicker}>{label}</Text>
      <Text style={styles.summaryValue}>{value}</Text>
    </View>
  );
}

function Editor({
  event,
  minF,
  maxF,
  onClose,
  onSave,
  onDelete,
}: {
  event: ScheduleEvent;
  minF: number;
  maxF: number;
  onClose: () => void;
  onSave: (event: ScheduleEvent) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(event);
  const clock = to12Hour(draft.hour);
  return (
    <Sheet visible onClose={onClose}>
      <Text style={styles.editorTitle}>Edit event</Text>
      <TextInput
        value={draft.label}
        onChangeText={(label) => setDraft({ ...draft, label })}
        style={styles.input}
        placeholder="Label"
        placeholderTextColor={colors.faint}
      />
      <Stepper
        value={formatClock(draft.hour, draft.minute)}
        onMinus={() => setDraft({ ...draft, minute: (draft.minute + 59) % 60 })}
        onPlus={() => setDraft({ ...draft, minute: (draft.minute + 1) % 60 })}
        minusLabel="Earlier minute"
        plusLabel="Later minute"
      />
      <View style={styles.hourRow}>
        <Pressable
          accessibilityRole="button"
          style={styles.small}
          onPress={() => {
            const hour12 = clock.hour12 === 1 ? 12 : clock.hour12 - 1;
            setDraft({ ...draft, hour: to24Hour(hour12, clock.period) });
          }}
        >
          <Text style={styles.smallText}>Hour −</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          style={styles.small}
          onPress={() => {
            const hour12 = clock.hour12 === 12 ? 1 : clock.hour12 + 1;
            setDraft({ ...draft, hour: to24Hour(hour12, clock.period) });
          }}
        >
          <Text style={styles.smallText}>Hour +</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          style={styles.small}
          onPress={() => {
            const period = clock.period === 'AM' ? 'PM' : 'AM';
            setDraft({ ...draft, hour: to24Hour(clock.hour12, period) });
          }}
        >
          <Text style={styles.smallText}>{clock.period}</Text>
        </Pressable>
      </View>
      <View style={styles.days}>
        {DAY_LABELS.map((label, index) => {
          const day = index + 1;
          const on = draft.days.includes(day);
          return (
            <Pressable
              key={`${event.id}-day-${day}`}
              style={[styles.day, on && styles.dayOn]}
              onPress={() => {
                const days = on ? draft.days.filter((item) => item !== day) : [...draft.days, day];
                if (days.length === 0) {
                  return;
                }
                setDraft({ ...draft, days });
              }}
            >
              <Text style={styles.dayText}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
      <Stepper
        value={`${draft.targetF}°`}
        onMinus={() => setDraft({ ...draft, targetF: Math.max(minF, draft.targetF - 1) })}
        onPlus={() => setDraft({ ...draft, targetF: Math.min(maxF, draft.targetF + 1) })}
      />
      <View style={styles.enabled}>
        <Text style={styles.body}>Enabled</Text>
        <Switch
          value={draft.enabled}
          onValueChange={(enabled) => setDraft({ ...draft, enabled })}
          trackColor={{ false: colors.raised, true: colors.coral }}
          thumbColor={colors.text}
        />
      </View>
      <PillButton label="Save event" testID="save-event" onPress={() => onSave(draft)} />
      <PillButton label="Delete" tone="ghost" onPress={onDelete} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 20, gap: 12 },
  title: { color: colors.text, fontFamily: fonts.displayStrong, fontSize: 36 },
  zone: { color: colors.neutral, fontFamily: fonts.medium, fontSize: 13 },
  summary: { gap: 8 },
  summaryCard: { backgroundColor: colors.card, borderRadius: 14, padding: 12, gap: 4 },
  summaryValue: { color: colors.text, fontFamily: fonts.semibold, fontSize: 16 },
  kicker: {
    color: colors.muted,
    fontFamily: fonts.medium,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  body: { color: colors.muted, fontFamily: fonts.body, fontSize: 14, lineHeight: 20 },
  event: { backgroundColor: colors.card, borderRadius: 16, padding: 14, gap: 4 },
  eventTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  eventTitle: { color: colors.text, fontFamily: fonts.semibold, fontSize: 18 },
  eventTemp: { color: colors.neutral, fontFamily: fonts.display, fontSize: 28 },
  cancelled: { backgroundColor: colors.card, borderRadius: 16, padding: 14, gap: 8 },
  section: { color: colors.text, fontFamily: fonts.semibold, fontSize: 18, marginTop: 8 },
  reminder: { color: colors.muted, fontFamily: fonts.body, fontSize: 14 },
  editorTitle: { color: colors.text, fontFamily: fonts.displayStrong, fontSize: 28 },
  input: {
    backgroundColor: colors.bg,
    color: colors.text,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontFamily: fonts.body,
    fontSize: 16,
  },
  hourRow: { flexDirection: 'row', gap: 8 },
  small: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    backgroundColor: colors.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallText: { color: colors.text, fontFamily: fonts.medium, fontSize: 14 },
  days: { flexDirection: 'row', justifyContent: 'space-between' },
  day: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  dayOn: { backgroundColor: colors.coral },
  dayText: { color: colors.text, fontFamily: fonts.semibold, fontSize: 13 },
  enabled: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});
