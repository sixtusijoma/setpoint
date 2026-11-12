import { DatePickerSheet } from '@/components/date-picker-sheet';
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
import { changeKey, type HistorySpan, type SetpointChange } from '@/domain/history';
import {
  canStepBack,
  canStepForward,
  etDay,
  HISTORY_SPANS,
  historyWindow,
  initialHistoryView,
  localWindowData,
  reduceHistoryView,
  viewWindow,
  windowLabel,
  type HistoryWindow,
} from '@/domain/historyWindow';
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
  const [metric, setMetric] = useState<ChartMetric>('temperatureF');
  const [view, dispatchView] = useReducer(reduceHistoryView, undefined, initialHistoryView);
  const [log, dispatchLog] = useReducer(reduceChangeLog, undefined, idleChangeLog);
  const [picking, setPicking] = useState(false);
  const liveServer = app.serverConfigured && app.state.mode === 'live';
  const today = etDay(app.clock);
  const lastDay = viewWindow(view, today).lastDay;
  const period = useMemo(() => historyWindow(view.span, lastDay), [view.span, lastDay]);
  const current = lastDay === today;

  useFocusEffect(
    useCallback(() => {
      dispatchView(liveServer ? { type: 'fetch', window: period } : { type: 'off' });
    }, [liveServer, period]),
  );

  const refetchAfterImport = useEffectEvent(() => {
    if (liveServer) {
      dispatchView({ type: 'fetch', window: period });
    }
  });
  useEffect(() => {
    if (app.meterImport.status === 'done') {
      refetchAfterImport();
    }
  }, [app.meterImport]);

  const loading = view.load.status === 'loading' ? view.load : null;
  const runLoad = useEffectEvent((request: number, target: HistoryWindow) => {
    app.loadHistoryWindow(target, target.lastDay >= today).then(
      (data) => dispatchView({ type: 'loaded', request, data, today }),
      (reason: unknown) =>
        dispatchView({
          type: 'fail',
          request,
          message: reason instanceof Error ? reason.message : 'History could not be loaded.',
        }),
    );
  });
  useEffect(() => {
    if (loading) {
      runLoad(loading.request, loading.window);
    }
  }, [loading]);

  const localData = useMemo(
    () => (liveServer ? null : localWindowData(app.state.history, app.state.changes, period)),
    [liveServer, app.state.history, app.state.changes, period],
  );
  const localFirstAt = localData?.firstAt ?? null;
  useEffect(() => {
    if (!liveServer) {
      dispatchView({ type: 'bounds', firstAt: localFirstAt, today });
    }
  }, [liveServer, localFirstAt, today]);
  const data = liveServer
    ? view.load.status === 'ready' && view.load.window.key === period.key
      ? view.load.data
      : null
    : localData;
  const samples = data?.samples ?? [];
  const changes = data?.changes ?? [];
  const domain = useMemo(() => ({ startMs: period.startMs, endMs: period.endMs }), [period]);
  const waiting = liveServer && (view.load.status === 'loading' || (view.load.status === 'ready' && data === null));
  const failed = liveServer && view.load.status === 'error' ? view.load.message : null;

  const source = liveServer ? 'server' : 'local';
  useEffect(() => {
    dispatchLog({ type: 'reset' });
  }, [source]);

  const headAt = Math.max(newestAt(app.state.changes) ?? -Infinity, newestAt(changes) ?? -Infinity);
  const refreshLog = useEffectEvent(() => {
    const listHead = changeLogItems(log)[0];
    const listHeadAt = listHead ? Date.parse(listHead.at) : null;
    if (Number.isFinite(headAt) && log.status !== 'loading' && (listHeadAt === null || headAt > listHeadAt)) {
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
        <StepArrow
          glyph="‹"
          label={`Previous ${view.span}`}
          testID="history-prev"
          disabled={!canStepBack(view, today)}
          onPress={() => dispatchView({ type: 'step', by: -1, today })}
        />
        {HISTORY_SPANS.map((item) => (
          <Segment
            key={item.id}
            label={item.label}
            testID={`history-${item.id}`}
            on={view.span === item.id}
            onPress={() => dispatchView({ type: 'span', span: item.id, today })}
          />
        ))}
        <StepArrow
          glyph="›"
          label={`Next ${view.span}`}
          testID="history-next"
          disabled={!canStepForward(view, today)}
          onPress={() => dispatchView({ type: 'step', by: 1, today })}
        />
      </View>
      <View style={styles.rangeRow}>
        <Pressable
          testID="history-range"
          accessibilityRole="button"
          accessibilityHint="Opens a calendar to jump to a date"
          onPress={() => setPicking(true)}
          style={({ pressed }) => [styles.range, pressed && styles.pressed]}
        >
          <Text testID="history-range-label" style={styles.rangeText}>
            {windowLabel(period)}
          </Text>
          <Text style={styles.rangeHint}>{rangeHint(view.span, current)}</Text>
        </Pressable>
        {current ? null : (
          <Pressable
            testID="history-now"
            accessibilityRole="button"
            onPress={() => dispatchView({ type: 'now' })}
            style={styles.inlineButton}
          >
            <Text style={styles.inlineButtonText}>Now</Text>
          </Pressable>
        )}
      </View>
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
      {failed !== null ? (
        <View style={styles.errorRow}>
          <Text testID="history-load-error" style={[styles.error, styles.grow]}>
            {failed}
          </Text>
          <Pressable
            accessibilityRole="button"
            testID="history-retry"
            onPress={() => dispatchView({ type: 'fetch', window: period })}
            style={styles.inlineButton}
          >
            <Text style={styles.inlineButtonText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}
      {waiting ? (
        <View testID="history-chart-loading" style={styles.placeholder}>
          <ActivityIndicator color={colors.muted} />
          <Text style={styles.body}>Loading readings for {windowLabel(period)}.</Text>
        </View>
      ) : null}
      {data !== null && samples.length === 0 ? (
        <View testID="history-empty" style={styles.empty}>
          <Text style={styles.emptyTitle}>No readings in this window</Text>
          <Text style={styles.body}>
            {current
              ? 'Pull to refresh on Home, or wait for the server meter.'
              : 'Nothing was stored for these dates. Step forward, or pick another date.'}
          </Text>
        </View>
      ) : null}
      {data !== null && samples.length > 0 ? (
        <HistoryChart
          samples={samples}
          changes={changes}
          metric={metric}
          bucketSeconds={data.bucketSeconds}
          events={app.state.events}
          domain={domain}
          current={current}
          withYear={period.span === 'year' || period.firstDay.slice(0, 4) !== today.slice(0, 4)}
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
        renderItem={({ item }) => <ChangeRow change={item} events={app.state.events} thisYear={today.slice(0, 4)} />}
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
      <DatePickerSheet
        visible={picking}
        selected={period.lastDay}
        earliestDay={view.earliestDay}
        today={today}
        onPick={(date) => {
          setPicking(false);
          dispatchView({ type: 'jump', date, today });
        }}
        onClose={() => setPicking(false)}
      />
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

function ChangeRow({ change, events, thisYear }: { change: SetpointChange; events: ScheduleEvent[]; thisYear: string }) {
  const withYear = etDay(change.at).slice(0, 4) !== thisYear;
  return (
    <View testID="history-marker" style={styles.marker}>
      <Text style={styles.markerTitle}>{change.label}</Text>
      <Text style={styles.body}>
        {change.setpoint}° · {formatReadoutTime(change.at, { withYear })} · {describeChangeSource(change, events)}
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

function rangeHint(span: HistorySpan, current: boolean): string {
  const unit = span === 'day' ? 'Today' : `This ${span}, through today`;
  return current ? `${unit} · Tap to pick a date` : 'Tap to pick a date';
}

function StepArrow({
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
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.arrow, disabled && styles.arrowOff, pressed && !disabled && styles.pressed]}
    >
      <Text style={styles.arrowText}>{glyph}</Text>
    </Pressable>
  );
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
  arrow: {
    width: 36,
    minHeight: 44,
    borderRadius: 12,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowOff: { opacity: 0.35 },
  arrowText: { color: colors.text, fontFamily: fonts.medium, fontSize: 22, lineHeight: 26 },
  pressed: { opacity: 0.7 },
  rangeRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  range: { flex: 1, gap: 2 },
  rangeText: { color: colors.text, fontFamily: fonts.semibold, fontSize: 16 },
  rangeHint: { color: colors.muted, fontFamily: fonts.body, fontSize: 13 },
  placeholder: {
    minHeight: 360,
    backgroundColor: colors.card,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 16,
  },
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
