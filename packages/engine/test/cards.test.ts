import { describe, expect, it } from 'vitest';
import {
  BLANK,
  FREE,
  PATTERNS_30,
  PATTERNS_75,
  PATTERNS_90,
  cellsToGo,
  countLines5x5,
  fastRng,
  fullMask,
  generateCard,
  isComplete,
  letterFor,
  markedMask,
  playableMask,
  winningCells,
} from '../src/index.ts';

const rng = fastRng('cards');

describe('card generation', () => {
  it('75-ball cards respect B-I-N-G-O column ranges with a free centre', () => {
    for (let t = 0; t < 500; t++) {
      const card = generateCard('75', rng);
      expect(card.cells[12]).toBe(FREE);
      const numbers = card.cells.filter((n) => n > 0);
      expect(new Set(numbers).size).toBe(24);
      card.cells.forEach((n, i) => {
        if (i === 12) return;
        const col = i % 5;
        expect(n).toBeGreaterThanOrEqual(col * 15 + 1);
        expect(n).toBeLessThanOrEqual(col * 15 + 15);
      });
    }
    expect(letterFor(1)).toBe('B');
    expect(letterFor(45)).toBe('N');
    expect(letterFor(75)).toBe('O');
  });

  it('90-ball tickets have 15 numbers, 5 per row, 1–3 per column, ascending columns', () => {
    for (let t = 0; t < 3000; t++) {
      const card = generateCard('90', rng);
      const numbers = card.cells.filter((n) => n > 0);
      expect(numbers).toHaveLength(15);
      expect(new Set(numbers).size).toBe(15);
      for (let r = 0; r < 3; r++) {
        expect(card.cells.slice(r * 9, r * 9 + 9).filter((n) => n !== BLANK)).toHaveLength(5);
      }
      for (let c = 0; c < 9; c++) {
        const column = [0, 1, 2].map((r) => card.cells[r * 9 + c]!).filter((n) => n !== BLANK);
        expect(column.length).toBeGreaterThanOrEqual(1);
        expect(column.length).toBeLessThanOrEqual(3);
        expect([...column].sort((a, b) => a - b)).toEqual(column);
        const lo = c === 0 ? 1 : c * 10;
        const hi = c === 8 ? 90 : c * 10 + 9;
        for (const n of column) {
          expect(n).toBeGreaterThanOrEqual(lo);
          expect(n).toBeLessThanOrEqual(hi);
        }
      }
    }
  });

  it('30-ball and video cards use sorted column bands', () => {
    const speed = generateCard('30', rng);
    expect(speed.cells).toHaveLength(9);
    const video = generateCard('video', rng);
    expect(video.cells).toHaveLength(15);
    for (let c = 0; c < 5; c++) {
      const column = [0, 1, 2].map((r) => video.cells[r * 5 + c]!);
      expect([...column].sort((a, b) => a - b)).toEqual(column);
      for (const n of column) {
        expect(n).toBeGreaterThanOrEqual(c * 12 + 1);
        expect(n).toBeLessThanOrEqual(c * 12 + 12);
      }
    }
  });
});

describe('patterns', () => {
  const card = generateCard('75', fastRng('pattern-card'));
  const playable = playableMask(card);

  it('detects rows, columns and diagonals (free centre counts)', () => {
    const row2 = [10, 11, 13, 14].map((i) => card.cells[i]!);
    expect(isComplete(markedMask(card, row2), PATTERNS_75.line, playable)).toBe(true);
    const diag = [0, 6, 18, 24].map((i) => card.cells[i]!);
    expect(isComplete(markedMask(card, diag), PATTERNS_75.line, playable)).toBe(true);
    expect(isComplete(markedMask(card, diag.slice(0, 3)), PATTERNS_75.line, playable)).toBe(false);
    expect(cellsToGo(markedMask(card, diag.slice(0, 3)), PATTERNS_75.line, playable)).toBe(1);
  });

  it('two lines needs two distinct complete lines', () => {
    const row0 = [0, 1, 2, 3, 4].map((i) => card.cells[i]!);
    const row4 = [20, 21, 22, 23, 24].map((i) => card.cells[i]!);
    expect(isComplete(markedMask(card, row0), PATTERNS_75.twoLines, playable)).toBe(false);
    expect(isComplete(markedMask(card, [...row0, ...row4]), PATTERNS_75.twoLines, playable)).toBe(true);
    // Cheapest second line is the N column: it shares row 0's cell and the free centre.
    expect(cellsToGo(markedMask(card, row0), PATTERNS_75.twoLines, playable)).toBe(3);
  });

  it('four corners, blackout and winning cells', () => {
    const corners = [0, 4, 20, 24].map((i) => card.cells[i]!);
    const marked = markedMask(card, corners);
    expect(isComplete(marked, PATTERNS_75.fourCorners, playable)).toBe(true);
    expect(winningCells(marked, PATTERNS_75.fourCorners, playable)).toEqual([0, 4, 20, 24]);
    expect(isComplete(marked, PATTERNS_75.blackout, playable)).toBe(false);
    expect(countLines5x5(fullMask(5, 5))).toBe(12);
    expect(countLines5x5(1 << 12)).toBe(0);
  });

  it('90-ball lines ignore blank squares', () => {
    const ticket = generateCard('90', fastRng('ticket'));
    const play = playableMask(ticket);
    const topRow = ticket.cells.slice(0, 9).filter((n) => n > 0);
    const marked = markedMask(ticket, topRow);
    expect(isComplete(marked, PATTERNS_90.oneLine, play)).toBe(true);
    expect(isComplete(marked, PATTERNS_90.twoLines, play)).toBe(false);
    expect(isComplete(markedMask(ticket, ticket.cells.filter((n) => n > 0)), PATTERNS_90.fullHouse, play)).toBe(true);
    expect(cellsToGo(marked, PATTERNS_90.twoLines, play)).toBe(5);
  });

  it('30-ball full house', () => {
    const speed = generateCard('30', fastRng('speed'));
    const all = speed.cells.filter((n) => n > 0);
    expect(isComplete(markedMask(speed, all), PATTERNS_30.fullHouse, playableMask(speed))).toBe(true);
    expect(isComplete(markedMask(speed, all.slice(1)), PATTERNS_30.fullHouse, playableMask(speed))).toBe(false);
  });
});
