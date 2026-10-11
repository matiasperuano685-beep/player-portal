// Normaliza un teléfono al formato de WhatsApp (solo dígitos). Misma lógica que
// _shared/phone.ts del CRM: Argentina 549 + característica sin 0 + número sin 15,
// Perú 51 + 9 dígitos. Devuelve null si no se puede armar con seguridad.
function normalizePhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (!d) return null;
  if (d.startsWith('549') && d.length === 13) return d;
  if (d.startsWith('54') && d.length === 12) return '549' + d.slice(2);
  if (d.startsWith('54') && d.length === 14) {
    const fixed = strip15(d.slice(2));
    if (fixed) return '549' + fixed;
  }
  if (d.startsWith('51') && d.length === 11 && d[2] === '9') return d;
  if (d.startsWith('54') && d.length >= 11) return null;
  if (d.startsWith('51') && d.length === 11) return null;
  if (d.length === 9 && d[0] === '9') return '51' + d;
  if (d.startsWith('0')) d = d.slice(1);
  if (d.length === 10 && d.startsWith('15')) return null;
  if (d.length === 10) return '549' + d;
  if (d.length === 12) {
    const fixed = strip15(d);
    if (fixed) return '549' + fixed;
  }
  if (d.length >= 11 && d.length <= 15) return d;
  return null;
}

function strip15(d) {
  if (d.length !== 12) return null;
  for (const len of [2, 3, 4]) {
    if (len === 2 && !d.startsWith('11')) continue;
    if (d.slice(len, len + 2) === '15') return d.slice(0, len) + d.slice(len + 2);
  }
  return null;
}

module.exports = { normalizePhone };
