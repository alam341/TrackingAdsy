// Backfill tracking: cek resi CS Input yang belum ada di akuisisi_orders
// GET /api/backfill-tracking?offset=0
// Proses 100 per request — ulangi sampai hasMore: false

const { sbFetch }                            = require('../lib/supabase-rest');
const { checkResiAuto, AUTO_EKSPEDISI_LIST } = require('../lib/tracking-router');
const { STAGE_STEP }                         = require('../lib/stage-engine');

const CS_SUPABASE_URL = 'https://lqpcnzdssvvcayqvdjxs.supabase.co';
const ROWS_PER_RUN    = 100;
const DAYS_BACK       = 60;
const BATCH           = 5;

function cutoffDate() {
  const d = new Date();
  d.setDate(d.getDate() - DAYS_BACK);
  return d.toISOString().slice(0, 10);
}

function extractEkspedisi(pembayaran, resi) {
  if (resi && /^MGT\d/i.test(String(resi).trim())) return 'SAP';
  if (!pembayaran) return '';
  const p = pembayaran.toUpperCase();
  const map = [
    ['SPX','SPX'],['SICEPAT','SICEPAT'],['ANTERAJA','ANTERAJA'],
    ['IDEXPRESS','IDEXPRESS'],['NINJA','NINJA'],['LION','LION'],
    ['J&T','J&T'],['JNT','J&T'],['JNE','JNE'],['POS','POS'],['SAP','SAP'],
  ];
  for (const [k, v] of map) if (p.includes(k)) return v;
  return '';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const key = process.env.CS_INPUT_SERVICE_KEY;
  if (!key) return res.status(500).json({ error: 'CS_INPUT_SERVICE_KEY belum di-set' });

  const cutoff = cutoffDate();
  const offset = parseInt(req.query.offset || '0');

  // 1. Fetch batch dari CS Input
  let csRows;
  try {
    const r = await fetch(
      `${CS_SUPABASE_URL}/rest/v1/all_orderan` +
      `?select=resi,pembayaran,kabupaten` +
      `&sumber=eq.cs_input` +
      `&tanggal=gte.${cutoff}` +
      `&resi=not.is.null` +
      `&resi=neq.` +
      `&order=id.asc` +
      `&limit=${ROWS_PER_RUN}&offset=${offset}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!r.ok) throw new Error('CS Input fetch gagal: ' + r.status);
    csRows = await r.json();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const hasMore = csRows.length === ROWS_PER_RUN;

  if (!csRows.length) {
    return res.status(200).json({ done: true, checked: 0, updated: 0, failed: 0, offset, hasMore: false });
  }

  // 2. Filter ke resi valid + ekspedisi yang didukung
  const eligible = csRows
    .map(r => {
      const id = String(r.resi || '').replace(/^'+/, '').trim();
      return {
        id,
        ekspedisi: extractEkspedisi(r.pembayaran, id),
        kota_tujuan: r.kabupaten || '',
      };
    })
    .filter(r => r.id && !r.id.startsWith('IMP-') && AUTO_EKSPEDISI_LIST.includes(r.ekspedisi));

  if (!eligible.length) {
    return res.status(200).json({ done: !hasMore, checked: 0, updated: 0, failed: 0, offset: offset + ROWS_PER_RUN, hasMore });
  }

  // 3. Cari mana yang belum ada di akuisisi_orders sama sekali
  const resiIds = eligible.map(r => r.id);
  let existingSet = new Set();
  try {
    const existing = await sbFetch(
      `akuisisi_orders?select=id&id=in.(${resiIds.map(encodeURIComponent).join(',')})`
    );
    existingSet = new Set((existing || []).map(r => r.id));
  } catch (_) {}

  const toCheck = eligible.filter(r => !existingSet.has(r.id));

  if (!toCheck.length) {
    return res.status(200).json({ done: !hasMore, checked: 0, updated: 0, failed: 0, offset: offset + ROWS_PER_RUN, hasMore });
  }

  // 4. Check kurir API + upsert ke akuisisi_orders
  let checked = 0, updated = 0, failed = 0;
  const errors = [];
  const now = new Date().toISOString();

  for (let i = 0; i < toCheck.length; i += BATCH) {
    const batch = toCheck.slice(i, i + BATCH);
    await Promise.all(batch.map(async row => {
      checked++;
      try {
        const { stage, detail } = await checkResiAuto(row);
        let detailToSave = detail;
        if (stage === 'BERMASALAH') {
          detailToSave = { ...(detail || {}), bermasalah_since: now };
        }
        await sbFetch('akuisisi_orders?on_conflict=id', {
          method:  'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({
            id:                     row.id,
            ekspedisi:              row.ekspedisi,
            status_resi:            stage,
            status_resi_step:       STAGE_STEP[stage] || 1,
            status_resi_updated_at: now,
            status_resi_detail:     detailToSave,
          }),
        });
        updated++;
      } catch (e) {
        failed++;
        errors.push(`${row.id}: ${e.message}`);
      }
    }));
  }

  return res.status(200).json({
    done:    !hasMore,
    checked,
    updated,
    failed,
    offset:  offset + ROWS_PER_RUN,
    hasMore,
    errors:  errors.slice(0, 5),
  });
};
