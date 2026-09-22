// Cliente de LurkerPay (la billetera donde los jugadores transfieren).
// Solo lectura: consultar movimientos y verificar que una transferencia existe.
const BASE = process.env.LURKERPAY_BASE_URL || 'https://lurkerpay.com/api/v1/external';
const KEY = process.env.LURKERPAY_API_KEY;

function configurada() {
  return !!KEY;
}

async function get(path) {
  if (!KEY) throw new Error('LURKERPAY_API_KEY no configurada');
  const r = await fetch(BASE + path, { headers: { 'X-API-Key': KEY } });
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = data?.error?.message || data?.message || `HTTP ${r.status}`;
    throw Object.assign(new Error(msg), { status: r.status });
  }
  return data;
}

// Busca un ingreso confirmado. LurkerPay puede avisar por webhook, pero antes de
// tocar saldos confirmamos contra la API: así un aviso falso no sirve de nada.
async function buscarIngreso({ codigo_coelsa, referencia_externa, transaction_id, monto, cuenta_id, desde, hasta }) {
  const p = new URLSearchParams({ tipo: 'ingreso', status: 'confirmada', limit: '50', page: '1' });
  if (cuenta_id) p.set('cuenta_id', cuenta_id);
  if (desde) p.set('from', desde);
  if (hasta) p.set('to', hasta);
  const busqueda = codigo_coelsa || referencia_externa;
  if (busqueda) p.set('search', busqueda);
  const data = await get(`/transactions?${p.toString()}`);
  const filas = data?.data || [];

  // Si el aviso trae identificadores, tienen que coincidir. Nada de "no coincide
  // el número pero el monto sí": así un aviso inventado no se cuela.
  const tieneIdentificador = !!(codigo_coelsa || referencia_externa || transaction_id);
  if (tieneIdentificador) {
    // Comparar solo campos que existen: dos vacíos no son "iguales".
    const exacta = filas.find(t =>
      (codigo_coelsa && t.codigo_coelsa === codigo_coelsa) ||
      (referencia_externa && t.referencia_externa === referencia_externa) ||
      (transaction_id && t.id === transaction_id)
    );
    if (!exacta) return null;
    if (monto != null && Number(exacta.monto) !== Number(monto)) return null;
    return exacta;
  }

  if (monto != null) {
    const candidatas = filas.filter(t => Number(t.monto) === Number(monto));
    // Solo sirve si no hay ambigüedad: dos transferencias iguales no se pueden distinguir
    if (candidatas.length === 1) return candidatas[0];
  }
  return null;
}

module.exports = { configurada, get, buscarIngreso };
