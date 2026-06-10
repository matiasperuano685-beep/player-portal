const { dbAuthed, cors } = require('../_lib');

function isOperator(req) {
  return req.headers['x-operator-key'] === process.env.OPERATOR_KEY;
}

module.exports = async (req, res) => {
  cors(res);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-operator-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!isOperator(req)) return res.status(403).json({ error: 'Acceso denegado' });

  const client = await dbAuthed();

  // GET — listar transacciones (con filtro por status)
  if (req.method === 'GET') {
    const status = req.query.status || 'pending';
    let query = client
      .from('portal_transactions')
      .select(`
        id, type, amount, status, notes, operator_notes, created_at, updated_at,
        portal_players (id, username, full_name, whatsapp, casino_username, balance)
      `)
      .order('created_at', { ascending: false });
    if (status !== 'all') query = query.eq('status', status);
    const { data, error } = await query.limit(200);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ data });
  }

  // PUT — aprobar / rechazar transacción
  if (req.method === 'PUT') {
    const { id, action, operator_notes } = req.body;
    if (!id || !action) return res.status(400).json({ error: 'Faltan datos' });
    if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Acción inválida' });

    const { data: tx, error: txErr } = await client
      .from('portal_transactions')
      .select('*, portal_players(id, balance)')
      .eq('id', id)
      .single();
    if (txErr || !tx) return res.status(404).json({ error: 'Transacción no encontrada' });
    if (tx.status !== 'pending') return res.status(409).json({ error: 'La transacción ya fue procesada' });

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    await client.from('portal_transactions').update({ status: newStatus, operator_notes: operator_notes || null, updated_at: new Date().toISOString() }).eq('id', id);

    // Actualizar balance si se aprueba
    if (action === 'approve') {
      const player = tx.portal_players;
      const currentBalance = Number(player.balance || 0);
      const delta = tx.type === 'deposit' ? Number(tx.amount) : -Number(tx.amount);
      await client.from('portal_players').update({ balance: Math.max(0, currentBalance + delta) }).eq('id', player.id);
    }

    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
};
