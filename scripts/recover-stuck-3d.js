// scripts/recover-stuck-3d.js
// glb_status='processing' のアイテムについて、Tripo の実状態を確認し、
// success ならGLBをSupabase Storageに永続化してDBを completed に更新する。
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const TRIPO_KEY = process.env.TRIPO_API_KEY;
const TRIPO_BASE = 'https://api.tripo3d.ai/v2/openapi';
const BUCKET = 'collection-models';

async function persistGlb(sessionId, itemId, tripoGlbUrl) {
  const res = await fetch(tripoGlbUrl);
  if (!res.ok) throw new Error(`GLB download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  const filename = `${sessionId}/${itemId}.glb`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(filename, buffer, { contentType: 'model/gltf-binary', upsert: true });
  if (error) throw new Error(`GLB upload failed: ${error.message}`);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(filename);
  return data.publicUrl;
}

const { data: rows, error } = await supabase
  .from('collections')
  .select('id, session_id, name, tripo_task_id')
  .eq('glb_status', 'processing');

if (error) { console.error('Supabase error:', error); process.exit(1); }
console.log(`対象: ${rows.length} 件`);

for (const row of rows) {
  if (!row.tripo_task_id) {
    console.log(`⏭️ [${row.name}] task_id なし、スキップ`);
    continue;
  }

  const r = await fetch(`${TRIPO_BASE}/task/${row.tripo_task_id}`, {
    headers: { Authorization: `Bearer ${TRIPO_KEY}` }
  });
  const j = await r.json();
  const status = j.data?.status;
  console.log(`[${row.name}] Tripo status: ${status}`);

  if (status === 'success') {
    const tripoGlbUrl = j.data?.output?.pbr_model || j.data?.result?.pbr_model?.url;
    if (!tripoGlbUrl) { console.log('  ⚠️ GLB URL 取れず'); continue; }

    let finalUrl = tripoGlbUrl;
    try {
      finalUrl = await persistGlb(row.session_id, row.id, tripoGlbUrl);
      console.log(`  💾 Storage 保存: ${finalUrl}`);
    } catch (e) {
      console.log(`  ⚠️ Storage 失敗、Tripo URL 直使用: ${e.message}`);
    }

    const { error: upErr } = await supabase
      .from('collections')
      .update({ glb_status: 'completed', glb_url: finalUrl })
      .eq('id', row.id);
    if (upErr) console.log(`  ❌ DB 更新失敗: ${upErr.message}`);
    else console.log(`  ✅ completed に更新`);
  } else if (status === 'failed') {
    await supabase.from('collections').update({ glb_status: 'failed' }).eq('id', row.id);
    console.log('  ❌ failed に更新');
  } else {
    console.log('  ⏳ まだ処理中、何もしない');
  }
}
