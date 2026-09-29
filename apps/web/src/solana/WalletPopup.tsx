import { useGame } from '../state/store.ts';
import { Popup } from '../ui/Popup.tsx';

export default function WalletPopup() {
  const close = useGame((s) => s.closePopup);
  return (
    <Popup title="Wallet" onClose={close}>
      <p>Solana wallet support is loading…</p>
    </Popup>
  );
}
