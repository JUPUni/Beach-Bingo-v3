import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Ribbon } from './kit.tsx';
import './stage.css';

/** Parchment-on-planks modal with the green ribbon header from the Island kit. */
export function Popup({
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: string;
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const host = document.querySelector('.stage') ?? document.body;
  return createPortal(
    <div
      className="popup-layer"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className={`popup anim-pop ${wide ? 'popup--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <Ribbon onClose={onClose}>{title}</Ribbon>
        <div className="popup__frame wood-plank">
          <div className="popup__paper parchment scroll">{children}</div>
        </div>
        {footer && <div className="popup__footer">{footer}</div>}
      </div>
    </div>,
    host,
  );
}
