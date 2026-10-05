// The region check for the Coin Shop and the coin tables.
//
//   GET /api/geo → { country: "US", region: "WA" }   (either field null when Vercel did not say)
//
// Reads the country and region Vercel attaches to every request at the edge and returns them
// as they are. No third-party lookup, no database, nothing logged or stored: the IP address is
// never read here, only the two headers derived from it. The game treats a missing or failed
// answer as unknown and lets the player's own 18+ declaration stand (docs/GAME_MODES.md,
// "Shells and coins"); only a positive Washington answer closes the shop and the coin tables.

const clean = (value) => {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && /^[A-Za-z0-9-]{1,8}$/.test(v) ? v.toUpperCase() : null;
};

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    country: clean(req.headers['x-vercel-ip-country']),
    region: clean(req.headers['x-vercel-ip-country-region']),
  });
}
