import { useGame } from '../state/store.ts';
import { badges } from './badges.ts';
import { isSeedVaultDevice, ONCHAIN_STAKES_ENABLED, shellDeviceModel } from './config.ts';
import './badges.css';

/** The wallet and device badges (badges.ts), from the store's wallet status and the shell's user agent. */
export function Badges({ provedThisRound = false, className = '' }: { provedThisRound?: boolean; className?: string }) {
  const status = useGame((s) => s.walletStatus);
  const list = badges({
    seekerToken: status?.seeker?.mint ?? null,
    provedThisRound,
    seedVaultDevice: isSeedVaultDevice(),
    deviceModel: shellDeviceModel(),
    skrBalance: status?.skrBalance != null ? BigInt(status.skrBalance) : null,
    stakesEnabled: ONCHAIN_STAKES_ENABLED,
  });
  if (!list.length) return null;
  return (
    <ul className={`badges ${className}`.trim()} aria-label="Wallet badges">
      {list.map((b) => (
        <li key={b.id} className={`badge badge--${b.id}`} title={b.detail}>
          {b.label}
        </li>
      ))}
    </ul>
  );
}
