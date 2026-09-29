export interface BingoCell {
  number: number;
  isMarked: boolean;
  isFree?: boolean;
}

export interface BingoCard {
  cells: BingoCell[][];
}

export interface GameState {
  card: BingoCard;
  calledNumbers: number[];
  currentNumber: number | null;
  isWinner: boolean;
  gameStarted: boolean;
}

export type WinPattern = 'row' | 'column' | 'diagonal' | 'full-card';
