const { db, verifyToken, cors } = require('../_lib');

module.exports = async (req, res) => {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const claim = verifyToken(req);
  if (!claim) return res.status(401).json({ error: 'No autorizado' });

  try {
    const { amount, notes } = req.body;
    if (!amount || isNaN(amount) || Number(amount) <= 0) return res.status(400).json({ error: 'Monto inválido' });

    const client = db();

    const { data: settings } = await client.from('portal_settings').select('min_deposit').limit(1).maybeSingle();
    const minDeposit = settings?.min_deposit || 0;
    if (Number(amount) < minDeposit) return res.status(400).json({ error: `El monto mínimo de carga es $${Number(minDeposit).toLocaleString('es-AR')}` });

    const { data: hasPending } = await client
      .from('portal_transactions')
      .select('id')
      .eq('player_id', claim.id)
      .eq('type', 'deposit')
      .eq('status', 'pending')
      .maybeSingle();

    if (hasPending) return res.status(409).json({ error: 'Ya tenés una carga pendiente de aprobación' });

    const { data, error } = await client
      .from('portal_transactions')
      .insert({ player_id: claim.id, type: 'deposit', amount: Number(amount), status: 'pending', notes: notes || null })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ ok: true, transaction: data });
  } catch (e) {
    res.status(500).json({ error: 'Error interno' });
  }
};
