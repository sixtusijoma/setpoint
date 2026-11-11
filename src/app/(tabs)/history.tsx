import { HistoryChart } from '@/components/history-chart';
import { changesInWindow, sliceWindow, type SetpointChange } from '@/domain/history';
import { formatInstant } from '@/domain/time';
import { useApp } from '@/state/store';
import { colors, fonts } from '@/theme';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type Span = 'day' | 'week';
type Metric = 'temperatureF' | 'humidity' | 'co2Ppm';

const METRICS: { id: Metric; label: string }[] = [
  { id: 'temperatureF', label: 'Temperature' },
  { id: 'humidity', label: 'Humidity' },
  { id: 'co2Ppm', label: 'CO2' },
];

export default function HistoryScreen() {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const [span, setSpan] = useState<Span>('day');
  const [metric, setMetric] = useState<Metric>('temperatureF');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadHistory = useRef(app.loadHistory);
  loadHistory.current = app.loadHistory;
  const liveServer = app.serverConfigured && app.state.mode === 'live';
  useEffect(() => {
    if (!liveServer) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void loadHistory
      .current(span)
      .then(() => {
        if (!cancelled) {
          setLoading(false);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setLoading(false);
          setError(reason instanceof Error ? reason.message : 'History could not be loaded.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [liveServer, span]);

  const samples = sliceWindow(app.state.history, app.clock, span);
  const changes = changesInWindow(app.state.changes, app.clock, span);
  const latest = samples[samples.length - 1];

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: Math.max(insets.top, 16), paddingBottom: 96 }]}
    >
      <Text style={styles.title}>History</Text>
      <Text style={styles.body}>
        {app.state.mode === 'demo'
          ? 'Simulated room readings. Coral lines are setpoint changes.'
          : 'Meter readings stored by the shared server. Coral lines are setpoint changes.'}
      </Text>
      <View style={styles.segment}>
        <Segment label="Day" testID="history-day" on={span === 'day'} onPress={() => setSpan('day')} />
        <Segment label="Week" testID="history-week" on={span === 'week'} onPress={() => setSpan('week')} />
      </View>
      <View style={styles.segment}>
        {METRICS.map((item) => (
          <Segment
            key={item.id}
            label={item.label}
            testID={`history-${item.id}`}
            on={metric === item.id}
            onPress={() => setMetric(item.id)}
          />
        ))}
      </View>
      {loading ? <Text style={styles.body}>Loading readings.</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {samples.length === 0 && !loading ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No readings in this window</Text>
          <Text style={styles.body}>Pull to refresh on Home, or wait for the server meter.</Text>
        </View>
      ) : null}
      {samples.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.value}>{formatMetric(metric, latest?.[metric] ?? 0)}</Text>
          <HistoryChart samples={samples} changes={changes} metric={metric} />
        </View>
      ) : null}
      <Text style={styles.section}>Setpoint changes</Text>
      {changes.length === 0 ? <Text style={styles.body}>No thermostat changes in this window.</Text> : null}
      {changes.map((change) => (
        <View key={`${change.at}-${change.label}`} testID="history-marker" style={styles.marker}>
          <Text style={styles.markerTitle}>{change.label}</Text>
          <Text style={styles.body}>
            {change.setpoint}° · {formatInstant(change.at, true)} · {sourceLabel(change)}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

function formatMetric(metric: Metric, value: number): string {
  if (metric === 'temperatureF') {
    return `${value.toFixed(1)}°`;
  }
  if (metric === 'humidity') {
    return `${Math.round(value)}%`;
  }
  return `${Math.round(value)} ppm`;
}

function sourceLabel(change: SetpointChange): string {
  if (change.source === 'sleep-now') {
    return 'Sleep now';
  }
  if (change.source === 'wake-now') {
    return 'Wake now';
  }
  if (change.source === 'schedule') {
    return 'Scheduled';
  }
  return 'Manual';
}

function Segment({
  label,
  on,
  onPress,
  testID,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable testID={testID} onPress={onPress} style={[styles.segmentItem, on && styles.segmentOn]}>
      <Text style={styles.segmentText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 20, gap: 12 },
  title: { color: colors.text, fontFamily: fonts.displayStrong, fontSize: 36 },
  body: { color: colors.muted, fontFamily: fonts.body, fontSize: 14, lineHeight: 20 },
  error: { color: colors.poor, fontFamily: fonts.body, fontSize: 14 },
  section: { color: colors.text, fontFamily: fonts.semibold, fontSize: 18, marginTop: 8 },
  segment: { flexDirection: 'row', gap: 8 },
  segmentItem: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentOn: { backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.neutral },
  segmentText: { color: colors.text, fontFamily: fonts.medium, fontSize: 13 },
  card: { backgroundColor: colors.card, borderRadius: 16, padding: 12, gap: 8 },
  value: { color: colors.text, fontFamily: fonts.display, fontSize: 32 },
  empty: { backgroundColor: colors.card, borderRadius: 16, padding: 16, gap: 6 },
  emptyTitle: { color: colors.text, fontFamily: fonts.semibold, fontSize: 18 },
  marker: { backgroundColor: colors.card, borderRadius: 14, padding: 12, gap: 4 },
  markerTitle: { color: colors.text, fontFamily: fonts.semibold, fontSize: 16 },
});
