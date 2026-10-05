import { lazy } from 'react';
import { useGame } from '../state/store.ts';
import { SettingsPopup, ProfilePopup, TasksPopup, FaucetPopup, ChestPopup, LimitsPopup, CreditsPopup, AgeGatePopup } from './Popups.tsx';

const FairnessPopup = lazy(() => import('./FairnessPopup.tsx'));
const WalletPopup = lazy(() => import('../solana/WalletPopup.tsx'));
const ShopPopup = lazy(() => import('./ShopPopup.tsx'));

export function PopupHost() {
  const popup = useGame((s) => s.popup);
  switch (popup) {
    case 'settings':
      return <SettingsPopup />;
    case 'profile':
      return <ProfilePopup />;
    case 'tasks':
      return <TasksPopup />;
    case 'faucet':
      return <FaucetPopup />;
    case 'chest':
      return <ChestPopup />;
    case 'limits':
      return <LimitsPopup />;
    case 'credits':
      return <CreditsPopup />;
    case 'fairness':
      return <FairnessPopup />;
    case 'wallet':
      return <WalletPopup />;
    case 'shop':
      return <ShopPopup />;
    case 'age':
      return <AgeGatePopup />;
    default:
      return null;
  }
}
