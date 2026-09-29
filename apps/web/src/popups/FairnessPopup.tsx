import { useMemo, useState } from 'react';
import { FairRng, commitSeed, range, shuffle, verifyCommitment } from '@beach-bingo/engine';
import { roundHistory } from '../lib/fair.ts';
import { sfx } from '../lib/audio.ts';
import { useGame } from '../state/store.ts';
import { GreenButton } from '../ui/kit.tsx';
import { toast } from '../ui/toast.ts';
import { Popup } from '../ui/Popup.tsx';
import './popups.css';

export default function FairnessPopup() {
  const fairness = useGame((s) => s.fairness);
  const setClientSeed = useGame((s) => s.setClientSeed);
  const rotateSeeds = useGame((s) => s.rotateSeeds);
  const close = useGame((s) => s.closePopup);
  const [client, setClient] = useState(fairness.clientSeed);
  const [nonce, setNonce] = useState(0);
  const [domain, setDomain] = useState('tidePool:draw');
  const previous = fairness.previous;
  const history = roundHistory();

  const verified = useMemo(() => {
    if (!previous) return null;
    const seed = { serverSeed: previous.serverSeed, clientSeed: previous.clientSeed, nonce };
    return {
      commitmentOk: verifyCommitment(previous.serverSeed, commitSeed(previous.serverSeed)),
      balls: shuffle(range(1, 75), new FairRng(seed, domain)).slice(0, 15),
    };
  }, [previous, nonce, domain]);

  return (
    <Popup title="Provably Fair" onClose={close} wide>
      <p className="small-note">
        Every result = HMAC-SHA256(server seed, [client seed, nonce, game:stream, block]) → rejection sampling → Fisher–Yates. The
        server seed is hidden but <b>committed</b> (hashed) before you play.
      </p>
      <h3>Server seed commitment</h3>
      <p className="mono">{fairness.commitment}</p>
      <h3>Your client seed</h3>
      <div className="seed-row">
        <input className="field" value={client} onChange={(e) => setClient(e.target.value.slice(0, 64))} aria-label="Client seed" />
        <button
          type="button"
          className="chip-opt"
          onClick={() => {
            setClientSeed(client.trim() || fairness.clientSeed);
            sfx.click();
            toast('Client seed updated');
          }}
        >
          Save
        </button>
      </div>
      <p className="small-note">Next round nonce: {fairness.nonce}</p>
      <GreenButton
        tone="gold"
        onClick={() => {
          rotateSeeds();
          toast('Seeds rotated — the old server seed is now revealed');
        }}
      >
        Rotate &amp; reveal
      </GreenButton>

      {previous && verified && (
        <>
          <div className="divider" />
          <h3>Verify previous seed</h3>
          <p className="mono">server seed: {previous.serverSeed}</p>
          <p className="small-note">
            SHA-256 matches its commitment: <b>{verified.commitmentOk ? 'yes ✓' : 'NO ✗'}</b> · rounds 0–{previous.lastNonce}
          </p>
          <div className="seed-row">
            <select className="field" value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Stream">
              {['tidePool:draw', 'riptide:drum', 'crabDig:layout', 'shellSpin:reels', 'videoBingo:drum', 'keno:draw', 'blitz:draw'].map(
                (d) => (
                  <option key={d}>{d}</option>
                ),
              )}
            </select>
            <input
              className="field"
              type="number"
              min={0}
              max={Math.max(0, previous.lastNonce)}
              value={nonce}
              onChange={(e) => setNonce(Math.max(0, Number(e.target.value) || 0))}
              aria-label="Nonce"
            />
          </div>
          <p className="small-note">First 15 values of that stream shuffled over 1–75:</p>
          <p className="mono">{verified.balls.join(', ')}</p>
        </>
      )}

      {history.length > 0 && (
        <>
          <div className="divider" />
          <h3>This session</h3>
          <ul className="round-log">
            {history.slice(0, 8).map((r) => (
              <li key={`${r.commitment}-${r.nonce}`}>
                <b>#{r.nonce}</b> {r.mode} — {r.summary || '…'}
              </li>
            ))}
          </ul>
        </>
      )}
    </Popup>
  );
}
