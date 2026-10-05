import { GreenButton } from '../../ui/kit.tsx';

/**
 * The host's "Verify Seeker" while the escrow is open: one tap sends `prove_seeker_room` /
 * `prove_seeker_hall` with the Seeker Genesis Token the app found in the wallet; the program
 * checks it and lowers the round's fee to the Seeker tier. Nothing to press when the wallet has
 * no token, and a line instead of a button once the proof has landed.
 */
export function VerifySeeker({ proved, available, busy, onProve }: { proved: boolean; available: boolean; busy: boolean; onProve(): void }) {
  if (proved) return <p className="small-note">Seeker verified for this round ✓ — the Seeker fee tier applies.</p>;
  if (!available) return null;
  return (
    <GreenButton tone="blue" disabled={busy} onClick={onProve}>
      Verify Seeker · lower the fee
    </GreenButton>
  );
}
