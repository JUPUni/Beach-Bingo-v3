import type { SolanaSignInInput, SolanaSignInOutput } from '@solana/wallet-standard-features';
import { verifySignIn } from '@solana/wallet-standard-util';
import { CHAIN } from './config.ts';

/**
 * Sign In With Solana (SIWS).
 *
 * In production the nonce comes from the Beach Bingo API and the API verifies the output
 * (see apps/server/src/auth.ts) before issuing a session. The browser-side check below only
 * confirms the wallet signed exactly what we asked for.
 */
export function createSignInInput(nonce = randomNonce()): SolanaSignInInput {
  const now = new Date();
  return {
    domain: window.location.host,
    uri: window.location.origin,
    statement: 'Sign in to Beach Bingo. This does not move funds or cost anything.',
    version: '1',
    chainId: CHAIN,
    nonce,
    issuedAt: now.toISOString(),
    expirationTime: new Date(now.getTime() + 10 * 60_000).toISOString(),
  };
}

export function verifySignInLocally(input: SolanaSignInInput, output: SolanaSignInOutput): boolean {
  return verifySignIn(input, output);
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}
