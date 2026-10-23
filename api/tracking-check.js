// Cek manual satu resi (tombol "Cek Ulang" di UI). Browser cuma manggil endpoint ini dan
// render hasilnya -- heuristik stage cuma ada di lib/stage-engine.js (lihat lib/tracking-router.js).
// GET /api/tracking-check?table=akuisisi_orders&id=<resi>

const { sbFetch } = require('../lib/supabase-rest');
const { checkResiAuto } = require('../lib/tracking-router');
const { STAGE_STEP } = require('../lib/stage-engine');

const ALLOWED_TABLES = ['akuisisi_orders', 'marketplace_orders', 'crm_orders'];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { table, id } = req.query;
  if (!ALLOWED_TABLES.includes(table)) {
    res.status(400).json({ error: 'table tidak valid' });
    return;
  }
  if (!id) {
    res.status(400).json({ error: 'id (resi) wajib diisi' });
    return;
  }

  try {
    const rows = await sbFetch(`${table}?select=id,ekspedisi,kota_tujuan&id=eq.${encodeURIComponent(id)}`);
    const row = rows && rows[0];
    if (!row) { res.status(404).json({ error: 'Order tidak ditemukan' }); return; }
    if (!row.ekspedisi) { res.status(400).json({ error: 'Ekspedisi belum diketahui buat order ini' }); return; }

    const { stage, detail } = await checkResiAuto(row);
    const patch = {
      status_resi: stage,
      status_resi_step: STAGE_STEP[stage],
      status_resi_updated_at: new Date().toISOString(),
      status_resi_detail: detail,
    };
    await sbFetch(`${table}?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });

    res.status(200).json({ stage, step: STAGE_STEP[stage], detail });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
