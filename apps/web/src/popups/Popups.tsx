import { useState } from 'react';
import { useNow } from '../lib/hooks.ts';
import { adventure } from '@beach-bingo/engine';
import { art } from '../assets/art.ts';
import { sfx } from '../lib/audio.ts';
import { CHEST_KEYS, DAILY_TASKS, FAUCET_COOLDOWN_MS, FAUCET_SHELLS, FOLLOW_URL, SPEND_CAP_OPTIONS, TABLES, TABLE_NAME, useGame } from '../state/store.ts';
import { Confetti, GreenButton, RoundButton, ShellIcon } from '../ui/kit.tsx';
import { formatCoins } from '../ui/format.ts';
import { toast } from '../ui/toast.ts';
import { Popup } from '../ui/Popup.tsx';
import './popups.css';

function Toggle({ on, onChange, label }: { on: boolean; onChange(v: boolean): void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className="toggle"
      onClick={() => {
        sfx.click();
        onChange(!on);
      }}
    />
  );
}

export function SettingsPopup() {
  const settings = useGame((s) => s.settings);
  const setSetting = useGame((s) => s.setSetting);
  const openPopup = useGame((s) => s.openPopup);
  const close = useGame((s) => s.closePopup);
  return (
    <Popup title="Settings" onClose={close}>
      <div className="settings-icons">
        <label>
          <RoundButton
            img={art.iconBtnSound}
            label="Sound"
            size={4.4}
            className={settings.sound ? '' : 'is-off'}
            onClick={() => setSetting('sound', !settings.sound)}
          />
          <span>Sound</span>
        </label>
        <label>
          <RoundButton
            img={art.iconBtnMusic}
            label="Music"
            size={4.4}
            className={settings.music ? '' : 'is-off'}
            onClick={() => setSetting('music', !settings.music)}
          />
          <span>Music</span>
        </label>
        <label>
          <RoundButton img={art.iconBtnProfile} label="Edit profile" size={4.4} onClick={() => openPopup('profile')} />
          <span>Profile</span>
        </label>
      </div>
      <div className="divider" />
      <div className="popup-row">
        <span>Ball caller voice</span>
        <Toggle on={settings.voice} label="Ball caller voice" onChange={(v) => setSetting('voice', v)} />
      </div>
      <div className="popup-row">
        <span>Vibration</span>
        <Toggle on={settings.haptics} label="Vibration" onChange={(v) => setSetting('haptics', v)} />
      </div>
      <div className="popup-row">
        <span>Reduce motion</span>
        <Toggle on={settings.reduceMotion} label="Reduce motion" onChange={(v) => setSetting('reduceMotion', v)} />
      </div>
      <div className="divider" />
      <div className="settings-links">
        <button type="button" onClick={() => openPopup('wallet')}>
          ◎ Solana wallet
        </button>
        <button type="button" onClick={() => openPopup('fairness')}>
          🔐 Provably fair
        </button>
        <button type="button" onClick={() => openPopup('limits')}>
          🛟 Responsible play
        </button>
        <button type="button" onClick={() => openPopup('credits')}>
          🌴 Credits &amp; legal
        </button>
      </div>
    </Popup>
  );
}

const AVATARS = ['🦀', '🐠', '🐬', '🦈', '🐙', '🐢', '🦩', '🐚', '🦜', '🏄', '🐳', '🌴'];

export function ProfilePopup() {
  const profile = useGame((s) => s.profile);
  const setProfile = useGame((s) => s.setProfile);
  const openPopup = useGame((s) => s.openPopup);
  const close = useGame((s) => s.closePopup);
  // The Seeker ID stands in for the name while its wallet is linked; the picked name waits underneath for when it is not.
  const seekerId = useGame((s) => (s.seekerLink?.name && s.linkedWallet !== null && s.seekerLink.wallet === s.linkedWallet ? s.seekerLink.name : null));
  const [name, setName] = useState(profile.name);
  const [avatar, setAvatar] = useState(profile.avatar);
  return (
    <Popup
      title="Edit Profile"
      onClose={close}
      footer={
        <GreenButton
          onClick={() => {
            setProfile({ name: name.trim().slice(0, 18) || 'Beachcomber', avatar });
            toast('Profile saved', 'win');
            close();
          }}
        >
          Accept
        </GreenButton>
      }
    >
      {seekerId ? (
        <>
          <h3>Your name</h3>
          <div className="profile__seeker">
            <b className="profile__seeker-name">{seekerId}</b>
            <small>
              Your Seeker ID is your name while the Seeker is linked. To play under another name, unlink the wallet in{' '}
              <button type="button" className="profile__seeker-link" onClick={() => openPopup('wallet')}>
                Settings → Solana wallet
              </button>
              .
            </small>
          </div>
        </>
      ) : (
        <>
          <h3>Change name</h3>
          <input className="field" value={name} maxLength={18} onChange={(e) => setName(e.target.value)} aria-label="Player name" />
        </>
      )}
      <h3>Change picture</h3>
      <div className="avatar-grid">
        {AVATARS.map((a) => (
          <button
            key={a}
            type="button"
            className={`avatar-grid__item ${a === avatar ? 'is-on' : ''}`}
            onClick={() => (sfx.click(), setAvatar(a))}
            aria-label={`Avatar ${a}`}
          >
            {a}
          </button>
        ))}
      </div>
    </Popup>
  );
}

export function TasksPopup() {
  const tasks = useGame((s) => s.tasks);
  const stars = useGame((s) => s.stars);
  const claimTask = useGame((s) => s.claimTask);
  const close = useGame((s) => s.closePopup);
  const today = new Date().toLocaleDateString('en-CA');
  const fresh = tasks.day === today;
  const levelsDone = Object.values(stars).filter((s) => s > 0).length;
  return (
    <Popup title="Tasks" onClose={close}>
      <div className="task task--world">
        <div>
          <b>World progress</b>
          <div className="progress">
            <i style={{ width: `${(levelsDone / adventure.LEVELS.length) * 100}%` }} />
            <span>
              {levelsDone}/{adventure.LEVELS.length}
            </span>
          </div>
        </div>
        <img src={art.iconChestSmall} alt="" />
      </div>
      <div className="divider" />
      {DAILY_TASKS.map((t) => {
        const progress = fresh ? tasks.progress[t.id] : 0;
        const claimed = fresh && tasks.claimed.includes(t.id);
        const done = progress >= t.goal;
        return (
          <div key={t.id} className="task">
            <div>
              <b>{t.label}</b>
              <div className="progress">
                <i style={{ width: `${Math.min(1, progress / t.goal) * 100}%` }} />
                <span>
                  {Math.min(progress, t.goal)}/{t.goal}
                </span>
              </div>
            </div>
            <button
              type="button"
              className={`task__claim ${done && !claimed ? 'is-ready anim-pulse' : ''}`}
              disabled={!done || claimed}
              onClick={() => {
                if (claimTask(t.id)) {
                  sfx.coin();
                  toast(`+${t.reward} shells`, 'win');
                }
              }}
            >
              {claimed ? '✓' : `+${t.reward}`}
            </button>
          </div>
        );
      })}
      <p className="small-note">Tasks pay shells and reset every day at midnight.</p>
      <div className="divider" />
      <h3>Rewards</h3>
      <FollowReward />
    </Popup>
  );
}

/**
 * Follow @mostlyjola on X for one Free Game ticket (a coin-table entry at the mode's base
 * price). The follow link opens in a new tab (the Android shell hands it to the X app); when the
 * page comes back the claim unlocks. Whether the follow happened cannot be checked without the
 * X API and a server (docs/PRODUCTION.md), so the claim is on the player's word, once per device
 * and once per linked wallet.
 */
function FollowReward() {
  const follow = useGame((s) => s.follow);
  const setFollow = useGame((s) => s.setFollow);
  const canClaim = useGame((s) => s.canClaimFreeGame());
  const claimFreeGame = useGame((s) => s.claimFreeGame);
  const freeGames = useGame((s) => s.freeGames);
  const open = () => {
    sfx.click();
    setFollow('opened');
    window.open(FOLLOW_URL, '_blank', 'noopener,noreferrer');
  };
  const claim = () => {
    if (claimFreeGame()) {
      sfx.bingo();
      toast('Free game ticket added 🎟️', 'win');
    }
  };
  return (
    <div className="task task--follow">
      <div>
        <b>Follow @mostlyjola on X</b>
        <span className="small-note">
          {!canClaim ? 'Claimed on this device. Thanks for following!' : follow === 'returned' ? 'Welcome back — claim your free game.' : 'One Free Game ticket: an entry on a coin table, on the house.'}
          {freeGames > 0 ? ` You hold ${freeGames} ticket${freeGames > 1 ? 's' : ''}.` : ''}
        </span>
      </div>
      {!canClaim ? (
        <button type="button" className="task__claim" disabled>
          ✓
        </button>
      ) : follow === 'returned' ? (
        <button type="button" className="task__claim is-ready anim-pulse" onClick={claim}>
          Claim your free game
        </button>
      ) : (
        <button type="button" className="task__claim is-ready" onClick={open}>
          {follow === 'opened' ? 'Open again' : 'Follow'}
        </button>
      )}
    </div>
  );
}

export function FaucetPopup() {
  const faucetAt = useGame((s) => s.faucetAt);
  const claimFaucet = useGame((s) => s.claimFaucet);
  const close = useGame((s) => s.closePopup);
  const now = useNow();
  const wait = Math.max(0, faucetAt + FAUCET_COOLDOWN_MS - now);
  const [celebrate, setCelebrate] = useState(false);
  const fmt = (ms: number) => {
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`;
  };
  return (
    <Popup
      title="Free shells"
      onClose={close}
      footer={
        <GreenButton
          disabled={wait > 0}
          onClick={() => {
            if (claimFaucet()) {
              sfx.coin();
              setCelebrate(true);
              toast(`+${formatCoins(FAUCET_SHELLS)} shells!`, 'win');
            }
          }}
        >
          {wait > 0 ? fmt(wait) : `Collect ${FAUCET_SHELLS}`}
        </GreenButton>
      }
    >
      {celebrate && <Confetti pieces={40} />}
      <div className="popup-center">
        <ShellIcon size={8} className="faucet-coin anim-float" />
        <p>
          The tide brings <b>{FAUCET_SHELLS} free shells</b> every 4 hours.
        </p>
        <p className="small-note">Shells are free play money: never bought or sold, no cash value. Every game plays with them. Coins come from the Coin Shop.</p>
      </div>
    </Popup>
  );
}

export function ChestPopup() {
  const keys = useGame((s) => s.keys);
  const openChest = useGame((s) => s.openChest);
  const close = useGame((s) => s.closePopup);
  const [reward, setReward] = useState<{ shells: number; booster: string } | null>(null);
  return (
    <Popup
      title="Golden Key"
      onClose={close}
      footer={
        <GreenButton
          disabled={keys < CHEST_KEYS}
          onClick={() => {
            const r = openChest();
            if (r) {
              sfx.bingo();
              setReward({ shells: r.shells, booster: adventure.BOOSTERS[r.booster].name });
            }
          }}
        >
          {keys < CHEST_KEYS ? `${keys}/${CHEST_KEYS} keys` : 'Open chest'}
        </GreenButton>
      }
    >
      {reward && <Confetti />}
      <div className="popup-center">
        <div className="chest-row">
          <img src={art.iconChestSmall} alt="" className={reward ? 'anim-shake' : 'anim-float'} />
          <span className="chest-row__arrow">➜</span>
          <img src={art.iconKey} alt="" />
        </div>
        {reward ? (
          <p>
            You found <b>{reward.shells} shells</b> and a <b>{reward.booster}</b>!
          </p>
        ) : (
          <p>
            Earn a golden key for every level you finish with <b>3 stars</b>. {CHEST_KEYS} keys open the treasure chest.
          </p>
        )}
      </div>
    </Popup>
  );
}

export function LimitsPopup() {
  const limits = useGame((s) => s.limits);
  const setLimits = useGame((s) => s.setLimits);
  const setSpendCap = useGame((s) => s.setSpendCap);
  const today = useGame((s) => s.today);
  const close = useGame((s) => s.closePopup);
  const now = useNow(30_000);
  // The cap in force: a raise that has come due counts (the store applies it on the next event).
  const cap = limits.spendCapRaise && limits.spendCapRaise.at <= now ? limits.spendCapRaise.value : limits.dailySpendCap;
  const fresh = today.day === new Date(now).toLocaleDateString('en-CA');
  const net = (t: 'shells' | 'coins') => (fresh ? today.won[t] - today.wagered[t] : 0);
  const signed = (n: number) => `${n >= 0 ? '+' : ''}${formatCoins(n)}`;
  const option = (value: number | null, current: number | null, set: (v: number | null) => void, label: string) => (
    <button key={label} type="button" className={`chip-opt ${value === current ? 'is-on' : ''}`} onClick={() => (sfx.click(), set(value))}>
      {label}
    </button>
  );
  return (
    <Popup title="Play Safe" onClose={close}>
      <p>
        Today's net result:{' '}
        {TABLES.map((t, i) => (
          <span key={t}>
            {i > 0 ? ' · ' : ''}
            <b className={net(t) >= 0 ? 'pos' : 'neg'}>
              {signed(net(t))} {TABLE_NAME[t]}
            </b>
          </span>
        ))}
      </p>
      <h3>Playtime reminder</h3>
      <div className="chip-opts">
        {[null, 30, 60, 90].map((m) => option(m, limits.reminderMinutes, (v) => setLimits({ reminderMinutes: v }), m ? `${m} min` : 'Off'))}
      </div>
      <h3>Daily loss limit</h3>
      <div className="chip-opts">
        {[null, 1000, 5000, 20000].map((m) =>
          option(m, limits.dailyLossLimit, (v) => setLimits({ dailyLossLimit: v }), m ? formatCoins(m) : 'Off'),
        )}
      </div>
      <h3>Coin Shop daily cap</h3>
      <p className="small-note">Coins the shop may sell you in a day. Lowering it applies now; raising it applies after 24 hours.</p>
      <div className="chip-opts">
        {SPEND_CAP_OPTIONS.map((m) =>
          option(
            m,
            cap,
            (v) => {
              if (setSpendCap(v) === 'later') toast(`${v === null ? 'No cap' : formatCoins(v)} applies in 24 hours`, 'warn');
            },
            m ? formatCoins(m) : 'Off',
          ),
        )}
      </div>
      {limits.spendCapRaise && limits.spendCapRaise.at > now && (
        <p className="small-note">
          {limits.spendCapRaise.value === null ? 'No cap' : formatCoins(limits.spendCapRaise.value)} applies from {new Date(limits.spendCapRaise.at).toLocaleString()}.
        </p>
      )}
      <h3>Take a break</h3>
      <p className="small-note">Locks every wager game and the Coin Shop (Adventure stays open).</p>
      <div className="chip-opts">
        {[
          ['24 hours', 24],
          ['7 days', 24 * 7],
          ['30 days', 24 * 30],
        ].map(([label, hours]) => (
          <button
            key={label}
            type="button"
            className="chip-opt"
            onClick={() => {
              setLimits({ coolOffUntil: Date.now() + Number(hours) * 3600_000 });
              toast(`Wager games paused for ${label}`, 'warn');
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {limits.coolOffUntil > now && <p className="small-note">Break active until {new Date(limits.coolOffUntil).toLocaleString()}.</p>}
    </Popup>
  );
}

export function CreditsPopup() {
  const close = useGame((s) => s.closePopup);
  return (
    <Popup title="Credits" onClose={close}>
      <p>
        <b>Beach Bingo</b> v0.1 — beachbingo.xyz
      </p>
      <h3>Art</h3>
      <p className="small-note">
        UI art adapted from the “Island | mobile game 🏝️” Figma Community file, licensed CC BY 4.0. Fonts: Lilita One, Luckiest
        Guy and Fredoka (SIL Open Font License).
      </p>
      <h3>Fair play</h3>
      <p className="small-note">
        Every house game is provably fair: results come from HMAC-SHA256 of a committed server seed, your client seed and a nonce.
        You can rotate seeds and verify past rounds in Settings → Provably fair.
      </p>
      <h3>Shells and coins</h3>
      <p className="small-note">
        Shells are free play money: they are never bought or sold and have no cash value. Coins are bought in the Coin Shop; they have no
        cash value, cannot be sold, transferred or refunded, and never leave the game. Coin tables and the shop are for players
        aged 18 and over and are not offered in Washington State.
      </p>
      <h3>Live rooms</h3>
      <p className="small-note">
        Rooms are played browser to browser; public Nostr relays only help players find each other. The other players see the
        name in your profile.
      </p>
      <p className="small-note">
        <a href="https://beachbingo.xyz/privacy/" target="_blank" rel="noopener noreferrer">
          Privacy notice
        </a>{' '}
        ·{' '}
        <a href="https://beachbingo.xyz/terms/" target="_blank" rel="noopener noreferrer">
          Terms of play
        </a>
      </p>
    </Popup>
  );
}

/** The one-time declaration before coin tables and the Coin Shop open. Free play with shells never sees it. */
export function AgeGatePopup() {
  const confirmAge = useGame((s) => s.confirmAge);
  const [adult, setAdult] = useState(false);
  const [notWashington, setNotWashington] = useState(false);
  const dismiss = () => useGame.setState({ pendingCoins: null, popup: null });
  return (
    <Popup
      title="Coins are 18+"
      onClose={dismiss}
      footer={
        <GreenButton disabled={!adult || !notWashington} onClick={confirmAge}>
          Confirm
        </GreenButton>
      }
    >
      <p>Coin tables and the Coin Shop are for adults. Free play with shells is open to everyone and never asks.</p>
      <label className="check">
        <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} />
        <span>I am 18 or older</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={notWashington} onChange={(e) => setNotWashington(e.target.checked)} />
        <span>I am not a resident of Washington State</span>
      </label>
      <p className="small-note">
        Coins have no cash value, cannot be sold, transferred or refunded, and never leave the game. Your answer is kept on this
        device with the date.
      </p>
    </Popup>
  );
}
