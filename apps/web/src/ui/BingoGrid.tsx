import { memo, type CSSProperties } from 'react';
import { BINGO_LETTERS, BLANK, FREE, type BingoCard } from '@beach-bingo/engine';
import './grid.css';

export interface BingoGridProps {
  card: BingoCard;
  /** Bit mask of daubed cells. */
  marked: number;
  /** Cells to glow (winning shape). */
  highlight?: readonly number[];
  /** Cells that can be tapped right now (wild targets, crab pinch). */
  targets?: number;
  /** Cells whose number has been called but not daubed (hint mode). */
  hints?: number;
  onCell?: (index: number) => void;
  size?: 'lg' | 'md' | 'sm' | 'xs';
  header?: boolean;
  label?: string;
  dimmed?: boolean;
}

const HEADER_COLORS = ['#2f7de1', '#e8313a', '#8d5bd6', '#2fb34a', '#ff8a00'];

export const BingoGrid = memo(function BingoGrid({
  card,
  marked,
  highlight,
  targets = 0,
  hints = 0,
  onCell,
  size = 'md',
  header = card.variant === '75',
  label,
  dimmed,
}: BingoGridProps) {
  const glow = new Set(highlight ?? []);
  return (
    <div
      className={`grid grid--${size} grid--v${card.variant} ${dimmed ? 'grid--dim' : ''}`}
      style={{ '--cols': card.cols } as CSSProperties}
      aria-label={label ?? 'Bingo card'}
    >
      {header && (
        <div className="grid__header">
          {BINGO_LETTERS.map((letter, i) => (
            <span key={letter} style={{ background: HEADER_COLORS[i] }}>
              {letter}
            </span>
          ))}
        </div>
      )}
      <div className="grid__cells">
        {card.cells.map((value, i) => {
          if (value === BLANK) return <div key={i} className="cell cell--blank" />;
          const isMarked = (marked & (1 << i)) !== 0;
          const isTarget = (targets & (1 << i)) !== 0;
          const isHint = (hints & (1 << i)) !== 0 && !isMarked;
          const cls = [
            'cell',
            value === FREE && 'cell--free',
            isMarked && 'cell--marked',
            glow.has(i) && 'cell--glow',
            isTarget && 'cell--target',
            isHint && 'cell--hint',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <button
              key={i}
              type="button"
              className={cls}
              disabled={!onCell}
              onPointerDown={onCell ? () => onCell(i) : undefined}
              aria-label={value === FREE ? 'Free space' : `${value}${isMarked ? ', daubed' : ''}`}
              aria-pressed={isMarked}
            >
              {value === FREE ? <span className="cell__free">🌴</span> : <span className="cell__num">{value}</span>}
              {isMarked && value !== FREE && <i className="cell__daub" />}
            </button>
          );
        })}
      </div>
    </div>
  );
});
