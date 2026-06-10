const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

function db() {
  // Service role key bypasses RLS — safe for server-side only
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  return createClient(process.env.SUPABASE_URL, key, {
    auth: { persistSession: false }
  });
}

async function dbAuthed() {
  return db();
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

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = { db, dbAuthed, signToken, verifyToken, cors };
