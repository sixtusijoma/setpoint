import {
  bucketLabel,
  chartGeometry,
  dataSignature,
  describeChangeSource,
  focusWithin,
  formatAxis,
  formatMetric,
  formatReadoutTime,
  formatTooltipTime,
  idleFocus,
  pickAt,
  reduceChartFocus,
  snappedMarker,
  timeTicks,
  type ChartDomain,
  type ChartFrame,
  type ChartGeometry,
  type ChartMetric,
  type ChartTick,
} from '@/domain/chart';
import { DAY_BUCKET_SECONDS, type HistorySample, type SetpointChange } from '@/domain/history';
import type { ScheduleEvent } from '@/domain/schedule';
import { selectionFeedback } from '@/haptics';
import { colors, fonts } from '@/theme';
import { memo, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import {
  GestureDetector,
  useCompetingGestures,
  usePanGesture,
  useTapGesture,
  type PanGestureConfig,
  type TapGestureConfig,
} from 'react-native-gesture-handler';
import Svg, { Circle, Line, Polyline } from 'react-native-svg';

const HEIGHT = 196;
const TIP_WIDTH = 172;
const TICK_WIDTH = 52;
const MARKER_SLOP = 12;
const FRAME: Omit<ChartFrame, 'width'> = { height: HEIGHT, top: 34, bottom: 8, left: 4, right: 48 };
// Web only. GestureDetector's touchAction prop is wiped when RNGH applies a gesture config, which
// left touch-action: none on the chart and blocked vertical page scrolls that start on it.
const PAGE_SCROLLS = { touchAction: 'pan-y' } as const;

export function HistoryChart({
  samples,
  changes,
  metric,
  bucketSeconds,
  events,
  domain,
  current,
  withYear,
}: {
  samples: HistorySample[];
  changes: SetpointChange[];
  metric: ChartMetric;
  bucketSeconds: number;
  events: ScheduleEvent[];
  domain: ChartDomain;
  current: boolean;
  withYear: boolean;
}) {
  const [width, setWidth] = useState(320);
  const [stored, dispatch] = useReducer(reduceChartFocus, undefined, idleFocus);
  const signature = dataSignature(samples, changes);
  const [seenSignature, setSeenSignature] = useState(signature);
  if (seenSignature !== signature) {
    setSeenSignature(signature);
    dispatch({ type: 'data' });
  }
  const focus = focusWithin(stored, samples.length, changes.length);
  const geometry = useMemo(
    () => chartGeometry(samples, changes, metric, { ...FRAME, width }, domain),
    [samples, changes, metric, width, domain],
  );
  const ticks = useMemo(() => timeTicks(geometry), [geometry]);

  const lastMarker = useRef<number | null>(null);
  useEffect(() => {
    if (snappedMarker(lastMarker.current, focus)) {
      selectionFeedback();
    }
    lastMarker.current = focus.kind === 'idle' ? null : focus.marker;
  }, [focus]);

  // Stable configs keep RNGH from re-sending them to the handlers on every scrub frame.
  const geometryRef = useRef(geometry);
  useEffect(() => {
    geometryRef.current = geometry;
  }, [geometry]);
  const configs = useMemo(() => {
    const send = (type: 'scrub' | 'tap', x: number) => {
      const pick = pickAt(geometryRef.current, x, MARKER_SLOP);
      if (pick) {
        dispatch({ type, pick });
      }
    };
    const pan: PanGestureConfig = {
      ...PAGE_SCROLLS,
      runOnJS: true,
      activeOffsetX: [-6, 6],
      failOffsetY: [-14, 14],
      onActivate: (event) => send('scrub', event.x),
      onUpdate: (event) => send('scrub', event.x),
      onFinalize: () => dispatch({ type: 'release' }),
    };
    const tap: TapGestureConfig = {
      ...PAGE_SCROLLS,
      runOnJS: true,
      maxDistance: 10,
      onActivate: (event) => send('tap', event.x),
    };
    return { pan, tap };
  }, []);
  const gesture = useCompetingGestures(usePanGesture(configs.pan), useTapGesture(configs.tap));

  const latest = samples[samples.length - 1];
  const shown = focus.kind === 'idle' ? latest : samples[focus.sample];
  const marker = focus.kind !== 'idle' && focus.marker !== null ? changes[focus.marker] : undefined;
  const crossX = focus.kind === 'idle' ? null : geometry.xs[focus.sample];
  const crossY = focus.kind === 'idle' ? null : geometry.ys[focus.sample];
  const markerX = marker && focus.kind !== 'idle' ? geometry.markers.find((item) => item.change === focus.marker)?.x : undefined;
  const lineX = markerX ?? crossX ?? 0;
  const tipLeft = Math.min(Math.max(0, lineX - TIP_WIDTH / 2), Math.max(0, geometry.plotRight - TIP_WIDTH));
  const rangeMs = geometry.endMs - geometry.startMs;
  const daily = bucketSeconds >= DAY_BUCKET_SECONDS;
  const readout = (at: string | undefined) => formatReadoutTime(at ?? '', { withYear, daily });
  const restingLabel = current ? 'the latest reading' : 'the last reading in this range';

  const onLayout = (event: LayoutChangeEvent) => {
    setWidth(Math.max(120, Math.round(event.nativeEvent.layout.width)));
  };

  return (
    <View style={styles.card}>
      <Text testID="history-chart-value" style={styles.value}>
        {formatMetric(metric, shown?.[metric] ?? 0)}
      </Text>
      <Text testID="history-chart-caption" style={styles.caption}>
        {focus.kind === 'idle'
          ? `${current ? 'Latest' : 'Last in range'} · ${readout(latest?.at)}`
          : `${readout(shown?.at)} · ${bucketLabel(bucketSeconds)}`}
      </Text>
      <View onLayout={onLayout}>
        <GestureDetector gesture={gesture}>
          <View
            testID="history-chart"
            style={styles.plot}
            accessibilityLabel={`Chart from ${formatAxis(metric, geometry.min)} to ${formatAxis(metric, geometry.max)}, ${changes.length} setpoint changes. Drag to read values.`}
          >
            <ChartBase geometry={geometry} ticks={ticks} width={width} metric={metric} />
            {crossX !== null && crossY !== null && crossX !== undefined && crossY !== undefined ? (
              <View style={styles.overlay}>
                <Svg width={width} height={HEIGHT}>
                  {markerX !== undefined ? (
                    <Line
                      x1={markerX}
                      x2={markerX}
                      y1={geometry.plotTop}
                      y2={geometry.plotBottom}
                      stroke={colors.coral}
                      strokeWidth={3}
                    />
                  ) : null}
                  <Line
                    x1={crossX}
                    x2={crossX}
                    y1={geometry.plotTop - 4}
                    y2={geometry.plotBottom}
                    stroke={colors.text}
                    strokeOpacity={0.55}
                    strokeWidth={1}
                  />
                  <Circle cx={crossX} cy={crossY} r={5} fill={colors.text} stroke={colors.card} strokeWidth={2} />
                </Svg>
                <View
                  testID="history-chart-tooltip"
                  style={[styles.tip, { left: tipLeft }, marker ? styles.tipMarker : null]}
                >
                  <Text style={styles.tipValue} numberOfLines={1}>
                    {formatMetric(metric, shown?.[metric] ?? 0)}
                    <Text style={styles.tipTime}> · {formatTooltipTime(shown?.at ?? '', rangeMs, bucketSeconds)}</Text>
                  </Text>
                </View>
              </View>
            ) : null}
          </View>
        </GestureDetector>
        <TickRow ticks={ticks} width={width} />
      </View>
      {marker ? (
        <View testID="history-chart-detail" style={styles.detail}>
          <View style={styles.detailBar} />
          <View style={styles.detailText}>
            <Text style={styles.detailTitle}>{marker.label}</Text>
            <Text style={styles.detailBody}>
              Set to {marker.setpoint}° · {formatReadoutTime(marker.at, { withYear })} · {describeChangeSource(marker, events)}
            </Text>
          </View>
        </View>
      ) : (
        <Text testID="history-chart-hint" style={styles.hint}>
          {focus.kind === 'scrubbing'
            ? `Release to go back to ${restingLabel}.`
            : focus.kind === 'pinned'
              ? `Tap the same spot again to go back to ${restingLabel}.`
              : 'Drag across the chart to read a value. Tap a coral line to see that change.'}
        </Text>
      )}
    </View>
  );
}

const ChartBase = memo(function ChartBase({
  geometry,
  ticks,
  width,
  metric,
}: {
  geometry: ChartGeometry;
  ticks: ChartTick[];
  width: number;
  metric: ChartMetric;
}) {
  const last = geometry.xs.length - 1;
  return (
    <View style={styles.overlay}>
      <Svg width={width} height={HEIGHT}>
        {ticks.map((tick) => (
          <Line
            key={`grid-${tick.x}`}
            x1={tick.x}
            x2={tick.x}
            y1={geometry.plotTop}
            y2={geometry.plotBottom}
            stroke={colors.line}
            strokeWidth={1}
          />
        ))}
        <Line
          x1={geometry.plotLeft}
          y1={geometry.plotTop}
          x2={geometry.plotRight}
          y2={geometry.plotTop}
          stroke={colors.line}
          strokeWidth={1}
          strokeDasharray="3 4"
        />
        <Line
          x1={geometry.plotLeft}
          y1={geometry.plotBottom}
          x2={geometry.plotRight}
          y2={geometry.plotBottom}
          stroke={colors.line}
          strokeWidth={1}
        />
        <Polyline points={geometry.points} fill="none" stroke={colors.neutral} strokeWidth={2} strokeLinejoin="round" />
        {geometry.markers.map((marker) => (
          <Line
            key={`marker-${marker.change}`}
            x1={marker.x}
            x2={marker.x}
            y1={geometry.plotTop}
            y2={geometry.plotBottom}
            stroke={colors.coral}
            strokeWidth={1}
          />
        ))}
        {last >= 0 ? <Circle cx={geometry.xs[last]} cy={geometry.ys[last]} r={4} fill={colors.text} /> : null}
      </Svg>
      <Text style={[styles.axis, { top: geometry.plotTop - 8 }]}>{formatAxis(metric, geometry.max)}</Text>
      <Text style={[styles.axis, { top: geometry.plotBottom - 9 }]}>{formatAxis(metric, geometry.min)}</Text>
    </View>
  );
});

const TickRow = memo(function TickRow({ ticks, width }: { ticks: ChartTick[]; width: number }) {
  return (
    <View style={styles.ticks}>
      {ticks.map((tick) => (
        <Text
          key={`tick-${tick.x}`}
          numberOfLines={1}
          style={[styles.tick, { left: Math.min(Math.max(0, tick.x - TICK_WIDTH / 2), Math.max(0, width - FRAME.right - TICK_WIDTH / 2)) }]}
        >
          {tick.label}
        </Text>
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: 16, padding: 12, gap: 4 },
  value: { color: colors.text, fontFamily: fonts.display, fontSize: 32, fontVariant: ['tabular-nums'] },
  caption: { color: colors.muted, fontFamily: fonts.body, fontSize: 13, lineHeight: 18 },
  plot: { height: HEIGHT },
  overlay: { ...StyleSheet.absoluteFill, pointerEvents: 'none' },
  axis: {
    position: 'absolute',
    right: 0,
    width: FRAME.right - 6,
    textAlign: 'right',
    color: colors.muted,
    fontFamily: fonts.medium,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  ticks: { height: 18, marginTop: 2, pointerEvents: 'none' },
  tick: {
    position: 'absolute',
    width: TICK_WIDTH,
    textAlign: 'center',
    color: colors.faint,
    fontFamily: fonts.medium,
    fontSize: 11,
  },
  tip: {
    position: 'absolute',
    top: 2,
    width: TIP_WIDTH,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.neutral,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  tipMarker: { borderColor: colors.coral },
  tipValue: { color: colors.text, fontFamily: fonts.semibold, fontSize: 13, fontVariant: ['tabular-nums'] },
  tipTime: { color: colors.muted, fontFamily: fonts.medium, fontSize: 12 },
  detail: {
    flexDirection: 'row',
    gap: 10,
    minHeight: 56,
    marginTop: 4,
    padding: 10,
    borderRadius: 12,
    backgroundColor: colors.raised,
  },
  detailBar: { width: 3, borderRadius: 2, backgroundColor: colors.coral },
  detailText: { flex: 1, gap: 2 },
  detailTitle: { color: colors.text, fontFamily: fonts.semibold, fontSize: 15 },
  detailBody: { color: colors.muted, fontFamily: fonts.body, fontSize: 13, lineHeight: 18 },
  hint: {
    minHeight: 56,
    marginTop: 4,
    paddingVertical: 10,
    color: colors.faint,
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 18,
  },
});
