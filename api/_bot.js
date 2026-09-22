// Bot del chat del jugador: responde a los botones CARGAR / RETIRAR / SOPORTE,
// recibe comprobantes y avisa cuando un operador aprueba o rechaza.
// Los mensajes del bot se guardan como sender 'operator' + meta.bot = true, así
// el CRM (Chat Jugadores) y cualquier cliente viejo los siguen mostrando bien.

const BUCKET = 'comprobantes';
const PUBLIC_URL_RE = /https?:\/\/[^\s]+\/storage\/v1\/object\/(?:public|sign)\/comprobantes\/([^\s?]+)(\?[^\s]*)?/g;
const SIGNED_TTL = 60 * 60; // 1 hora

function money(n) {
  return Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 2 });
}

// El bot está activo si está prendido globalmente en portal_settings, o si el
// jugador está en BOT_TEST_USERS (para probar en un deploy de prueba sin afectar a nadie).
function botActive(settings, username) {
  if (settings?.bot_enabled) return true;
  const testers = (process.env.BOT_TEST_USERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return !!username && testers.includes(String(username).toLowerCase());
}

async function getSettings(client) {
  const { data } = await client.from('portal_settings').select('*').limit(1).maybeSingle();
  return data || {};
}

async function getOrCreateChat(client, playerId) {
  const { data: chats } = await client.from('portal_chats').select('*').eq('player_id', playerId).order('created_at', { ascending: true }).limit(1);
  if (chats?.length) return chats[0];
  const { data: chat } = await client.from('portal_chats').insert({ player_id: playerId }).select().single();
  return chat;
}

async function insertMessage(client, chatId, sender, body, meta) {
  const { data, error } = await client.from('portal_chat_messages')
    .insert({ chat_id: chatId, sender, body, meta: meta || null })
    .select('id, chat_id, sender, body, meta, created_at').single();
  if (error) throw error;
  return data;
}

// Suma no leídos del lado correcto y actualiza last_message_at.
async function touchChat(client, chatId, sender) {
  const { data: row } = await client.from('portal_chats').select('unread_operator, unread_player').eq('id', chatId).single();
  const upd = { last_message_at: new Date().toISOString() };
  if (sender === 'player') upd.unread_operator = (row?.unread_operator || 0) + 1;
  else upd.unread_player = (row?.unread_player || 0) + 1;
  await client.from('portal_chats').update(upd).eq('id', chatId);
}

async function botSay(client, chatId, body, meta) {
  const msg = await insertMessage(client, chatId, 'operator', body, { ...(meta || {}), bot: true });
  await touchChat(client, chatId, 'operator');
  return msg;
}

function bankLines(s) {
  return [
    s.bank_name && `🏦 Banco: ${s.bank_name}`,
    s.bank_cbu && `📋 CBU: ${s.bank_cbu}`,
    s.bank_alias && `🔤 Alias: ${s.bank_alias}`,
    s.bank_account_name && `👤 Titular: ${s.bank_account_name}`,
  ].filter(Boolean).join('\n');
}

// Respuesta del bot a un botón. Devuelve los mensajes que insertó.
async function replyToAction(client, { chatId, playerId, action, settings }) {
  if (action === 'cargar') {
    if (!settings.bank_cbu && !settings.bank_alias) {
      return [await botSay(client, chatId, 'En este momento no hay una cuenta cargada para transferir. Un operador te responde en breve 🙏', { type: 'text' })];
    }
    const body = `💰 Transferí a estos datos y después subí el comprobante 👇\n\n${bankLines(settings)}` +
      (settings.min_deposit ? `\n\nMínimo de carga: $${money(settings.min_deposit)}` : '');
    return [await botSay(client, chatId, body, {
      type: 'deposit_instructions',
      bank: { name: settings.bank_name || null, cbu: settings.bank_cbu || null, alias: settings.bank_alias || null, holder: settings.bank_account_name || null },
      min_deposit: Number(settings.min_deposit || 0),
    })];
  }

  if (action === 'retirar') {
    const { data: bank } = await client.from('portal_bank_accounts').select('bank_name, cbu, alias, account_name').eq('player_id', playerId).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!bank) {
      return [await botSay(client, chatId, '💸 Para retirar primero cargá la cuenta bancaria donde querés recibir la plata.', { type: 'need_bank' })];
    }
    const body = `💸 ¿Cuánto querés retirar? Te lo mandamos a:\n\n` +
      [bank.bank_name && `🏦 ${bank.bank_name}`, bank.cbu && `📋 CBU: ${bank.cbu}`, bank.alias && `🔤 Alias: ${bank.alias}`, bank.account_name && `👤 ${bank.account_name}`].filter(Boolean).join('\n') +
      (settings.min_withdrawal ? `\n\nMínimo de retiro: $${money(settings.min_withdrawal)}` : '');
    return [await botSay(client, chatId, body, { type: 'withdraw_form', bank, min_withdrawal: Number(settings.min_withdrawal || 0) })];
  }

  if (action === 'soporte') {
    return [await botSay(client, chatId, '🎧 Contanos tu consulta y un operador te responde en breve.', { type: 'text' })];
  }

  return [];
}

// Bienvenida con el menú, solo si hace 12 hs que nadie le escribe al jugador.
async function maybeWelcome(client, chatId) {
  const since = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  const { count } = await client.from('portal_chat_messages').select('id', { count: 'exact', head: true })
    .eq('chat_id', chatId).eq('sender', 'operator').gte('created_at', since);
  if (count) return [];
  return [await botSay(client, chatId, '👋 ¡Hola! ¿Qué querés hacer? Tocá una opción o escribinos tu consulta.', { type: 'menu' })];
}

// Reemplaza las URLs de comprobantes (públicas o firmadas viejas) por URLs firmadas
// nuevas, así el bucket puede ser privado sin romper los mensajes viejos.
async function signMessageUrls(client, messages) {
  const paths = new Set();
  for (const m of messages || []) {
    if (typeof m.body !== 'string') continue;
    for (const match of m.body.matchAll(PUBLIC_URL_RE)) paths.add(decodeURIComponent(match[1]));
  }
  if (!paths.size) return messages;
  const signed = await signPaths(client, [...paths]);
  if (!signed.size) return messages;
  return messages.map(m => {
    if (typeof m.body !== 'string') return m;
    const body = m.body.replace(PUBLIC_URL_RE, (full, p) => signed.get(decodeURIComponent(p)) || full);
    return body === m.body ? m : { ...m, body };
  });
}

// Firma varios paths de una vez. Devuelve Map path → url firmada.
async function signPaths(client, paths) {
  const unique = [...new Set((paths || []).filter(Boolean))];
  if (!unique.length) return new Map();
  const { data, error } = await client.storage.from(BUCKET).createSignedUrls(unique, SIGNED_TTL);
  if (error || !data) return new Map();
  return new Map(data.filter(d => d.signedUrl).map(d => [d.path, d.signedUrl]));
}

// Sube el comprobante y devuelve { path, url }. La url tiene formato "público"
// para que quede guardada estable en el mensaje; se firma al leer.
async function uploadComprobante(client, playerId, imageBase64, mimeType) {
  const allowed = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
  const ext = allowed[mimeType];
  if (!ext) throw Object.assign(new Error('Formato no permitido'), { status: 400 });
  const buffer = Buffer.from(imageBase64, 'base64');
  if (buffer.length > 4 * 1024 * 1024) throw Object.assign(new Error('El archivo es muy grande (máx 4 MB)'), { status: 400 });
  const path = `${playerId}_${Date.now()}.${ext}`;
  const { error } = await client.storage.from(BUCKET).upload(path, buffer, { contentType: mimeType, upsert: false });
  if (error) throw new Error('Error subiendo el comprobante');
  const url = `${process.env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
  return { path, url };
}

// Aviso al jugador cuando el operador resuelve una carga o retiro.
async function notifyTransactionResult(client, tx, action, operatorNotes) {
  const chat = await getOrCreateChat(client, tx.player_id);
  if (!chat) return null;
  const isDeposit = tx.type === 'deposit';
  let body;
  if (action === 'approve') {
    body = isDeposit
      ? `✅ ¡Listo! Tu carga de $${money(tx.amount)} fue acreditada. ¡A jugar! 🎰`
      : `✅ Tu retiro de $${money(tx.amount)} fue aprobado y ya está en camino a tu cuenta.`;
  } else {
    body = isDeposit
      ? `❌ No pudimos acreditar tu carga de $${money(tx.amount)}.`
      : `❌ Tu retiro de $${money(tx.amount)} fue rechazado.`;
    if (operatorNotes) body += `\nMotivo: ${operatorNotes}`;
    body += '\nSi tenés dudas, escribinos acá.';
  }
  return botSay(client, chat.id, body, { type: 'tx_result', tx_id: tx.id, result: action });
}

module.exports = {
  money, botActive, getSettings, getOrCreateChat, insertMessage, touchChat, botSay,
  replyToAction, maybeWelcome, signMessageUrls, signPaths, uploadComprobante, notifyTransactionResult,
};
