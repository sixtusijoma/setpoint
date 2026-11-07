import { colors, fonts } from '@/theme';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

const SIZE = 268;
const STROKE = 10;
const RADIUS = (SIZE - STROKE) / 2;
const CIRC = 2 * Math.PI * RADIUS;
const ARC = CIRC * 0.72;

export function SetpointDial({
  setpoint,
  ratio,
  color,
  caption,
}: {
  setpoint: number;
  ratio: number;
  color: string;
  caption: string;
}) {
  const clamped = Math.min(1, Math.max(0, ratio));
  const dash = ARC * clamped;
  return (
    <View style={styles.wrap} accessibilityLabel={`Setpoint ${setpoint} degrees`}>
      <View style={styles.arc} pointerEvents="none">
        <Svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
          <Circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            stroke="rgba(246,241,231,0.10)"
            strokeWidth={STROKE}
            fill="none"
            strokeDasharray={`${ARC} ${CIRC - ARC}`}
            strokeLinecap="round"
          />
          <Circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            stroke={color}
            strokeWidth={STROKE}
            fill="none"
            strokeDasharray={`${dash} ${CIRC - dash}`}
            strokeLinecap="round"
          />
        </Svg>
      </View>
      <View style={styles.center} pointerEvents="none">
        <View style={styles.numberRow}>
          <Text testID="setpoint-value" style={styles.number}>
            {setpoint}
          </Text>
          <Text style={[styles.degree, { color }]}>°</Text>
        </View>
        <Text style={styles.caption}>{caption}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: SIZE,
    height: SIZE,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
  },
  arc: {
    transform: [{ rotate: '140deg' }],
  },
  center: {
    position: 'absolute',
    alignItems: 'center',
  },
  numberRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  number: {
    color: colors.text,
    fontFamily: fonts.display,
    fontSize: 104,
    lineHeight: 108,
    fontVariant: ['tabular-nums'],
    letterSpacing: -2,
  },
  degree: {
    fontFamily: fonts.display,
    fontSize: 36,
    marginTop: 16,
  },
  caption: {
    color: colors.muted,
    fontFamily: fonts.medium,
    fontSize: 12,
    letterSpacing: 2.4,
    textTransform: 'uppercase',
    marginTop: -4,
  },
});
