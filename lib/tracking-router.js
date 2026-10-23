// Satu fungsi dispatch dipakai api/tracking-check.js (cek manual) DAN api/cron-check-resi.js
// (batch). Rute otomatis berdasar row.ekspedisi -- gak peduli row itu dari akuisisi_orders,
// marketplace_orders, atau crm_orders (kontrak kolom `ekspedisi`/`kota_tujuan` sama persis).

const { fetchMengantar, fetchPos, fetchSpx } = require('./courier-clients');
const { MENGANTAR_COURIER_MAP, mapSpxStage, mapPosStage, mapMengantarStage } = require('./stage-engine');

async function checkSpxResi(resi, destCity) {
  const data = await fetchSpx(resi);
  if (data.retcode !== 0) throw new Error(data.message || 'Resi tidak ditemukan');
  return mapSpxStage(data, destCity);
}

async function checkPosResi(resi, destCity) {
  const data = await fetchPos(resi);
  if (data.error || !data.connote_code) throw new Error(data.error || 'Resi tidak ditemukan');
  return mapPosStage(data, destCity);
}

async function checkMengantarResi(resi, ekspedisi) {
  const courier = MENGANTAR_COURIER_MAP[ekspedisi];
  if (!courier) throw new Error('Ekspedisi belum didukung');
  const data = await fetchMengantar(resi, courier);
  return mapMengantarStage(data);
}

// row: { id (resi), ekspedisi, kota_tujuan }. id dipakai sebagai nomor resi.
async function checkResiAuto(row) {
  if (row.ekspedisi === 'SPX') return checkSpxResi(row.id, row.kota_tujuan);
  if (row.ekspedisi === 'POS') return checkPosResi(row.id, row.kota_tujuan);
  if (MENGANTAR_COURIER_MAP[row.ekspedisi]) return checkMengantarResi(row.id, row.ekspedisi);
  throw new Error('Ekspedisi tidak didukung: ' + row.ekspedisi);
}

const AUTO_EKSPEDISI_LIST = ['SPX', 'POS', 'JNE', 'J&T', 'SICEPAT', 'ANTERAJA', 'NINJA', 'IDEXPRESS', 'LION', 'SAP'];

module.exports = { checkResiAuto, AUTO_EKSPEDISI_LIST };
