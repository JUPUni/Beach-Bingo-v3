import React from 'react';
import type { BingoCard } from '../types/game';
import './BingoCardTable.css';

interface BingoCardTableProps {
  card: BingoCard;
  onCellClick: (row: number, col: number) => void;
}

const COLUMN_HEADERS = ['B', 'I', 'N', 'G', 'O'];

export const BingoCardTable: React.FC<BingoCardTableProps> = ({ card, onCellClick }) => {
  return (
    <div className="bingo-card">
      <div className="bingo-header">
        {COLUMN_HEADERS.map((letter) => (
          <div key={letter} className="bingo-header-cell">
            {letter}
          </div>
        ))}
      </div>
      <div className="bingo-grid">
        {card.cells.map((row, rowIndex) =>
          row.map((cell, colIndex) => (
            <button
              key={`${rowIndex}-${colIndex}`}
              className={`bingo-cell ${cell.isMarked ? 'marked' : ''} ${
                cell.isFree ? 'free' : ''
              }`}
              onClick={() => onCellClick(rowIndex, colIndex)}
              disabled={cell.isFree}
            >
              {cell.isFree ? 'FREE' : cell.number}
            </button>
          ))
        )}
      </div>
    </div>
  );
};
