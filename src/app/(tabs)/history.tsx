import { HistoryChart } from '@/components/history-chart';
import { MeterImportSheet } from '@/components/meter-import-sheet';
import { PillButton } from '@/components/ui';
import {
  CHANGE_LOG_PAGE_SIZE,
  changeLogItems,
  idleChangeLog,
  pendingPage,
  reduceChangeLog,
  type ChangeLog,
} from '@/domain/changeLog';
import { describeChangeSource, formatReadoutTime, type ChartMetric } from '@/domain/chart';
import {
  aggregateSamples,
  bucketSecondsForRange,
  changeKey,
  changesInWindow,
  sliceWindow,
  spanWindowMs,
  type HistorySpan,
  type SetpointChange,
} from '@/domain/history';
import { offHistoryLoad, reduceHistoryLoad } from '@/domain/historyLoad';
import type { ScheduleEvent } from '@/domain/schedule';
import { pickCsvText } from '@/storage/pickCsv';
import { useApp } from '@/state/store';
import { colors, fonts } from '@/theme';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useEffectEvent, useMemo, useReducer, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { FlatList } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const METRICS: { id: ChartMetric; label: string }[] = [
  { id: 'temperatureF', label: 'Temperature' },
  { id: 'humidity', label: 'Humidity' },
  { id: 'co2Ppm', label: 'CO2' },
];

export default function HistoryScreen() {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const [span, setSpan] = useState<HistorySpan>('day');
  const [metric, setMetric] = useState<ChartMetric>('temperatureF');
  const [load, dispatchLoad] = useReducer(reduceHistoryLoad, undefined, offHistoryLoad);
  const [log, dispatchLog] = useReducer(reduceChangeLog, undefined, idleChangeLog);
  const liveServer = app.serverConfigured && app.state.mode === 'live';

  useFocusEffect(
    useCallback(() => {
      dispatchLoad(liveServer ? { type: 'fetch', span } : { type: 'off' });
    }, [liveServer, span]),
  );

  const refetchAfterImport = useEffectEvent(() => {
    if (liveServer) {
      dispatchLoad({ type: 'fetch', span });
    }
  });
  useEffect(() => {
    if (app.meterImport.status === 'done') {
      refetchAfterImport();
    }
  }, [app.meterImport]);

  const loadingRequest = load.status === 'loading' ? load.request : null;
  const loadingSpan = load.status === 'loading' ? load.span : null;
  const runLoad = useEffectEvent((request: number, target: HistorySpan) => {
    app.loadHistory(target).then(
      () => dispatchLoad({ type: 'loaded', request }),
      (reason: unknown) =>
        dispatchLoad({
          type: 'fail',
          request,
          message: reason instanceof Error ? reason.message : 'History could not be loaded.',
        }),
    );
  });
  useEffect(() => {
    if (loadingRequest !== null && loadingSpan !== null) {
      runLoad(loadingRequest, loadingSpan);
    }
  }, [loadingRequest, loadingSpan]);

  const source = liveServer ? 'server' : 'local';
  useEffect(() => {
    dispatchLog({ type: 'reset' });
  }, [source]);

  const headAt = newestAt(app.state.changes);
  const refreshLog = useEffectEvent(() => {
    const listHead = changeLogItems(log)[0];
    const listHeadAt = listHead ? Date.parse(listHead.at) : null;
    if (headAt !== null && log.status !== 'loading' && (listHeadAt === null || headAt > listHeadAt)) {
      dispatchLog({ type: 'reset' });
    }
  });
  useEffect(() => {
    refreshLog();
  }, [headAt]);

  const pending = pendingPage(log);
  const pendingRequest = pending?.request ?? null;
  const pendingCursor = pending?.cursor ?? null;
  const fetchPage = useEffectEvent((request: number, cursor: string | null) => {
    app.loadChangesPage(cursor, CHANGE_LOG_PAGE_SIZE).then(
      (page) => dispatchLog({ type: 'page', request, ...page }),
      (reason: unknown) =>
        dispatchLog({
          type: 'fail',
          request,
          message: reason instanceof Error ? reason.message : 'Setpoint changes could not be loaded.',
        }),
    );
  });
  useEffect(() => {
    if (pendingRequest !== null) {
      fetchPage(pendingRequest, pendingCursor);
    }
  }, [pendingRequest, pendingCursor]);

  const bucketSeconds = bucketSecondsForRange(spanWindowMs(span));
  const samples = useMemo(
    () => aggregateSamples(sliceWindow(app.state.history, app.clock, span), bucketSeconds),
    [app.state.history, app.clock, span, bucketSeconds],
  );
  const changes = useMemo(() => changesInWindow(app.state.changes, app.clock, span), [app.state.changes, app.clock, span]);
  const items = changeLogItems(log);

  async function chooseCsv() {
    if (app.meterImport.status !== 'picking') {
      app.openMeterImport();
    }
    try {
      const csv = await pickCsvText();
      if (csv === null) {
        return;
      }
      await app.submitMeterCsv(csv);
    } catch (reason: unknown) {
      app.failMeterImport(reason instanceof Error ? reason.message : 'Could not read that file.');
    }
  }

  function closeImport() {
    if (app.meterImport.status === 'picking') {
      app.cancelMeterImport();
      return;
    }
    if (app.meterImport.status === 'done' || app.meterImport.status === 'error') {
      app.dismissMeterImport();
    }
  }

  const header = (
    <View style={styles.header}>
      <Text style={styles.title}>History</Text>
      <Text style={styles.body}>
        {app.state.mode === 'demo'
          ? 'Simulated room readings. Coral lines are setpoint changes.'
          : 'Meter readings stored by the shared server. Coral lines are setpoint changes.'}
      </Text>
      <View style={styles.segment}>
        <Segment label="Day" testID="history-day" on={span === 'day'} onPress={() => setSpan('day')} />
        <Segment label="Week" testID="history-week" on={span === 'week'} onPress={() => setSpan('week')} />
        <Segment label="Month" testID="history-month" on={span === 'month'} onPress={() => setSpan('month')} />
      </View>
      <Text style={styles.body}>{spanCaption(span)}</Text>
      <PillButton label="Import CSV" testID="history-import" onPress={app.openMeterImport} />
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
      {load.status === 'loading' ? <Text style={styles.body}>Loading readings.</Text> : null}
      {load.status === 'error' ? (
        <View style={styles.errorRow}>
          <Text style={[styles.error, styles.grow]}>{load.message}</Text>
          <Pressable
            accessibilityRole="button"
            testID="history-retry"
            onPress={() => dispatchLoad({ type: 'fetch', span })}
            style={styles.inlineButton}
          >
            <Text style={styles.inlineButtonText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}
      {samples.length === 0 && load.status !== 'loading' ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No readings in this window</Text>
          <Text style={styles.body}>Pull to refresh on Home, or wait for the server meter.</Text>
        </View>
      ) : null}
      {samples.length > 0 ? (
        <HistoryChart
          samples={samples}
          changes={changes}
          metric={metric}
          bucketSeconds={bucketSeconds}
          events={app.state.events}
        />
      ) : null}
      <Text style={styles.section}>Setpoint changes</Text>
      <Text style={styles.body}>Newest first, from all stored history.</Text>
    </View>
  );

  return (
    <View style={styles.screen}>
      <FlatList
        data={items}
        keyExtractor={(item, index) => `${changeKey(item)}-${index}`}
        renderItem={({ item }) => <ChangeRow change={item} events={app.state.events} />}
        ListHeaderComponent={header}
        ListFooterComponent={
          <ChangeLogFooter
            log={log}
            onMore={() => dispatchLog({ type: 'more' })}
            onRetry={() => dispatchLog({ type: 'retry' })}
          />
        }
        contentContainerStyle={[styles.content, { paddingTop: Math.max(insets.top, 16), paddingBottom: 96 }]}
        initialNumToRender={CHANGE_LOG_PAGE_SIZE}
        windowSize={9}
      />
      <MeterImportSheet state={app.meterImport} onChoose={() => void chooseCsv()} onClose={closeImport} />
    </View>
  );
}

function newestAt(changes: SetpointChange[]): number | null {
  let newest: number | null = null;
  for (const change of changes) {
    const time = Date.parse(change.at);
    if (Number.isFinite(time) && (newest === null || time > newest)) {
      newest = time;
    }
  }
  return newest;
}

function ChangeRow({ change, events }: { change: SetpointChange; events: ScheduleEvent[] }) {
  return (
    <View testID="history-marker" style={styles.marker}>
      <Text style={styles.markerTitle}>{change.label}</Text>
      <Text style={styles.body}>
        {change.setpoint}° · {formatReadoutTime(change.at)} · {describeChangeSource(change, events)}
      </Text>
    </View>
  );
}

function ChangeLogFooter({ log, onMore, onRetry }: { log: ChangeLog; onMore: () => void; onRetry: () => void }) {
  const count = changeLogItems(log).length;
  if (log.status === 'idle' || (log.status === 'loading' && count === 0)) {
    return (
      <View testID="history-changes-loading" style={styles.footerRow}>
        <ActivityIndicator color={colors.muted} />
        <Text style={styles.body}>Loading setpoint changes.</Text>
      </View>
    );
  }
  if (log.status === 'loading') {
    return (
      <View style={styles.footer}>
        <PillButton label="Loading older changes" tone="ghost" disabled testID="history-changes-loading-more" onPress={onMore} />
      </View>
    );
  }
  if (log.status === 'loaded') {
    return (
      <View style={styles.footer}>
        <Text style={styles.footnote}>Showing the newest {count}.</Text>
        <PillButton label="Load older changes" tone="ghost" testID="history-changes-more" onPress={onMore} />
      </View>
    );
  }
  if (log.status === 'error') {
    return (
      <View testID="history-changes-error" style={styles.footerError}>
        <Text style={styles.error}>
          {count === 0 ? "Couldn't load setpoint changes. " : "Couldn't load older changes. "}
          {log.message}
        </Text>
        <PillButton label="Try again" testID="history-changes-retry" onPress={onRetry} />
      </View>
    );
  }
  return (
    <View testID="history-changes-end" style={styles.footer}>
      <Text style={styles.footnote}>
        {count === 0 ? 'No thermostat changes yet.' : `That is every change. ${count} in all.`}
      </Text>
    </View>
  );
}

function spanCaption(span: HistorySpan): string {
  if (span === 'day') {
    return 'Last 24 hours.';
  }
  if (span === 'week') {
    return 'Last 7 days.';
  }
  return 'Last 30 days.';
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
  header: { gap: 12 },
  title: { color: colors.text, fontFamily: fonts.displayStrong, fontSize: 36 },
  body: { color: colors.muted, fontFamily: fonts.body, fontSize: 14, lineHeight: 20 },
  error: { color: colors.poor, fontFamily: fonts.body, fontSize: 14, lineHeight: 20 },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  grow: { flex: 1 },
  inlineButton: {
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inlineButtonText: { color: colors.text, fontFamily: fonts.medium, fontSize: 13 },
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
  empty: { backgroundColor: colors.card, borderRadius: 16, padding: 16, gap: 6 },
  emptyTitle: { color: colors.text, fontFamily: fonts.semibold, fontSize: 18 },
  marker: { backgroundColor: colors.card, borderRadius: 14, padding: 12, gap: 4 },
  markerTitle: { color: colors.text, fontFamily: fonts.semibold, fontSize: 16 },
  footer: { gap: 8, paddingTop: 4 },
  footerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  footerError: {
    gap: 10,
    padding: 12,
    borderRadius: 14,
    backgroundColor: 'rgba(225,106,92,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(225,106,92,0.35)',
  },
  footnote: { color: colors.faint, fontFamily: fonts.body, fontSize: 13, textAlign: 'center' },
});
