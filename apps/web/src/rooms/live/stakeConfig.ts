import { rpc } from '../../solana/client.ts';
import * as duel from '../../solana/waveDuel.ts';

/**
 * The escrow program's config (treasury, fee), read for the stake panels. The public RPCs
 * rate-limit, so the first read is retried a few times; a panel that still has none reads it
 * again when it needs it, so a rate-limited read can never mute the settle button.
 */
export async function loadConfig(cancelled: () => boolean): Promise<duel.ConfigAccount | null> {
  for (let attempt = 1; attempt <= 4 && !cancelled(); attempt++) {
    try {
      return await duel.fetchConfig(rpc);
    } catch {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  return null;
}

/** The config now: the one already read, or a fresh read; throws when the chain cannot be reached. */
export async function needConfig(config: duel.ConfigAccount | null): Promise<duel.ConfigAccount> {
  const c = config ?? (await duel.fetchConfig(rpc));
  if (!c) throw new Error('Could not read the escrow config; try again in a moment');
  return c;
}
