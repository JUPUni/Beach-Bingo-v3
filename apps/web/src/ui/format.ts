import { letterFor } from '@beach-bingo/engine';

export function formatCoins(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 100_000) return `${Math.floor(n / 1000)}K`;
  return n.toLocaleString('en-US');
}

const BALL_COLORS: Record<string, string> = {
  B: '#2f7de1',
  I: '#e8313a',
  N: '#8d5bd6',
  G: '#2fb34a',
  O: '#ff8a00',
};

export function ballColor(n: number, variant: string): string {
  if (variant === '75') return BALL_COLORS[letterFor(n)] ?? '#2f7de1';
  const palette = ['#2f7de1', '#e8313a', '#8d5bd6', '#2fb34a', '#ff8a00', '#12a6b8', '#e04fa0', '#6b8f0f', '#c9571b'];
  return palette[Math.floor((n - 1) / 10) % palette.length]!;
}
