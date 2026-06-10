-- Ejecutar esto en el SQL Editor de Supabase
-- https://supabase.com → tu proyecto → SQL Editor

-- Jugadores del portal
CREATE TABLE IF NOT EXISTS portal_players (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  whatsapp TEXT,
  casino_username TEXT,
  balance DECIMAL(12,2) DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Cuentas bancarias de jugadores
CREATE TABLE IF NOT EXISTS portal_bank_accounts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  player_id UUID REFERENCES portal_players(id) ON DELETE CASCADE,
  bank_name TEXT,
  cbu TEXT,
  alias TEXT,
  account_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Transacciones (cargas y retiros)
CREATE TABLE IF NOT EXISTS portal_transactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  player_id UUID REFERENCES portal_players(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('deposit','withdrawal')),
  amount DECIMAL(12,2) NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  notes TEXT,
  operator_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Configuración del operador (CBU destino, WhatsApp, etc.)
CREATE TABLE IF NOT EXISTS portal_settings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  whatsapp_number TEXT,
  casino_url TEXT,
  min_deposit DECIMAL(12,2) DEFAULT 3000,
  min_withdrawal DECIMAL(12,2) DEFAULT 5000,
  bank_cbu TEXT,
  bank_alias TEXT,
  bank_name TEXT,
  bank_account_name TEXT
);

-- Deshabilitar RLS para acceso desde serverless functions
ALTER TABLE portal_players DISABLE ROW LEVEL SECURITY;
ALTER TABLE portal_bank_accounts DISABLE ROW LEVEL SECURITY;
ALTER TABLE portal_transactions DISABLE ROW LEVEL SECURITY;
ALTER TABLE portal_settings DISABLE ROW LEVEL SECURITY;
