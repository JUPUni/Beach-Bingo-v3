/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Solana RPC used for balance / Seeker Genesis Token lookups. */
  readonly VITE_SOLANA_RPC_URL?: string;
  /** Mainnet RPC for the Seeker ID (.skr) lookup, whatever cluster the build plays on. */
  readonly VITE_SOLANA_MAINNET_RPC_URL?: string;
  /** `mainnet` | `devnet`. */
  readonly VITE_SOLANA_CLUSTER?: string;
  /** Live room server (WebSocket). Empty = practice rooms simulated locally. */
  readonly VITE_ROOM_SERVER_URL?: string;
  /** Comma-separated Nostr relay URLs for live rooms (default: trystero's public list). */
  readonly VITE_NOSTR_RELAYS?: string;
  /** Must be "true" AND pass the compliance gate before any on-chain stake UI appears. */
  readonly VITE_ENABLE_ONCHAIN_STAKES?: string;
  /** The wave_duel escrow program id; with the flag above, staked Wave Rush rooms appear. */
  readonly VITE_WAVE_DUEL_PROGRAM?: string;
  /** The Seeker Genesis Token group the app checks for (default: mainnet's; the devnet build names the mock group). */
  readonly VITE_SGT_GROUP?: string;
  /** A label shown on the splash for non-production builds ("devnet"). */
  readonly VITE_BUILD_LABEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
