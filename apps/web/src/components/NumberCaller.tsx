import React from 'react';
import { getNumberPrefix } from '../utils/gameLogic';
import './NumberCaller.css';

interface NumberCallerProps {
  currentNumber: number | null;
  calledNumbers: number[];
  onCallNumber: () => void;
  gameStarted: boolean;
  isWinner: boolean;
}

export const NumberCaller: React.FC<NumberCallerProps> = ({
  currentNumber,
  calledNumbers,
  onCallNumber,
  gameStarted,
  isWinner
}) => {
  return (
    <div className="number-caller">
      <div className="current-number">
        {currentNumber ? (
          <>
            <span className="number-prefix">{getNumberPrefix(currentNumber)}</span>
            <span className="number-value">{currentNumber}</span>
          </>
        ) : (
          <span className="no-number">
            {gameStarted ? (isWinner ? 'BINGO!' : 'Game Over') : 'Ready to Play'}
          </span>
        )}
      </div>
      
      <button
        className="call-button"
        onClick={onCallNumber}
        disabled={isWinner || (gameStarted && calledNumbers.length >= 75)}
      >
        {!gameStarted
          ? 'Start Game'
          : isWinner
          ? 'You Won!'
          : calledNumbers.length >= 75
          ? 'Game Over'
          : 'Call Next Number'
        }
      </button>
      
      <div className="called-numbers">
        <h3>Called Numbers ({calledNumbers.length}/75)</h3>
        <div className="numbers-grid">
          {calledNumbers
            .sort((a, b) => b - a) // Show most recent first
            .map((number) => (
              <span key={number} className="called-number">
                {getNumberPrefix(number)}{number}
              </span>
            ))}
        </div>
      </div>
    </div>
  );
};
