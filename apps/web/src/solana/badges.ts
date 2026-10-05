/**
 * The badges the wallet popup and the stake panels show for the connected wallet and the device
 * (docs/plans/2026-10-05-tokens-design.md §5). They describe; they never grant: the fee tier
 * comes from the program checking the Seeker Genesis Token itself, the shop's saving from the
 * same accounts passed with the purchase, and the SKR preselection costs nothing.
 */
export interface BadgeInput {
  /** The wallet's Seeker Genesis Token mint, when the app found one of the configured group. */
  seekerToken: string | null;
  /** The host proved that token to the program for the round on screen. */
  provedThisRound?: boolean;
  /** The Android shell reported the Seed Vault (`SeedVault/1` in the user agent), with the model when it gave one. */
  seedVaultDevice: boolean;
  deviceModel?: string | null;
  /** Base units of SKR held, or null when unknown. */
  skrBalance: bigint | null;
}

export type BadgeId = 'seeker' | 'seedVault' | 'skr';

export interface Badge {
  id: BadgeId;
  label: string;
  /** The one line behind the badge. */
  detail: string;
}

export function badges(input: BadgeInput): Badge[] {
  const out: Badge[] = [];
  if (input.seekerToken) {
    out.push({
      id: 'seeker',
      label: input.provedThisRound ? 'Seeker verified · proved this round' : 'Seeker verified',
      detail: input.provedThisRound
        ? 'The program checked your Seeker Genesis Token for this round: the Seeker fee tier applies.'
        : 'A Seeker Genesis Token of the configured group is in this wallet. Prove it to the program for the Seeker fee tier.',
    });
  }
  if (input.seedVaultDevice) {
    out.push({
      id: 'seedVault',
      label: input.deviceModel ? `Seed Vault device (${input.deviceModel})` : 'Seed Vault device',
      detail: 'The app shell found the Seed Vault on this phone. A hint for the layout; nothing of value hangs on it.',
    });
  }
  if (input.skrBalance !== null && input.skrBalance > 0n) {
    out.push({ id: 'skr', label: 'SKR ready', detail: 'This wallet holds SKR: the stake picker and the shop start on SKR, the cheapest tier.' });
  }
  return out;
}
