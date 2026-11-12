import type { HistorySample, SetpointChange } from '@/domain/history';
import { colors } from '@/theme';
import { useState } from 'react';
import { LayoutChangeEvent, View } from 'react-native';
import Svg, { Circle, Line, Polyline } from 'react-native-svg';

type Metric = 'temperatureF' | 'humidity' | 'co2Ppm';

export function HistoryChart({
  samples,
  changes,
  metric,
}: {
  samples: HistorySample[];
  changes: SetpointChange[];
  metric: Metric;
}) {
  const [width, setWidth] = useState(320);
  const height = 168;
  const pad = 12;
  const onLayout = (event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  };
  const values = samples.map((sample) => sample[metric]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const start = Date.parse(samples[0]?.at ?? '');
  const end = Date.parse(samples[samples.length - 1]?.at ?? '');
  const timeSpan = Math.max(1, end - start);
  const xFor = (iso: string) => {
    const ratio = (Date.parse(iso) - start) / timeSpan;
    return pad + ratio * Math.max(1, width - pad * 2);
  };
  const yFor = (value: number) => {
    const ratio = (value - min) / span;
    return height - pad - ratio * (height - pad * 2);
  };
  const points = samples.map((sample) => `${xFor(sample.at)},${yFor(sample[metric])}`).join(' ');
  return (
    <View testID="history-chart" onLayout={onLayout}>
      <Svg width={width} height={height}>
        <Line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke={colors.line} strokeWidth={1} />
        <Polyline points={points} fill="none" stroke={colors.neutral} strokeWidth={2} />
        {changes.map((change) => (
          <Line
            key={`${change.at}-${change.label}`}
            x1={xFor(change.at)}
            x2={xFor(change.at)}
            y1={pad}
            y2={height - pad}
            stroke={colors.coral}
            strokeWidth={1}
          />
        ))}
        {samples.length > 0 ? (
          <Circle
            cx={xFor(samples[samples.length - 1].at)}
            cy={yFor(samples[samples.length - 1][metric])}
            r={4}
            fill={colors.text}
          />
        ) : null}
      </Svg>
    </View>
  );
}
