/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Solana RPC used for balance / Seeker Genesis Token lookups. */
  readonly VITE_SOLANA_RPC_URL?: string;
  /** `mainnet` | `devnet`. */
  readonly VITE_SOLANA_CLUSTER?: string;
  /** Live room server (WebSocket). Empty = practice rooms simulated locally. */
  readonly VITE_ROOM_SERVER_URL?: string;
  /** Comma-separated Nostr relay URLs for live rooms (default: trystero's public list). */
  readonly VITE_NOSTR_RELAYS?: string;
  /** Must be "true" AND pass the compliance gate before any on-chain stake UI appears. */
  readonly VITE_ENABLE_ONCHAIN_STAKES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
