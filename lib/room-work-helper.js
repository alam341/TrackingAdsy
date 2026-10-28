// lib/room-work-helper.js
// Helper untuk insert Room Work + kirim FU Info (notifikasi pertama, langsung saat BERMASALAH)
// Dipanggil dari mengantar-webhook.js

const { sbFetch }   = require('./supabase-rest');
const { sendWA, getCsNoWa } = require('./notif-wa');

const CS_SUPABASE_URL = 'https://lqpcnzdssvvcayqvdjxs.supabase.co';

// ── Default template ───────────────────────────────────────────────────────────
const FU_DEFAULTS = {
  info: `⚠️ *[Info] Paket Bermasalah*\n\nHalo [nama_cs]!\n\nAda paket yang perlu ditindaklanjuti:\n\n👤 Customer: [nama_customer] ([hp_customer])\n📦 Produk: [produk]\n🔢 Resi: *[resi]*\n🚚 Ekspedisi: [ekspedisi]\n📍 Kota: [kota]\n❌ Kasus: [kasus]\n\nMohon segera follow up ke kurir ya! 🙏`,
  fu1:  `📨 *[FU 1] Paket Bermasalah*\n\nHalo [nama_cs], mengingatkan:\n\n👤 Customer: [nama_customer] ([hp_customer])\n📦 Produk: [produk]\n🔢 Resi: *[resi]*\n🚚 Ekspedisi: [ekspedisi]\n📍 Kota: [kota]\n❌ Kasus: [kasus]\n\nBelum ada update — mohon segera dikonfirmasi! 🙏`,
  fu2:  `🔔 *[FU 2] Pengingat Paket Bermasalah*\n\nHalo [nama_cs], mengingatkan kembali:\n\n👤 Customer: [nama_customer] ([hp_customer])\n📦 Produk: [produk]\n🔢 Resi: *[resi]*\n🚚 Ekspedisi: [ekspedisi]\n📍 Kota: [kota]\n❌ Kasus: [kasus]\n\nSudah 2 hari belum ada konfirmasi — tolong segera ditindak! 🙏`,
  fu3:  `🚨 *[FU 3 - Terakhir] Paket Bermasalah*\n\nHalo [nama_cs], ini follow up terakhir:\n\n👤 Customer: [nama_customer] ([hp_customer])\n📦 Produk: [produk]\n🔢 Resi: *[resi]*\n🚚 Ekspedisi: [ekspedisi]\n📍 Kota: [kota]\n❌ Kasus: [kasus]\n\nHarap konfirmasi hari ini ya! 🙏`,
};

// ── Ambil template dari Supabase (cache per proses) ───────────────────────────
let _tplCache = null;
async function getTemplates() {
  if (_tplCache) return _tplCache;
  try {
    const rows = await sbFetch(
      'settings?select=key,value&key=in.(fu_template_info,fu_template_fu1,fu_template_fu2,fu_template_fu3)'
    );
    const map = {};
    (rows || []).forEach(r => { map[r.key] = r.value; });
    _tplCache = {
      info: map['fu_template_info'] || FU_DEFAULTS.info,
      fu1:  map['fu_template_fu1']  || FU_DEFAULTS.fu1,
      fu2:  map['fu_template_fu2']  || FU_DEFAULTS.fu2,
      fu3:  map['fu_template_fu3']  || FU_DEFAULTS.fu3,
    };
  } catch {
    _tplCache = { ...FU_DEFAULTS };
  }
  return _tplCache;
}

// ── Isi variabel ke template ───────────────────────────────────────────────────
function fillTemplate(tpl, vars) {
  return tpl
    .replace(/\[nama_cs\]/g,       vars.cs          || '-')
    .replace(/\[nama_customer\]/g, vars.namaPembeli  || '-')
    .replace(/\[hp_customer\]/g,   vars.hpPembeli    || '-')
    .replace(/\[produk\]/g,        vars.produk       || '-')
    .replace(/\[resi\]/g,          vars.resi         || '-')
    .replace(/\[ekspedisi\]/g,     vars.ekspedisi    || '-')
    .replace(/\[kota\]/g,          vars.kota         || '-')
    .replace(/\[kasus\]/g,         vars.caseUndel    || '-');
}

// ── Pesan FU (async, baca template dari Supabase) ─────────────────────────────
async function buildFuMsg(tplKey, vars) {
  const tpls = await getTemplates();
  return fillTemplate(tpls[tplKey], vars);
}

// ── Ambil data order dari CS Input (nama pembeli, hp, produk) ─────────────────
async function fetchCsInputOrder(resi) {
  const key = process.env.CS_INPUT_SERVICE_KEY;
  if (!key || !resi) return null;
  try {
    const resiClean = resi.replace(/'/g, "''");
    const r = await fetch(
      `${CS_SUPABASE_URL}/rest/v1/all_orderan?select=nama,hp,jumlah,cs,kabupaten&resi=ilike.${encodeURIComponent(resiClean)}&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    const row = rows?.[0];
    if (!row) return null;
    // nama format: "NAMA PELANGGAN|SKU_BUNDLE|PROMO" — ambil bagian pertama
    return {
      ...row,
      nama: (row.nama || '').split('|')[0].trim() || row.nama || '',
    };
  } catch { return null; }
}

// ── Insert room_work + kirim FU Info ──────────────────────────────────────────
async function insertRoomWork({ resi, csNama, kota, ekspedisi, caseUndel, orderDate }) {
  // Ambil data lengkap dari CS Input — cs_nama & kota dari sini kalau parameter kosong
  const csOrder = await fetchCsInputOrder(resi);

  const resolvedCsNama = csNama || csOrder?.cs || '';
  const resolvedKota   = kota   || csOrder?.kabupaten || '';
  const csNoWa = await getCsNoWa(resolvedCsNama);

  const now = new Date().toISOString();
  const record = {
    resi,
    cs_nama:      resolvedCsNama,
    cs_no_wa:     csNoWa      || '',
    nama_pembeli: csOrder?.nama    || '',
    hp_pembeli:   csOrder?.hp      || '',
    produk:       csOrder?.jumlah  || '',
    ekspedisi:    ekspedisi   || '',
    kota_tujuan:  resolvedKota,
    case_undel:   caseUndel   || '',
    fu_count:     1,
    fu_info_at:   now,
    ...(orderDate ? { order_date: orderDate } : {}),
  };

  // Upsert — kalau resi sudah ada (status BERMASALAH berulang) tidak timpa data
  await sbFetch('room_work?on_conflict=resi', {
    method:  'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body:    JSON.stringify(record),
  });

  // Kirim FU Info WA ke CS
  if (csNoWa && resolvedCsNama) {
    const msg = await buildFuMsg('info', {
      cs: resolvedCsNama, resi, ekspedisi, kota: resolvedKota, caseUndel,
      namaPembeli: record.nama_pembeli, hpPembeli: record.hp_pembeli, produk: record.produk,
    });
    await sendWA(csNoWa, msg)
      .catch(e => console.error('[room-work] FU Info WA gagal:', e.message));
    console.log(`[room-work] FU Info → ${resolvedCsNama} (${csNoWa}) resi ${resi}`);
  } else {
    console.warn(`[room-work] No WA tidak ditemukan untuk CS "${resolvedCsNama}" — FU Info dilewati`);
  }
}

module.exports = { insertRoomWork };
