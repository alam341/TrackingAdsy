// api/room-work.js
// GET   /api/room-work?tab=aktif|bales|lapor|investigasi|semua
// POST  /api/room-work  body: { resi: [...] }  → batch lookup fu_count+cs_responded
// PATCH /api/room-work  body: { id, ...fields }

const { sbFetch } = require('../lib/supabase-rest');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    // ── GET ──────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const { tab = 'aktif', limit = 500 } = req.query;

      const filterMap = {
        aktif:              'cs_responded=eq.false&lapor_ekspedisi=eq.false&investigasi=eq.false&auto_resolved=eq.false',
        tidak_bales:        'fu_count=gte.4&cs_responded=eq.false&lapor_ekspedisi=eq.false&investigasi=eq.false&auto_resolved=eq.false',
        bales:              'cs_responded=eq.true',
        lapor:              'lapor_ekspedisi=eq.true',
        investigasi:        'investigasi=eq.true',
        terkirim_otomatis:  'auto_resolved=eq.true',
        semua:              '',
      };

      const f = filterMap[tab] ?? '';
      const data = await sbFetch(
        `room_work?${f ? f + '&' : ''}select=*&order=created_at.desc&limit=${limit}`
      );
      return res.json(data || []);
    }

    // ── POST — batch lookup fu_count+cs_responded by resi list ───────────────
    if (req.method === 'POST') {
      const { resi: resiList } = req.body || {};
      if (!Array.isArray(resiList) || !resiList.length) return res.json([]);
      const CHUNK = 500;
      const results = [];
      for (let i = 0; i < resiList.length; i += CHUNK) {
        const chunk = resiList.slice(i, i + CHUNK);
        const inList = chunk.map(r => `"${String(r).replace(/"/g, '')}"`).join(',');
        const data = await sbFetch(
          `room_work?select=resi,fu_count,cs_responded&resi=in.(${inList})`
        );
        if (data) results.push(...data);
      }
      return res.json(results);
    }

    // ── PATCH ─────────────────────────────────────────────────────────────────
    if (req.method === 'PATCH') {
      const { id, ...patch } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id wajib' });

      const now = new Date().toISOString();
      if (patch.cs_responded    === true) patch.cs_responded_at    = now;
      if (patch.lapor_ekspedisi === true) patch.lapor_ekspedisi_at = now;
      if (patch.investigasi     === true) patch.investigasi_at     = now;

      await sbFetch(`room_work?id=eq.${id}`, {
        method: 'PATCH',
        body:   JSON.stringify(patch),
      });
      return res.json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
