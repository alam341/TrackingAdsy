// lib/room-work-helper.js
// Helper untuk insert Room Work + kirim FU Info (notifikasi pertama, langsung saat BERMASALAH)
// Dipanggil dari mengantar-webhook.js

const { sbFetch }   = require('./supabase-rest');
const { sendWA, getCsNoWa } = require('./notif-wa');

const CS_SUPABASE_URL = 'https://lqpcnzdssvvcayqvdjxs.supabase.co';

// ── Pesan FU ──────────────────────────────────────────────────────────────────
const FU_MSG = {
  info: (cs, resi, eksp, kota, caseUndel) =>
    `⚠️ *[Info] Paket Bermasalah*\n\nHalo ${cs}!\n\nAda paket yang perlu ditindaklanjuti:\n\n` +
    `📦 Resi: *${resi}*\n🚚 Ekspedisi: ${eksp||'-'}\n📍 Kota: ${kota||'-'}\n` +
    (caseUndel ? `❌ Kasus: ${caseUndel}\n` : '') +
    `\nMohon segera follow up ke kurir ya! 🙏`,

  1: (cs, resi, eksp, kota, caseUndel) =>
    `📨 *[FU 1] Paket Bermasalah*\n\nHalo ${cs}, mengingatkan:\n\n` +
    `📦 Resi: *${resi}*\n🚚 Ekspedisi: ${eksp||'-'}\n📍 Kota: ${kota||'-'}\n` +
    (caseUndel ? `❌ Kasus: ${caseUndel}\n` : '') +
    `\nBelum ada update — mohon segera dikonfirmasi! 🙏`,

  2: (cs, resi, eksp, kota, caseUndel) =>
    `🔔 *[FU 2] Pengingat Paket Bermasalah*\n\nHalo ${cs}, mengingatkan kembali:\n\n` +
    `📦 Resi: *${resi}*\n🚚 Ekspedisi: ${eksp||'-'}\n📍 Kota: ${kota||'-'}\n` +
    (caseUndel ? `❌ Kasus: ${caseUndel}\n` : '') +
    `\nSudah 2 hari belum ada konfirmasi — tolong segera ditindak! 🙏`,

  3: (cs, resi, eksp, kota, caseUndel) =>
    `🚨 *[FU 3 - Terakhir] Paket Bermasalah*\n\nHalo ${cs}, ini follow up terakhir:\n\n` +
    `📦 Resi: *${resi}*\n🚚 Ekspedisi: ${eksp||'-'}\n📍 Kota: ${kota||'-'}\n` +
    (caseUndel ? `❌ Kasus: ${caseUndel}\n` : '') +
    `\nHarap konfirmasi hari ini ya! 🙏`,
};

// ── Ambil data order dari CS Input (nama pembeli, hp, produk) ─────────────────
async function fetchCsInputOrder(resi) {
  const key = process.env.CS_INPUT_SERVICE_KEY;
  if (!key || !resi) return null;
  try {
    const resiClean = resi.replace(/'/g, "''");
    const r = await fetch(
      `${CS_SUPABASE_URL}/rest/v1/all_orderan?select=nama,hp,jumlah&resi=ilike.${encodeURIComponent(resiClean)}&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return rows?.[0] || null;
  } catch { return null; }
}

// ── Insert room_work + kirim FU Info ──────────────────────────────────────────
async function insertRoomWork({ resi, csNama, kota, ekspedisi, caseUndel }) {
  const [csOrder, csNoWa] = await Promise.all([
    fetchCsInputOrder(resi),
    getCsNoWa(csNama),
  ]);

  const now = new Date().toISOString();
  const record = {
    resi,
    cs_nama:      csNama      || '',
    cs_no_wa:     csNoWa      || '',
    nama_pembeli: csOrder?.nama    || '',
    hp_pembeli:   csOrder?.hp      || '',
    produk:       csOrder?.jumlah  || '',
    ekspedisi:    ekspedisi   || '',
    kota_tujuan:  kota        || '',
    case_undel:   caseUndel   || '',
    fu_count:     1,
    fu_info_at:   now,
  };

  // Upsert — kalau resi sudah ada (status BERMASALAH berulang) tidak timpa data
  await sbFetch('room_work?on_conflict=resi', {
    method:  'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body:    JSON.stringify(record),
  });

  // Kirim FU Info WA ke CS
  if (csNoWa && csNama) {
    const msg = FU_MSG.info(csNama, resi, ekspedisi, kota, caseUndel);
    await sendWA(csNoWa, msg)
      .catch(e => console.error('[room-work] FU Info WA gagal:', e.message));
    console.log(`[room-work] FU Info → ${csNama} (${csNoWa}) resi ${resi}`);
  } else {
    console.warn(`[room-work] No WA tidak ditemukan untuk CS "${csNama}" — FU Info dilewati`);
  }
}

module.exports = { insertRoomWork, FU_MSG };
