export type Co2Tone = 'good' | 'moderate' | 'poor';

export function co2Band(ppm: number): { label: string; tone: Co2Tone } {
  if (ppm < 800) {
    return { label: 'Good', tone: 'good' };
  }
  if (ppm <= 1200) {
    return { label: 'Moderate', tone: 'moderate' };
  }
  return { label: 'Poor', tone: 'poor' };
}

export function co2ForBand(tone: Co2Tone): number {
  if (tone === 'good') {
    return 640;
  }
  if (tone === 'moderate') {
    return 960;
  }
  return 1480;
}
