import React, { useState, useCallback } from 'react';
import type { GameState } from '../types/game';
import { createBingoCard, checkWinCondition, generateNextNumber } from '../utils/gameLogic';
import { BingoCardTable } from './BingoCardTable';
import { NumberCaller } from './NumberCaller';
import './BingoGame.css';

export const BingoGame: React.FC = () => {
  const [gameState, setGameState] = useState<GameState>(() => ({
    card: createBingoCard(),
    calledNumbers: [],
    currentNumber: null,
    isWinner: false,
    gameStarted: false
  }));

  const handleCellClick = useCallback((row: number, col: number) => {
    if (gameState.isWinner || !gameState.gameStarted) return;

    setGameState(prevState => {
      const newCard = {
        cells: prevState.card.cells.map((cellRow, rowIndex) =>
          cellRow.map((cell, colIndex) => {
            if (rowIndex === row && colIndex === col && !cell.isFree) {
              // Only allow marking if the number has been called
              const wasNumberCalled = prevState.calledNumbers.includes(cell.number);
              return wasNumberCalled ? { ...cell, isMarked: !cell.isMarked } : cell;
            }
            return cell;
          })
        )
      };

      const isWinner = checkWinCondition(newCard);
      
      return {
        ...prevState,
        card: newCard,
        isWinner
      };
    });
  }, [gameState.isWinner, gameState.gameStarted]);

  const handleCallNumber = useCallback(() => {
    if (gameState.isWinner) return;

    setGameState(prevState => {
      const nextNumber = generateNextNumber(prevState.calledNumbers);
      
      if (nextNumber === null) {
        // No more numbers to call
        return prevState;
      }

      return {
        ...prevState,
        calledNumbers: [...prevState.calledNumbers, nextNumber],
        currentNumber: nextNumber,
        gameStarted: true
      };
    });
  }, [gameState.isWinner]);

  const handleNewGame = useCallback(() => {
    setGameState({
      card: createBingoCard(),
      calledNumbers: [],
      currentNumber: null,
      isWinner: false,
      gameStarted: false
    });
  }, []);

  return (
    <div className="bingo-game">
      <header className="game-header">
        <h1>🎯 BINGO GAME</h1>
        <button className="new-game-button" onClick={handleNewGame}>
          New Game
        </button>
      </header>

      <div className="game-content">
        <div className="game-section">
          <NumberCaller
            currentNumber={gameState.currentNumber}
            calledNumbers={gameState.calledNumbers}
            onCallNumber={handleCallNumber}
            gameStarted={gameState.gameStarted}
            isWinner={gameState.isWinner}
          />
        </div>

        <div className="game-section">
          <BingoCardTable
            card={gameState.card}
            onCellClick={handleCellClick}
          />
        </div>
      </div>

      {gameState.isWinner && (
        <div className="winner-overlay">
          <div className="winner-message">
            <h2>🎉 BINGO! 🎉</h2>
            <p>Congratulations! You won!</p>
            <button className="play-again-button" onClick={handleNewGame}>
              Play Again
            </button>
          </div>
        </div>
      )}

      <div className="game-instructions">
        <h3>How to Play:</h3>
        <ul>
          <li>Click "Start Game" to begin calling numbers</li>
          <li>Mark numbers on your card when they are called</li>
          <li>Get 5 in a row (horizontal, vertical, or diagonal) to win!</li>
          <li>The center square is FREE and already marked</li>
        </ul>
      </div>
    </div>
  );
};
