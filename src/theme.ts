import type { setpointAccent } from '@/domain/temperature';

export const colors = {
  outer: '#070A09',
  bg: '#0E1412',
  card: '#1A221C',
  raised: '#24302A',
  text: '#F6F1E7',
  muted: '#A8A093',
  faint: '#6E6960',
  line: 'rgba(246,241,231,0.10)',
  coral: '#FF7A45',
  blue: '#7EB6FF',
  neutral: '#E4D2B0',
  good: '#7DCEA0',
  moderate: '#E6B15C',
  poor: '#E16A5C',
};

export const fonts = {
  display: 'Fraunces_500Medium',
  displayStrong: 'Fraunces_600SemiBold',
  body: 'Outfit_400Regular',
  medium: 'Outfit_500Medium',
  semibold: 'Outfit_600SemiBold',
};

type Accent = ReturnType<typeof setpointAccent>;

export function accentColor(kind: Accent): string {
  if (kind === 'above') {
    return colors.coral;
  }
  if (kind === 'below') {
    return colors.blue;
  }
  return colors.neutral;
}

export function toneColor(tone: 'good' | 'moderate' | 'poor'): string {
  if (tone === 'good') {
    return colors.good;
  }
  if (tone === 'moderate') {
    return colors.moderate;
  }
  return colors.poor;
}
