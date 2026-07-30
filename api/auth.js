// api/auth.js — verifies Google ID token server-side
// Called after the user completes Google Sign-In on the frontend.
// Returns 200 if the email is @rillet.com, 403 otherwise.

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'Missing credential' });

  try {
    // Ask Google to verify the token — no extra packages needed
    const r = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`
    );
    if (!r.ok) return res.status(401).json({ error: 'Invalid token' });

    const payload = await r.json();

    if (!payload.email || payload.email_verified !== 'true') {
      return res.status(401).json({ error: 'Email not verified' });
    }
    if (!payload.email.toLowerCase().endsWith('@rillet.com')) {
      return res.status(403).json({ error: 'Access restricted to @rillet.com accounts' });
    }

    res.status(200).json({ ok: true, email: payload.email, name: payload.name || payload.email });
  } catch (err) {
    console.error('auth error:', err.message);
    res.status(500).json({ error: 'Auth failed' });
  }
};
