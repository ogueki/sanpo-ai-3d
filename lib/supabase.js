// lib/supabase.js - Supabaseクライアント（サーバ専用：service_roleキーを使用）
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('⚠️ [Supabase] SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が未設定です');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

export const BUCKETS = {
  IMAGES: 'collection-images',
  MODELS: 'collection-models'
};
