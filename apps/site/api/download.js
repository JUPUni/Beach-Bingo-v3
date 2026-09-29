// Server-side download gate.
// Env vars required:
//   DOWNLOAD_CODE    — the access code users must enter
//   APK_SECRET_NAME  — the actual APK filename (unpredictable path in /public)
//
// Usage:
//   GET /api/download?code=xxx        → { ok: true } or 403 { ok: false }   (validation check)
//   GET /api/download?code=xxx&dl=1   → 302 redirect to APK                 (trigger download)

export default function handler(req, res) {
  const code       = (req.query.code || '').trim().toLowerCase();
  const doDownload = req.query.dl   === '1';

  const VALID_CODE = (process.env.DOWNLOAD_CODE   || '').trim().toLowerCase();
  const SECRET_APK = (process.env.APK_SECRET_NAME || '').trim();

  if (!VALID_CODE || !SECRET_APK) {
    return res.status(500).json({ ok: false, error: 'Server not configured' });
  }

  const valid = code && code === VALID_CODE;

  if (!valid) {
    return res.status(403).json({ ok: false });
  }

  if (doDownload) {
    res.setHeader('Cache-Control', 'no-store, no-cache');
    return res.redirect(302, `/${SECRET_APK}`);
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true });
}
