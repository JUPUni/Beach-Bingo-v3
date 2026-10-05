import type { Region } from '../state/store.ts';

/**
 * The region check behind the Coin Shop and the coin tables: one call to `/api/geo` per
 * session (apps/site/api/geo.js reads Vercel's country and region headers; nothing is logged
 * or kept). Anything but a clean answer is "unknown", and unknown fails open: the age
 * declaration stands on its own, so local dev, the devnet build and a flaky network never block
 * play. Only a positive Washington answer closes the shop and the coin tables.
 */
export const UNKNOWN_REGION: Region = { country: null, region: null };

let pending: Promise<Region> | null = null;

const field = (x: unknown): string | null => (typeof x === 'string' && /^[A-Z0-9-]{1,8}$/i.test(x) ? x.toUpperCase() : null);

export function lookupRegion(fetcher: typeof fetch = fetch): Promise<Region> {
  if (!pending) {
    pending = (async () => {
      try {
        const res = await fetcher('/api/geo', { cache: 'no-store', headers: { accept: 'application/json' } });
        if (!res.ok || !/json/.test(res.headers.get('content-type') ?? '')) return UNKNOWN_REGION;
        const body = (await res.json()) as { country?: unknown; region?: unknown };
        return { country: field(body.country), region: field(body.region) };
      } catch {
        return UNKNOWN_REGION;
      }
    })();
  }
  return pending;
}

/** For tests: forget the cached answer. */
export function resetRegionLookup(): void {
  pending = null;
}
