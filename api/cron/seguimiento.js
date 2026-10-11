const crypto = require('crypto');
const { db } = require('../_lib');
const bot = require('../_bot');
const { avisarWhatsApp } = require('../_casino');

// Seguimiento automático (cada 10 min) de quienes todavía no cargaron:
//   reg_1h  → registrado hace 1 h a 24 h sin ninguna carga: WhatsApp con usuario,
//             contraseña y el bono.
//   reg_24h → registrado hace 24 h a 7 días sin carga: segundo y último WhatsApp.
//   cbu:<id> → le pasamos los datos para transferir (bot o cajero) hace 20 min a 6 h,
//             no pidió la carga ni volvió a escribir: "¿pudiste transferir?" por el chat
//             y por WhatsApp. Uno cada 24 h como máximo.
// Cada aviso queda en portal_followups (no se repite). Los WhatsApp salen solo de 9 a
// 23:30 (hora argentina) y de a pocos por corrida; fuera de horario quedan para después.
const MAX_WA_POR_CORRIDA = 12;
const HORA = 3600e3;

function descifrarClave(valor) {
  try {
    const [iv, tag, enc] = String(valor || '').split('.').map((x) => Buffer.from(x, 'base64'));
    const key = crypto.createHash('sha256').update(`${process.env.PORTAL_JWT_SECRET}:password-enc`).digest();
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch { return null; }
}

function enHorario() {
  const ar = new Date(Date.now() - 3 * HORA);
  const h = ar.getUTCHours() + ar.getUTCMinutes() / 60;
  return h >= 9 && h < 23.5;
}

const primerNombre = (p) => String(p.full_name || '').trim().split(' ')[0];
const bonoPendiente = (p) => Number(p.welcome_bonus_pct) > 0 && !p.welcome_bonus_used_at ? Number(p.welcome_bonus_pct) : 0;
// Cajero pegando un CBU/CVU (22 dígitos). La palabra "alias" sola no alcanza: también
// la usan para pedirle al jugador su cuenta para un retiro.
const PASA_DATOS = /\b\d{22}\b/;

function textoRegistro(p, settings, segundo) {
  const nombre = primerNombre(p);
  const clave = descifrarClave(p.password_enc);
  const bono = bonoPendiente(p);
  const l = segundo
    ? [`¡Hola${nombre ? ' ' + nombre : ''}! 👋 Te escribimos de *CapiBet*.`, bono ? `Tu *${bono}% extra* en la primera carga sigue disponible 🎁` : 'Tu cuenta ya está lista para jugar 🎰']
    : [`¡Hola${nombre ? ' ' + nombre : ''}! 👋 Te escribimos de *CapiBet*. Tu cuenta ya está lista:`];
  l.push('', `👤 Usuario: *${p.username}*`);
  l.push(clave ? `🔑 Contraseña: *${clave}*` : '🔑 Si no te acordás la contraseña, respondé este mensaje y te la pasamos.');
  if (settings?.casino_url) l.push(`🎰 Jugá acá: ${settings.casino_url}`);
  if (!segundo && bono) l.push('', `🎁 Tenés *${bono}% extra* en tu primera carga.`);
  l.push('', '👉 *Respondé este mensaje* y te pasamos los datos para cargar fichas 💰');
  return l.join('\n');
}

function textoCbu(p) {
  const bono = bonoPendiente(p);
  return [
    `¿Pudiste hacer la transferencia${primerNombre(p) ? ', ' + primerNombre(p) : ''}? 🙌`,
    'Cuando la hagas, mandanos el comprobante por acá y te acreditamos las fichas al toque.',
    bono ? `🎁 Acordate que tu primera carga tiene *${bono}% extra*.` : null,
    'Si tuviste algún problema para transferir, escribinos y te ayudamos.',
  ].filter(Boolean).join('\n');
}

module.exports = async (req, res) => {
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'No autorizado' });

  const client = db();
  const settings = await bot.getSettings(client);
  const ahora = Date.now();
  const horario = enHorario();
  let waEnviados = 0;
  const out = { reg_1h: 0, reg_24h: 0, cbu_chat: 0, cbu_wa: 0, fuera_de_horario: !horario, errores: 0 };

  const registrar = (player_id, kind, channel) =>
    client.from('portal_followups').insert({ player_id, kind, channel }).then(({ error }) => !error);

  const mandarWa = async (p, text, kind) => {
    if (!p.whatsapp || !horario || waEnviados >= MAX_WA_POR_CORRIDA) return false;
    try {
      const r = await avisarWhatsApp({ whatsapp: p.whatsapp, full_name: p.full_name, username: p.username, text, kind });
      if (r?.skipped) return false;
      waEnviados++;
      return true;
    } catch (e) {
      out.errores++;
      console.warn(`seguimiento ${kind} ${p.username}:`, e.message);
      return false;
    }
  };

  // ── B: le pasamos los datos para transferir y no volvió ──────────────────
  const { data: msgsDatos } = await client.from('portal_chat_messages')
    .select('id, chat_id, body, meta, created_at')
    .eq('sender', 'operator')
    .gte('created_at', new Date(ahora - 6 * HORA).toISOString())
    .lte('created_at', new Date(ahora - 20 * 60e3).toISOString())
    .order('created_at', { ascending: false })
    .limit(500);
  const ultimoPorChat = new Map();
  for (const m of msgsDatos || []) {
    const esDatos = m.meta?.type === 'deposit_instructions' || (!m.meta?.bot && PASA_DATOS.test(m.body || ''));
    if (esDatos && !ultimoPorChat.has(m.chat_id)) ultimoPorChat.set(m.chat_id, m);
  }
  for (const m of ultimoPorChat.values()) {
    try {
      const { data: chat } = await client.from('portal_chats').select('*').eq('id', m.chat_id).maybeSingle();
      if (!chat) continue;
      const { data: p } = await client.from('portal_players').select('*').eq('id', chat.player_id).maybeSingle();
      if (!p || p.status !== 'active') continue;
      // ¿Ya pidió la carga (con o sin comprobante) después de recibir los datos?
      const { data: tx } = await client.from('portal_transactions').select('id').eq('player_id', p.id).eq('type', 'deposit')
        .gte('created_at', new Date(Date.parse(m.created_at) - 10 * 60e3).toISOString()).limit(1);
      if (tx?.length) continue;
      // Si el jugador volvió a escribir, o la charla sigue activa (último mensaje hace menos
      // de 20 min), lo está atendiendo un cajero.
      if (chat.last_message_at && ahora - Date.parse(chat.last_message_at) < 20 * 60e3) continue;
      const { data: despues } = await client.from('portal_chat_messages').select('id').eq('chat_id', chat.id)
        .eq('sender', 'player').gt('created_at', m.created_at).limit(1);
      if (despues?.length) continue;
      const { data: reciente } = await client.from('portal_followups').select('id').eq('player_id', p.id).like('kind', 'cbu:%')
        .gte('created_at', new Date(ahora - 24 * HORA).toISOString()).limit(1);
      if (reciente?.length) continue;

      const texto = textoCbu(p);
      const enChat = bot.botActive(settings, p.username, chat);
      const porWa = await mandarWa(p, texto, 'seguimiento_cbu');
      if (!enChat && !porWa) continue;
      if (!(await registrar(p.id, `cbu:${m.id}`, enChat && porWa ? 'both' : enChat ? 'chat' : 'whatsapp'))) continue;
      if (enChat) { await bot.botSay(client, chat.id, texto, { type: 'followup_cbu' }); out.cbu_chat++; }
      if (porWa) out.cbu_wa++;
    } catch (e) { out.errores++; console.warn('seguimiento cbu:', e.message); }
  }

  // ── A: registrados que no cargaron ───────────────────────────────────────
  if (horario && waEnviados < MAX_WA_POR_CORRIDA) {
    const { data: players } = await client.from('portal_players')
      .select('id, username, full_name, whatsapp, password_enc, welcome_bonus_pct, welcome_bonus_used_at, created_at')
      .in('signup_source', ['landing', 'portal'])
      .eq('status', 'active')
      .not('whatsapp', 'is', null)
      .gte('created_at', new Date(ahora - 7 * 24 * HORA).toISOString())
      .lte('created_at', new Date(ahora - HORA).toISOString())
      .order('created_at', { ascending: false })
      .limit(300);
    const ids = (players || []).map((p) => p.id);
    if (ids.length) {
      const [{ data: txs }, { data: fups }] = await Promise.all([
        client.from('portal_transactions').select('player_id').eq('type', 'deposit').in('player_id', ids),
        client.from('portal_followups').select('player_id, kind, created_at').in('player_id', ids),
      ]);
      const cargaron = new Set((txs || []).map((t) => t.player_id));
      const avisos = new Map();
      for (const f of fups || []) {
        if (!avisos.has(f.player_id)) avisos.set(f.player_id, []);
        avisos.get(f.player_id).push(f);
      }
      for (const p of players) {
        if (waEnviados >= MAX_WA_POR_CORRIDA) break;
        if (cargaron.has(p.id)) continue;
        const ya = avisos.get(p.id) || [];
        // Si hace poco le escribimos por otro motivo (p. ej. "¿pudiste transferir?"), esperar.
        if (ya.some((f) => ahora - Date.parse(f.created_at) < 6 * HORA)) continue;
        const edad = ahora - Date.parse(p.created_at);
        let kind = null;
        if (edad < 24 * HORA && !ya.some((f) => f.kind === 'reg_1h')) kind = 'reg_1h';
        else if (edad >= 24 * HORA && !ya.some((f) => f.kind === 'reg_24h')) kind = 'reg_24h';
        if (!kind) continue;
        // Reservar primero (evita duplicados si dos corridas se pisan); si falla el envío, se libera.
        if (!(await registrar(p.id, kind, 'whatsapp'))) continue;
        const ok = await mandarWa(p, textoRegistro(p, settings, kind === 'reg_24h'), `seguimiento_${kind}`);
        if (ok) out[kind]++;
        else await client.from('portal_followups').delete().eq('player_id', p.id).eq('kind', kind);
      }
    }
  }

  return res.status(200).json(out);
};
