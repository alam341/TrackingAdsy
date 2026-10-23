// Kirim WA via baileys-notif VPS
// Dipanggil dari mengantar-webhook.js saat paket jadi BERMASALAH

const NOTIF_URL    = process.env.NOTIF_VPS_URL  || 'http://13.140.178.4:3002';
const NOTIF_SECRET = process.env.NOTIF_SECRET   || 'adsysukses2026';

const CS_SUPABASE_URL = 'https://lqpcnzdssvvcayqvdjxs.supabase.co';

/**
 * Kirim WA ke satu nomor via baileys-notif VPS
 * @param {string} to   - nomor WA (format: 628xxx)
 * @param {string} msg  - isi pesan
 */
async function sendWA(to, msg) {
  const r = await fetch(`${NOTIF_URL}/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-secret': NOTIF_SECRET,
    },
    body: JSON.stringify({ to, message: msg }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`baileys-notif error ${r.status}: ${txt}`);
  }
  return await r.json();
}

/**
 * Ambil no_wa CS dari cs_profiles (CS Input Supabase) berdasarkan nama
 * @param {string} csNama
 * @returns {string|null}
 */
async function getCsNoWa(csNama) {
  const serviceKey = process.env.CS_INPUT_SERVICE_KEY;
  if (!serviceKey || !csNama) return null;

  const encoded = encodeURIComponent(csNama);
  const r = await fetch(
    `${CS_SUPABASE_URL}/rest/v1/cs_profiles?select=no_wa&nama=ilike.${encoded}&limit=1`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    }
  );
  if (!r.ok) return null;
  const rows = await r.json();
  return rows?.[0]?.no_wa || null;
}

/**
 * Notif WA ke CS kalau paket bermasalah
 * @param {{ resi: string, csNama: string, kota: string, ekspedisi: string }} order
 */
async function notifBermasalah({ resi, csNama, kota, ekspedisi }) {
  const noWa = await getCsNoWa(csNama);
  if (!noWa) {
    console.warn(`[notif] CS "${csNama}" tidak ditemukan atau no_wa kosong — notif dilewati`);
    return;
  }

  const msg =
    `⚠️ *Paket Bermasalah*\n\n` +
    `Halo ${csNama}, ada paket kamu yang bermasalah:\n\n` +
    `📦 Resi: *${resi}*\n` +
    `🚚 Ekspedisi: ${ekspedisi || '-'}\n` +
    `📍 Kota Tujuan: ${kota || '-'}\n\n` +
    `Segera follow up ke kurir ya! 🙏`;

  await sendWA(noWa, msg);
  console.log(`[notif] WA terkirim ke CS "${csNama}" (${noWa}) untuk resi ${resi}`);
}

module.exports = { notifBermasalah, sendWA, getCsNoWa };
