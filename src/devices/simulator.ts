import { co2ForBand, type Co2Tone } from '@/domain/co2';

export type ClimateState = {
  temperatureF: number;
  humidity: number;
  co2Ppm: number;
  updatedAt: string;
  batteryUp: number | null;
  batteryDown: number | null;
  batteryMeter: number | null;
  co2Lock: Co2Tone | null;
  failNextPress: boolean;
};

export function initialClimate(nowIso: string): ClimateState {
  return {
    temperatureF: 68.4,
    humidity: 47,
    co2Ppm: 740,
    updatedAt: nowIso,
    batteryUp: 86,
    batteryDown: 74,
    batteryMeter: 91,
    co2Lock: null,
    failNextPress: false,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

export function driftClimate(
  climate: ClimateState,
  nowIso: string,
  random: () => number = Math.random,
): ClimateState {
  const nudge = (span: number) => (random() - 0.5) * 2 * span;
  const temperatureF = clamp(Math.round((climate.temperatureF + nudge(0.3)) * 10) / 10, 55, 85);
  const humidity = clamp(Math.round(climate.humidity + nudge(2)), 25, 75);
  let co2Ppm = climate.co2Ppm;
  if (climate.co2Lock) {
    co2Ppm = co2ForBand(climate.co2Lock);
  } else {
    co2Ppm = clamp(Math.round(climate.co2Ppm + nudge(30)), 450, 1800);
  }
  return {
    ...climate,
    temperatureF,
    humidity,
    co2Ppm,
    updatedAt: nowIso,
  };
}
