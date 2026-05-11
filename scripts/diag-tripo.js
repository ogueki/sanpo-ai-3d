// scripts/diag-tripo.js
// processing 状態のアイテムを Supabase から拾い、各 Tripo タスクの実状態を表示する。
// 追加で Tripo の残クレジットも確認。
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const TRIPO_KEY = process.env.TRIPO_API_KEY;
const TRIPO_BASE = 'https://api.tripo3d.ai/v2/openapi';

async function tripoGet(path) {
  const r = await fetch(`${TRIPO_BASE}${path}`, {
    headers: { Authorization: `Bearer ${TRIPO_KEY}` }
  });
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text) }; }
  catch { return { status: r.status, text }; }
}

const balance = await tripoGet('/user/balance');
console.log('--- Tripo Balance ---');
console.log(JSON.stringify(balance, null, 2));

const { data: rows, error } = await supabase
  .from('collections')
  .select('id, name, glb_status, tripo_task_id, created_at')
  .eq('glb_status', 'processing')
  .order('created_at', { ascending: false })
  .limit(10);

if (error) { console.error('Supabase error:', error); process.exit(1); }
console.log(`\n--- processing アイテム: ${rows.length} 件 ---`);

for (const row of rows) {
  console.log(`\n[${row.name}] id=${row.id} task=${row.tripo_task_id} created=${row.created_at}`);
  if (!row.tripo_task_id) { console.log('  → task_id なし（生成開始前に失敗？）'); continue; }
  const t = await tripoGet(`/task/${row.tripo_task_id}`);
  console.log('  Tripo response:', JSON.stringify(t, null, 2));
}
