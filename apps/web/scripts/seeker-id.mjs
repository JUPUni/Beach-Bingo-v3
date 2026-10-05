#!/usr/bin/env node
// What name a wallet would play under: its Seeker ID (.skr) as the app resolves it on mainnet.
//
//   pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/seeker-id.mjs <wallet> [<wallet> ...]
//   SOLANA_MAINNET_RPC_URL=https://... to use a provider (the lookup needs getProgramAccounts).
//
// Prints the name the app shows (the main domain when the wallet set one it still owns, else the
// first of its .skr names sorted), whether it is the main domain, and every name found (at most ten).
import { address, createSolanaRpc } from '@solana/kit';
import { resolveSeekerId } from '../src/solana/seekerId.ts';

const wallets = process.argv.slice(2);
if (!wallets.length) {
  console.error('usage: seeker-id.mjs <wallet> [<wallet> ...]');
  process.exit(2);
}
const rpc = createSolanaRpc(process.env.SOLANA_MAINNET_RPC_URL || 'https://api.mainnet-beta.solana.com');
for (const wallet of wallets) {
  const started = Date.now();
  try {
    const id = await resolveSeekerId(rpc, address(wallet));
    console.log(id ? `${wallet}: ${id.name}${id.main ? ' (main domain)' : ''}${id.names.length > 1 ? ` · also ${id.names.filter((n) => n !== id.name).join(', ')}` : ''} (${Date.now() - started} ms)` : `${wallet}: no .skr name (${Date.now() - started} ms)`);
  } catch (e) {
    console.log(`${wallet}: lookup failed — ${e instanceof Error ? e.message.split('\n')[0] : e}`);
    process.exitCode = 1;
  }
}
