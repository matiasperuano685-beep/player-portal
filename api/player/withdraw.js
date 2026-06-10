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

    const { data: player } = await client.from('portal_players').select('balance').eq('id', claim.id).single();
    const { data: settings } = await client.from('portal_settings').select('min_withdrawal').limit(1).maybeSingle();

    const minWithdrawal = settings?.min_withdrawal || 0;
    if (Number(amount) < minWithdrawal) return res.status(400).json({ error: `El monto mínimo de retiro es $${Number(minWithdrawal).toLocaleString('es-AR')}` });
    if (Number(amount) > Number(player?.balance || 0)) return res.status(400).json({ error: 'Saldo insuficiente' });

    const { data: bank } = await client
      .from('portal_bank_accounts')
      .select('id')
      .eq('player_id', claim.id)
      .limit(1)
      .maybeSingle();
    if (!bank) return res.status(400).json({ error: 'Debés cargar tu cuenta bancaria antes de retirar' });

    const { data: hasPending } = await client
      .from('portal_transactions')
      .select('id')
      .eq('player_id', claim.id)
      .eq('type', 'withdrawal')
      .eq('status', 'pending')
      .maybeSingle();
    if (hasPending) return res.status(409).json({ error: 'Ya tenés un retiro pendiente de aprobación' });

    const { data, error } = await client
      .from('portal_transactions')
      .insert({ player_id: claim.id, type: 'withdrawal', amount: Number(amount), status: 'pending', notes: notes || null })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ ok: true, transaction: data });
  } catch (e) {
    res.status(500).json({ error: 'Error interno' });
  }
};
