// Token helpers the devnet scripts share (the admin script's proofs, the token-stake and shop e2e
// runs): funding a throwaway wallet with a registered mint from the payer's own token account,
// reading a token account's base units, sweeping a wallet's tokens back and closing its account,
// and the deployer's mock Seeker Genesis Token. Nothing here touches a browser.
import { createNoopSigner } from '@solana/kit';
import { getCloseAccountInstruction, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from '@solana-program/token-2022';
import { sendSigned } from '../../src/solana/waveDuel.ts';
import { ataAddress } from '../../src/solana/waveToken.ts';

/** A token account's balance in base units, or null when the account does not exist. */
export async function tokenBalance(rpc, tokenAccount) {
  const { value } = await rpc.getAccountInfo(tokenAccount, { encoding: 'base64', commitment: 'confirmed' }).send();
  if (!value) return null;
  return Buffer.from(value.data[0], 'base64').readBigUInt64LE(64);
}

export const createAtaIx = (payer, owner, ata, entry) =>
  getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(payer), ata, owner, mint: entry.mint, tokenProgram: entry.tokenProgram });

export const transferCheckedIx = (entry, source, destination, authority, amount) =>
  getTransferCheckedInstruction({ source, mint: entry.mint, destination, authority: createNoopSigner(authority), amount, decimals: entry.decimals }, { programAddress: entry.tokenProgram });

/**
 * Give `wallets` `amount` base units of the entry's mint each, out of the payer's associated token
 * account: their ATAs are created (the payer pays the rent) and funded in one transaction.
 */
export async function fundTokens(rpc, payer, entry, wallets, amount) {
  const source = await ataAddress(payer.address, entry.mint, entry.tokenProgram);
  const held = await tokenBalance(rpc, source);
  if (held === null || held < amount * BigInt(wallets.length)) {
    throw new Error(`the payer holds ${held ?? 0n} base units of ${entry.mint} at ${source}; ${amount * BigInt(wallets.length)} needed (wave-duel-admin.mjs create-devnet-mint, or a faucet)`);
  }
  const ixs = [];
  const atas = [];
  for (const w of wallets) {
    const ata = await ataAddress(w, entry.mint, entry.tokenProgram);
    atas.push(ata);
    ixs.push(createAtaIx(payer.address, w, ata, entry), transferCheckedIx(entry, source, ata, payer.address, amount));
  }
  const sent = await sendSigned(rpc, payer.address, [payer.keyPair], ixs);
  return { atas, signature: sent.signature };
}

/** Send whatever a throwaway wallet still holds of the mint back to the payer and close its account (rent to the payer). */
export async function sweepTokens(rpc, payer, entry, wallet) {
  const ata = await ataAddress(wallet.address, entry.mint, entry.tokenProgram);
  const held = await tokenBalance(rpc, ata);
  if (held === null) return null;
  const back = await ataAddress(payer.address, entry.mint, entry.tokenProgram);
  const ixs = [];
  if (held > 0n) ixs.push(transferCheckedIx(entry, ata, back, wallet.address, held));
  ixs.push(getCloseAccountInstruction({ account: ata, destination: payer.address, owner: createNoopSigner(wallet.address) }, { programAddress: entry.tokenProgram }));
  // The payer pays the fee so that a wallet already swept of its SOL can still return its tokens.
  const sent = await sendSigned(rpc, payer.address, [payer.keyPair, wallet.keyPair], ixs);
  return { held, signature: sent.signature };
}

/** Display units ("50", "4.99") to base units at the entry's decimals, exactly. */
export function toBase(display, decimals) {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(String(display).trim());
  if (!m) throw new Error(`not an amount: ${display}`);
  return BigInt(m[1] || '0') * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').slice(0, decimals).padEnd(decimals, '0') || '0');
}

export const fmtUnits = (base, entry, symbol = 'units') => `${(Number(base) / 10 ** entry.decimals).toLocaleString('en-US', { maximumFractionDigits: entry.decimals })} ${symbol}`;
