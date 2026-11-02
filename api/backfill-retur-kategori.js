// Backfill retur_kategori: re-compute dari records yang sudah ada di status_resi_detail
// Tidak fetch ke API kurir — pakai tracking history yang tersimpan di DB.
// GET /api/backfill-retur-kategori
// Jalankan sekali setelah deploy extractReturKategori.

const { sbFetch }             = require('../lib/supabase-rest');
const { extractReturKategori } = require('../lib/stage-engine');

const ROWS_PER_RUN = 200;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Ambil semua RETUR order yang belum punya retur_kategori di status_resi_detail
  // Query param opsional: ?from=2026-10-01&to=2026-10-31&offset=0
  const fromDate = req.query?.from   || '2026-10-01';
  const toDate   = req.query?.to     || '2026-10-31';
  const offset   = parseInt(req.query?.offset || '0', 10);

  let rows;
  try {

    rows = await sbFetch(
      `akuisisi_orders` +
      `?select=id,status_resi_detail` +
      `&status_resi=eq.RETUR` +
      `&order_date=gte.${fromDate}` +
      `&order_date=lte.${toDate}` +
      `&order=id.asc` +
      `&limit=${ROWS_PER_RUN}` +
      `&offset=${offset}`
    );
  } catch (e) {
    return res.status(500).json({ error: 'Gagal fetch: ' + e.message });
  }

  let updated = 0, skipped = 0, failed = 0;

  for (const row of rows || []) {
    const detail = row.status_resi_detail;

    // Skip kalau sudah ada retur_kategori
    if (detail?.retur_kategori) { skipped++; continue; }

    // Skip kalau tidak ada records (tidak bisa compute)
    const records = detail?.records;
    if (!records || !records.length) { skipped++; continue; }

    try {
      const kategori = extractReturKategori(records);
      await sbFetch(`akuisisi_orders?id=eq.${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status_resi_detail: { ...detail, retur_kategori: kategori },
        }),
      });
      updated++;
    } catch (e) {
      console.error(`[backfill-retur] Gagal update ${row.id}:`, e.message);
      failed++;
    }
  }

  const hasMore = (rows?.length || 0) >= ROWS_PER_RUN;
  return res.json({
    ok: true,
    offset,
    total: rows?.length || 0,
    updated,
    skipped,
    failed,
    nextOffset: hasMore ? offset + ROWS_PER_RUN : null,
    message: hasMore
      ? `Lanjut ke offset berikutnya: ?offset=${offset + ROWS_PER_RUN}`
      : 'Semua order sudah diproses.',
  });
};
