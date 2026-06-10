const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

// Orígenes permitidos explícitamente
const ALLOWED_ORIGINS = [
  'https://supercrm.best',
  'https://player-portal-vyb5.vercel.app',
  process.env.PORTAL_ORIGIN, // origen extra configurable por env var
].filter(Boolean);

function getAllowedOrigin(req) {
  const origin = req.headers.origin || '';
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[1];
}

function db() {
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  return createClient(process.env.SUPABASE_URL, key, {
    auth: { persistSession: false }
  });
}

function signToken(player) {
  return jwt.sign(
    { id: player.id, username: player.username, role: 'player' },
    process.env.PORTAL_JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function verifyToken(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.PORTAL_JWT_SECRET);
  } catch {
    return null;
  }
}

function cors(res, req) {
  const origin = req ? getAllowedOrigin(req) : ALLOWED_ORIGINS[1];
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-operator-key');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// Rate limiting simple en memoria (por IP)
const rateLimitStore = new Map();
function rateLimit(req, maxRequests = 10, windowMs = 60000) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rateLimitStore.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }
  entry.count++;
  rateLimitStore.set(ip, entry);
  // Limpiar entradas viejas cada tanto
  if (rateLimitStore.size > 2000) {
    for (const [k, v] of rateLimitStore) {
      if (now > v.resetAt) rateLimitStore.delete(k);
    }
  }
  return entry.count > maxRequests;
}

module.exports = { db, signToken, verifyToken, cors, rateLimit, getAllowedOrigin };
