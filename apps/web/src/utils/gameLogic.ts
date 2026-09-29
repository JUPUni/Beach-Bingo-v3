import type { BingoCard, BingoCell } from '../types/game';

// Bingo number ranges for each column
const COLUMN_RANGES = {
  B: [1, 15],
  I: [16, 30],
  N: [31, 45],
  G: [46, 60],
  O: [61, 75]
} as const;

/**
 * Generates a random number within a specified range (inclusive)
 */
function getRandomNumber(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generates unique numbers for a column
 */
function generateColumnNumbers(min: number, max: number, count: number): number[] {
  const numbers = new Set<number>();
  
  while (numbers.size < count) {
    numbers.add(getRandomNumber(min, max));
  }
  
  return Array.from(numbers);
}

/**
 * Creates a new Bingo card with random numbers
 */
export function createBingoCard(): BingoCard {
  const cells: BingoCell[][] = [];
  
  // Generate numbers for each column
  const columnNumbers = {
    B: generateColumnNumbers(...COLUMN_RANGES.B, 5),
    I: generateColumnNumbers(...COLUMN_RANGES.I, 5),
    N: generateColumnNumbers(...COLUMN_RANGES.N, 5),
    G: generateColumnNumbers(...COLUMN_RANGES.G, 5),
    O: generateColumnNumbers(...COLUMN_RANGES.O, 5)
  };
  
  // Create 5x5 grid
  for (let row = 0; row < 5; row++) {
    cells[row] = [];
    for (let col = 0; col < 5; col++) {
      const columnKey = ['B', 'I', 'N', 'G', 'O'][col] as keyof typeof columnNumbers;
      const number = columnNumbers[columnKey][row];
      
      cells[row][col] = {
        number,
        isMarked: false,
        isFree: row === 2 && col === 2 // Center cell is free
      };
    }
  }
  
  // Mark the center cell as free
  cells[2][2].isMarked = true;
  
  return { cells };
}

/**
 * Checks if there's a winning pattern on the card
 */
export function checkWinCondition(card: BingoCard): boolean {
  const { cells } = card;
  
  // Check rows
  for (let row = 0; row < 5; row++) {
    if (cells[row].every(cell => cell.isMarked)) {
      return true;
    }
  }
  
  // Check columns
  for (let col = 0; col < 5; col++) {
    if (cells.every(row => row[col].isMarked)) {
      return true;
    }
  }
  
  // Check diagonals
  const leftDiagonal = [0, 1, 2, 3, 4].every(i => cells[i][i].isMarked);
  const rightDiagonal = [0, 1, 2, 3, 4].every(i => cells[i][4 - i].isMarked);
  
  return leftDiagonal || rightDiagonal;
}

/**
 * Generates a random Bingo number that hasn't been called yet
 */
export function generateNextNumber(calledNumbers: number[]): number | null {
  const allNumbers = Array.from({ length: 75 }, (_, i) => i + 1);
  const availableNumbers = allNumbers.filter(num => !calledNumbers.includes(num));
  
  if (availableNumbers.length === 0) {
    return null; // All numbers have been called
  }
  
  const randomIndex = Math.floor(Math.random() * availableNumbers.length);
  return availableNumbers[randomIndex];
}

/**
 * Gets the letter prefix for a Bingo number
 */
export function getNumberPrefix(number: number): string {
  if (number >= 1 && number <= 15) return 'B';
  if (number >= 16 && number <= 30) return 'I';
  if (number >= 31 && number <= 45) return 'N';
  if (number >= 46 && number <= 60) return 'G';
  if (number >= 61 && number <= 75) return 'O';
  return '';
}
