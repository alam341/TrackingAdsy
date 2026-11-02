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
  let rows;
  try {
    // Query param opsional: ?from=2026-10-01&to=2026-10-31
    const fromDate = req.query?.from || '2026-10-01';
    const toDate   = req.query?.to   || '2026-10-31';

    rows = await sbFetch(
      `akuisisi_orders` +
      `?select=id,status_resi_detail` +
      `&status_resi=eq.RETUR` +
      `&order_date=gte.${fromDate}` +
      `&order_date=lte.${toDate}` +
      `&limit=${ROWS_PER_RUN}`
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

  return res.json({
    ok: true,
    total: rows?.length || 0,
    updated,
    skipped,
    failed,
    message: updated > 0
      ? `${updated} order berhasil di-backfill. Kalau masih ada sisanya, panggil endpoint ini lagi.`
      : 'Tidak ada order baru yang perlu di-backfill.',
  });
};
