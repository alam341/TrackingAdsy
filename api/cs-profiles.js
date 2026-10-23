// GET /api/cs-profiles
// Fetch semua CS dari cs_profiles di CS Input Supabase
// Pakai service role key server-side supaya bypass RLS (anon key block karena policy uid = id)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).end(); return; }

  const CS_URL = 'https://lqpcnzdssvvcayqvdjxs.supabase.co';
  const CS_SERVICE_KEY = process.env.CS_INPUT_SERVICE_KEY;

  if (!CS_SERVICE_KEY) {
    res.status(500).json({ error: 'CS_INPUT_SERVICE_KEY belum di-set di Vercel env vars' });
    return;
  }

  try {
    const r = await fetch(`${CS_URL}/rest/v1/cs_profiles?select=id,nama,no_wa,role&order=nama.asc`, {
      headers: {
        apikey: CS_SERVICE_KEY,
        Authorization: `Bearer ${CS_SERVICE_KEY}`,
      },
    });
    if (!r.ok) throw new Error(`CS Input error: ${r.status} ${await r.text()}`);
    const data = await r.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
