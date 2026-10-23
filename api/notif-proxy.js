// api/notif-proxy.js — proxy ke VPS baileys-notif service
// GET  /api/notif-proxy?action=status  → { ready, status }
// GET  /api/notif-proxy?action=qr      → { qr: "data:image/png;base64,..." } atau { connected: true }

const NOTIF_URL    = process.env.NOTIF_VPS_URL || 'http://13.140.178.4:3002';
const NOTIF_SECRET = process.env.NOTIF_SECRET  || 'adsysukses2026';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const action = req.query.action || 'status';

  try {
    if (action === 'status') {
      const r = await fetch(`${NOTIF_URL}/health`);
      const data = await r.json();
      return res.json(data);
    }

    if (action === 'qr') {
      // Fetch QR image HTML dari VPS lalu extract base64 img
      const r = await fetch(`${NOTIF_URL}/qr-data`, {
        headers: { 'x-secret': NOTIF_SECRET },
      });
      const data = await r.json();
      return res.json(data);
    }

    res.status(400).json({ error: 'action tidak dikenal' });
  } catch (e) {
    res.status(503).json({ error: 'Notif service tidak bisa dihubungi: ' + e.message });
  }
};
