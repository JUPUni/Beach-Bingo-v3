// A Wallet Standard wallet for headless tests: one Ed25519 account whose secret seed the test
// generates in Node and hands to the page through Playwright's `addInitScript`. The page signs
// with WebCrypto and sends through the RPC itself, so the app's real wallet layer
// (@solana/kit-plugin-wallet → @wallet-standard/app → @solana/react's sending signer) runs
// unchanged, exactly as it would with Phantom or Seed Vault.
//
//   const ana = await createTestWallet('Ana');            // Node: seed, key pair, address
//   await installTestWallet(context, ana, { rpcUrl });    // before the first page
//
// In the page, `window.__beachBingoTestWallet` reports the wallet's name, address, whether it
// is connected and every transaction it sent (`sent`: kind, base58 signature, wire hex). An
// optional `onTransaction` callback runs in Node before each send and after it settles; the
// wallet waits for it, so a test can read the chain "just before" a transaction lands.
import { createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey } from '@solana/kit';

export const TEST_WALLET_HOOK = '__beachBingoTestWalletHook';
export const TEST_WALLET_CHAIN = 'solana:devnet';

const hex = (bytes) => Buffer.from(bytes).toString('hex');

/** A fresh throwaway wallet: a random 32-byte seed, its WebCrypto key pair (for Node-side signing) and address. */
export async function createTestWallet(name) {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const keyPair = await createKeyPairFromPrivateKeyBytes(seed);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const address = await getAddressFromPublicKey(keyPair.publicKey);
  return { name, seed, keyPair, publicKey, address };
}

/**
 * Register the wallet in every page of a Playwright context. Call it before the context opens
 * its first page. `onTransaction(event)` receives `{ wallet, address, stage: 'beforeSend' |
 * 'sent' | 'failed', kind, txHex, messageHex, signature?, error? }`.
 */
export async function installTestWallet(context, wallet, { chain = TEST_WALLET_CHAIN, rpcUrl = 'https://api.devnet.solana.com', onTransaction } = {}) {
  if (onTransaction) await context.exposeBinding(TEST_WALLET_HOOK, (_source, event) => onTransaction(event));
  await context.addInitScript(installPageWallet, {
    name: wallet.name,
    seedHex: hex(wallet.seed),
    publicKeyHex: hex(wallet.publicKey),
    address: wallet.address,
    chain,
    rpcUrl,
    hookName: onTransaction ? TEST_WALLET_HOOK : null,
  });
}

/**
 * The page side. Playwright serialises this function, so it must not touch module scope.
 * Feature shapes follow @wallet-standard/features and @solana/wallet-standard-features; the
 * registration follows the spec's `registerWallet` (dispatch `wallet-standard:register-wallet`
 * for an app that is already listening, and answer `wallet-standard:app-ready` for one that
 * loads later, as the game's lazily loaded wallet client does).
 */
function installPageWallet({ name, seedHex, publicKeyHex, address, chain, rpcUrl, hookName }) {
  const CONNECT = 'standard:connect';
  const DISCONNECT = 'standard:disconnect';
  const EVENTS = 'standard:events';
  const SIGN_IN = 'solana:signIn';
  const SIGN_MESSAGE = 'solana:signMessage';
  const SIGN_TRANSACTION = 'solana:signTransaction';
  const SIGN_AND_SEND = 'solana:signAndSendTransaction';
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  const unhex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));
  const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const base58 = (bytes) => {
    let zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
    const digits = [];
    for (const byte of bytes) {
      let carry = byte;
      for (let i = 0; i < digits.length; i++) {
        carry += digits[i] * 256;
        digits[i] = carry % 58;
        carry = Math.floor(carry / 58);
      }
      while (carry > 0) {
        digits.push(carry % 58);
        carry = Math.floor(carry / 58);
      }
    }
    return '1'.repeat(zeros) + digits.reverse().map((d) => ALPHABET[d]).join('');
  };
  const base64 = (bytes) => {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  };

  const publicKey = unhex(publicKeyHex);
  // WebCrypto imports raw Ed25519 seeds only wrapped as PKCS#8: this prefix is the fixed header.
  const PKCS8_PREFIX = unhex('302e020100300506032b657004220420');
  let keyPromise = null;
  const key = () => {
    if (!keyPromise) {
      if (!globalThis.crypto?.subtle) throw new Error(`${name}: WebCrypto is unavailable (the page must be a secure context, e.g. http://127.0.0.1)`);
      const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + 32);
      pkcs8.set(PKCS8_PREFIX);
      pkcs8.set(unhex(seedHex), PKCS8_PREFIX.length);
      keyPromise = crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
    }
    return keyPromise;
  };
  const sign = async (message) => new Uint8Array(await crypto.subtle.sign('Ed25519', await key(), message));

  const icon = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#1fb6e8"/><text x="16" y="21" font-size="14" font-family="sans-serif" text-anchor="middle" fill="#fff">T</text></svg>')}`;
  const account = Object.freeze({
    address,
    publicKey,
    chains: Object.freeze([chain]),
    features: Object.freeze([SIGN_IN, SIGN_MESSAGE, SIGN_TRANSACTION, SIGN_AND_SEND]),
    label: name,
    icon,
  });
  let accounts = Object.freeze([]);
  const listeners = new Set();
  const emit = (properties) => {
    for (const listener of listeners) {
      try {
        listener(properties);
      } catch (e) {
        console.error(e);
      }
    }
  };
  const connect = async () => {
    if (accounts.length === 0) {
      accounts = Object.freeze([account]);
      emit({ accounts });
    }
    return { accounts };
  };
  const assertAccount = (input, what) => {
    if (input?.account && input.account.address !== address) throw new Error(`${name}: ${what} for an unknown account ${input.account.address}`);
  };

  /* ---------- Transactions (the wire format: compact-u16 signature count, signatures, message) ---------- */
  const readCompactU16 = (bytes, offset) => {
    let value = 0;
    let shift = 0;
    let i = offset;
    for (;;) {
      const b = bytes[i++];
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return [value, i];
      shift += 7;
    }
  };
  /** Where this account signs: its index among the message's static keys, which must be below the required-signature count. */
  const signerIndex = (message) => {
    let o = message[0] & 0x80 ? 1 : 0; // a versioned message starts with a prefix byte
    const required = message[o];
    o += 3;
    const [count, keysStart] = readCompactU16(message, o);
    for (let i = 0; i < count; i++) {
      const k = message.subarray(keysStart + i * 32, keysStart + (i + 1) * 32);
      if (k.every((b, j) => b === publicKey[j])) return i < required ? i : -1;
    }
    return -1;
  };
  const signWire = async (tx) => {
    const [count, start] = readCompactU16(tx, 0);
    const message = tx.subarray(start + count * 64);
    const index = signerIndex(message);
    if (index < 0 || index >= count) throw new Error(`${name}: ${address} is not a signer of this transaction`);
    const signature = await sign(message);
    const signed = new Uint8Array(tx);
    signed.set(signature, start + index * 64);
    return { signed, signature, message };
  };

  const rpc = async (method, params) => {
    let wait = 1000;
    for (let attempt = 1; ; attempt++) {
      let body;
      try {
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: attempt, method, params }),
        });
        // The public RPC rate-limits (429) and hiccups (5xx): back off and try again.
        if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`);
        body = await response.json();
      } catch (e) {
        if (attempt >= 6) throw new Error(`${name}: ${method} failed after ${attempt} attempts (${e instanceof Error ? e.message : e})`);
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 8000);
        continue;
      }
      if (body.error) {
        const detail = body.error.data?.logs?.filter((l) => /Error|failed/i.test(l)).slice(-2).join(' | ');
        throw new Error(`${method}: ${body.error.message}${detail ? ` — ${detail}` : ''}`);
      }
      return body.result;
    }
  };

  const sent = [];
  const record = { name, address, sent, get connected() { return accounts.length > 0; } };
  const hook = async (event) => {
    if (!hookName || typeof window[hookName] !== 'function') return;
    await window[hookName]({ wallet: name, address, ...event });
  };

  const signAndSendOne = async (input) => {
    assertAccount(input, 'signAndSendTransaction');
    const { signed, signature, message } = await signWire(input.transaction);
    const txHex = toHex(signed);
    const messageHex = toHex(message);
    await hook({ stage: 'beforeSend', kind: 'signAndSendTransaction', txHex, messageHex });
    const options = input.options ?? {};
    const config = {
      encoding: 'base64',
      preflightCommitment: options.preflightCommitment ?? 'confirmed',
      skipPreflight: options.skipPreflight ?? false,
      ...(options.maxRetries != null ? { maxRetries: options.maxRetries } : {}),
      ...(options.minContextSlot != null ? { minContextSlot: options.minContextSlot } : {}),
    };
    let result;
    try {
      result = await rpc('sendTransaction', [base64(signed), config]);
    } catch (e) {
      await hook({ stage: 'failed', kind: 'signAndSendTransaction', txHex, messageHex, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    const expected = base58(signature);
    if (result !== expected) throw new Error(`${name}: the RPC returned signature ${result}, expected ${expected}`);
    sent.push({ kind: 'signAndSendTransaction', signature: expected, txHex, at: Date.now() });
    await hook({ stage: 'sent', kind: 'signAndSendTransaction', txHex, messageHex, signature: expected });
    return { signature };
  };

  const signInText = (input) => {
    let text = `${input.domain} wants you to sign in with your Solana account:\n${input.address}`;
    if (input.statement) text += `\n\n${input.statement}`;
    const fields = [];
    if (input.uri) fields.push(`URI: ${input.uri}`);
    if (input.version) fields.push(`Version: ${input.version}`);
    if (input.chainId) fields.push(`Chain ID: ${input.chainId}`);
    if (input.nonce) fields.push(`Nonce: ${input.nonce}`);
    if (input.issuedAt) fields.push(`Issued At: ${input.issuedAt}`);
    if (input.expirationTime) fields.push(`Expiration Time: ${input.expirationTime}`);
    if (input.notBefore) fields.push(`Not Before: ${input.notBefore}`);
    if (input.requestId) fields.push(`Request ID: ${input.requestId}`);
    if (input.resources) {
      fields.push('Resources:');
      for (const r of input.resources) fields.push(`- ${r}`);
    }
    if (fields.length) text += `\n\n${fields.join('\n')}`;
    return text;
  };

  const features = Object.freeze({
    [CONNECT]: { version: '1.0.0', connect },
    [DISCONNECT]: {
      version: '1.0.0',
      disconnect: async () => {
        if (accounts.length) {
          accounts = Object.freeze([]);
          emit({ accounts });
        }
      },
    },
    [EVENTS]: {
      version: '1.0.0',
      on: (event, listener) => {
        if (event !== 'change') return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    [SIGN_IN]: {
      version: '1.0.0',
      signIn: async (...inputs) => {
        if (!inputs.length) inputs = [{}];
        await connect();
        const outputs = [];
        for (const input of inputs) {
          if (input.address && input.address !== address) throw new Error(`${name}: signIn for an unknown address ${input.address}`);
          const signedMessage = new TextEncoder().encode(signInText({ ...input, domain: input.domain ?? location.host, address }));
          outputs.push({ account, signedMessage, signature: await sign(signedMessage), signatureType: 'ed25519' });
        }
        return outputs;
      },
    },
    [SIGN_MESSAGE]: {
      version: '1.1.0',
      signMessage: async (...inputs) => {
        const outputs = [];
        for (const input of inputs) {
          assertAccount(input, 'signMessage');
          outputs.push({ signedMessage: input.message, signature: await sign(input.message), signatureType: 'ed25519' });
        }
        return outputs;
      },
    },
    [SIGN_TRANSACTION]: {
      version: '1.0.0',
      supportedTransactionVersions: Object.freeze(['legacy', 0]),
      signTransaction: async (...inputs) => {
        const outputs = [];
        for (const input of inputs) {
          assertAccount(input, 'signTransaction');
          const { signed } = await signWire(input.transaction);
          sent.push({ kind: 'signTransaction', signature: null, txHex: toHex(signed), at: Date.now() });
          outputs.push({ signedTransaction: signed });
        }
        return outputs;
      },
    },
    [SIGN_AND_SEND]: {
      version: '1.0.0',
      supportedTransactionVersions: Object.freeze(['legacy', 0]),
      signAndSendTransaction: async (...inputs) => {
        const outputs = [];
        for (const input of inputs) outputs.push(await signAndSendOne(input));
        return outputs;
      },
    },
  });

  const chains = Object.freeze([chain]);
  const wallet = Object.freeze({
    get version() {
      return '1.0.0';
    },
    get name() {
      return name;
    },
    get icon() {
      return icon;
    },
    get chains() {
      return chains;
    },
    get features() {
      return features;
    },
    get accounts() {
      return accounts;
    },
  });

  /* ---------- Registration, both ways round ---------- */
  const callback = ({ register }) => register(wallet);
  class RegisterWalletEvent extends Event {
    constructor() {
      super('wallet-standard:register-wallet', { bubbles: false, cancelable: false, composed: false });
    }
    get detail() {
      return callback;
    }
    get type() {
      return 'wallet-standard:register-wallet';
    }
    preventDefault() {
      throw new Error('preventDefault cannot be called');
    }
    stopImmediatePropagation() {
      throw new Error('stopImmediatePropagation cannot be called');
    }
    stopPropagation() {
      throw new Error('stopPropagation cannot be called');
    }
  }
  try {
    window.dispatchEvent(new RegisterWalletEvent());
  } catch (e) {
    console.error('wallet-standard:register-wallet event could not be dispatched', e);
  }
  window.addEventListener('wallet-standard:app-ready', (event) => callback(event.detail));
  window.__beachBingoTestWallet = record;
}
