import { letterFor } from '@beach-bingo/engine';
import { useGame } from '../state/store.ts';

/**
 * All sound is synthesised with WebAudio (no audio files to download or license):
 * short SFX, a gentle steel-drum loop, and a spoken ball caller via speechSynthesis.
 */
let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function audio(): { ctx: AudioContext; out: GainNode } | null {
  if (typeof window === 'undefined' || !('AudioContext' in window)) return null;
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return { ctx, out: master! };
}

const soundOn = () => useGame.getState().settings.sound;

interface ToneOpts {
  freq: number;
  to?: number;
  type?: OscillatorType;
  dur?: number;
  gain?: number;
  delay?: number;
  attack?: number;
}

function tone({ freq, to, type = 'sine', dur = 0.15, gain = 0.3, delay = 0, attack = 0.005 }: ToneOpts) {
  const a = audio();
  if (!a) return;
  const t = a.ctx.currentTime + delay;
  const osc = a.ctx.createOscillator();
  const g = a.ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(a.out);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

function noise(dur = 0.2, gain = 0.2, delay = 0, filterFreq = 800) {
  const a = audio();
  if (!a) return;
  const t = a.ctx.currentTime + delay;
  const buffer = a.ctx.createBuffer(1, Math.ceil(a.ctx.sampleRate * dur), a.ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = a.ctx.createBufferSource();
  src.buffer = buffer;
  const filter = a.ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = filterFreq;
  const g = a.ctx.createGain();
  g.gain.value = gain;
  src.connect(filter).connect(g).connect(a.out);
  src.start(t);
}

function vibrate(pattern: number | number[]) {
  if (!useGame.getState().settings.haptics) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}

const NOTE = (n: number) => 440 * 2 ** ((n - 69) / 12);

export const sfx = {
  unlock() {
    audio();
  },
  click() {
    if (!soundOn()) return;
    tone({ freq: 660, to: 880, type: 'triangle', dur: 0.06, gain: 0.15 });
  },
  ball() {
    if (!soundOn()) return;
    tone({ freq: 320, to: 620, type: 'sine', dur: 0.18, gain: 0.3 });
    tone({ freq: 900, type: 'triangle', dur: 0.08, gain: 0.08, delay: 0.1 });
  },
  daub() {
    if (!soundOn()) return;
    tone({ freq: 520, to: 260, type: 'square', dur: 0.07, gain: 0.08 });
    noise(0.05, 0.12, 0, 2400);
    vibrate(12);
  },
  miss() {
    if (!soundOn()) return;
    tone({ freq: 180, to: 120, type: 'sawtooth', dur: 0.12, gain: 0.06 });
  },
  coin() {
    if (!soundOn()) return;
    tone({ freq: NOTE(88), type: 'square', dur: 0.08, gain: 0.07 });
    tone({ freq: NOTE(93), type: 'square', dur: 0.22, gain: 0.07, delay: 0.07 });
  },
  reel() {
    if (!soundOn()) return;
    tone({ freq: 1200, type: 'triangle', dur: 0.02, gain: 0.05 });
  },
  win() {
    if (!soundOn()) return;
    [72, 76, 79, 84].forEach((n, i) => tone({ freq: NOTE(n), type: 'triangle', dur: 0.25, gain: 0.18, delay: i * 0.09 }));
    vibrate([30, 40, 30]);
  },
  bingo() {
    if (!soundOn()) return;
    [67, 72, 76, 79, 84, 88].forEach((n, i) => {
      tone({ freq: NOTE(n), type: 'triangle', dur: 0.32, gain: 0.2, delay: i * 0.08 });
      tone({ freq: NOTE(n - 12), type: 'sine', dur: 0.32, gain: 0.1, delay: i * 0.08 });
    });
    noise(0.6, 0.05, 0.45, 5000);
    vibrate([40, 50, 40, 50, 120]);
  },
  lose() {
    if (!soundOn()) return;
    [64, 60, 57, 52].forEach((n, i) => tone({ freq: NOTE(n), type: 'triangle', dur: 0.3, gain: 0.14, delay: i * 0.14 }));
  },
  shark() {
    if (!soundOn()) return;
    tone({ freq: 110, to: 40, type: 'sawtooth', dur: 0.6, gain: 0.25 });
    noise(0.5, 0.25, 0, 400);
    vibrate([80, 40, 160]);
  },
  cashout() {
    if (!soundOn()) return;
    [79, 84, 91].forEach((n, i) => tone({ freq: NOTE(n), type: 'square', dur: 0.12, gain: 0.07, delay: i * 0.06 }));
    vibrate(25);
  },
};

/* ---------- Music: a soft steel-drum calypso loop ---------- */
let musicTimer: number | null = null;
let musicStep = 0;
const MELODY = [72, null, 76, 79, null, 76, 74, null, 72, null, 74, 76, null, 72, 69, null];
const BASS = [48, 55, 53, 55];

function playStep() {
  const a = audio();
  if (!a) return;
  const note = MELODY[musicStep % MELODY.length];
  if (note) {
    tone({ freq: NOTE(note), type: 'sine', dur: 0.35, gain: 0.05 });
    tone({ freq: NOTE(note) * 2.01, type: 'sine', dur: 0.2, gain: 0.015 });
  }
  if (musicStep % 4 === 0) tone({ freq: NOTE(BASS[(musicStep / 4) % BASS.length]!), type: 'triangle', dur: 0.5, gain: 0.05 });
  if (musicStep % 2 === 1) noise(0.04, 0.015, 0, 6000);
  musicStep++;
}

export function setMusic(on: boolean) {
  if (on && musicTimer === null) {
    musicTimer = window.setInterval(playStep, 220);
  } else if (!on && musicTimer !== null) {
    window.clearInterval(musicTimer);
    musicTimer = null;
  }
}

/* ---------- Ball caller voice ---------- */
export function callBall(ball: number, variant: '75' | '90' | '30' | 'video' = '75') {
  const { voice, sound } = useGame.getState().settings;
  if (!voice || !sound || typeof speechSynthesis === 'undefined') return;
  try {
    speechSynthesis.cancel();
    const text = variant === '75' ? `${letterFor(ball)} ${ball}` : String(ball);
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.15;
    utterance.pitch = 1.05;
    utterance.volume = 0.9;
    speechSynthesis.speak(utterance);
  } catch {
    /* speech unavailable */
  }
}

export function say(text: string) {
  const { voice, sound } = useGame.getState().settings;
  if (!voice || !sound || typeof speechSynthesis === 'undefined') return;
  try {
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  } catch {
    /* speech unavailable */
  }
}
