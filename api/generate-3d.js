// api/generate-3d.js - 3Dモデル生成API（Tripo3D連携）
import { getCollectionItem, updateCollectionItem } from '../sessions/store.js';
import { supabase, BUCKETS } from '../lib/supabase.js';

const TRIPO_API_BASE = 'https://api.tripo3d.ai/v2/openapi';

// Tripo CDN上のGLBをダウンロードしてSupabase Storageに保存し、永続URLを返す
async function persistGlbToStorage(sessionId, itemId, tripoGlbUrl) {
  try {
    const res = await fetch(tripoGlbUrl);
    if (!res.ok) throw new Error(`GLB download failed: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());

    const filename = `${sessionId}/${itemId}.glb`;
    const { error } = await supabase.storage
      .from(BUCKETS.MODELS)
      .upload(filename, buffer, {
        contentType: 'model/gltf-binary',
        upsert: true
      });
    if (error) throw new Error(`GLB upload failed: ${error.message}`);

    const { data } = supabase.storage.from(BUCKETS.MODELS).getPublicUrl(filename);
    console.log(`💾 [3D] GLB永続化完了: ${data.publicUrl}`);
    return data.publicUrl;
  } catch (err) {
    console.error('⚠️ [3D] GLB永続化失敗、Tripo URLをそのまま使用:', err.message);
    return tripoGlbUrl;
  }
}

export default async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const tripoKey = process.env.TRIPO_API_KEY;

  try {
    const { sessionId, itemId, action } = req.body;

    if (!sessionId || !itemId) {
      return res.status(400).json({ error: 'sessionIdとitemIdが必要です' });
    }

    const item = await getCollectionItem(sessionId, itemId);
    if (!item) {
      return res.status(404).json({ error: 'アイテムが見つかりません' });
    }

    if (!tripoKey) {
      return res.json({
        success: true,
        status: 'unavailable',
        message: 'TRIPO_API_KEYが未設定です。.envに追加してください。'
      });
    }

    const headers = {
      'Authorization': `Bearer ${tripoKey}`,
      'Content-Type': 'application/json'
    };

    // ステータス確認
    if (action === 'status') {
      if (!item.model3d?.taskId) {
        return res.json({ success: true, status: item.model3d?.status || 'none' });
      }

      const statusRes = await fetch(`${TRIPO_API_BASE}/task/${item.model3d.taskId}`, { headers });
      if (!statusRes.ok) throw new Error(`Tripo status API error: ${statusRes.status}`);

      const statusData = await statusRes.json();
      const taskStatus = statusData.data?.status;
      console.log(`🔍 [3D] タスク ${item.model3d.taskId} status: ${taskStatus}`);

      if (taskStatus === 'success') {
        const tripoGlbUrl = statusData.data?.output?.pbr_model
          || statusData.data?.result?.pbr_model?.url
          || null;

        let finalGlbUrl = tripoGlbUrl;
        if (tripoGlbUrl) {
          finalGlbUrl = await persistGlbToStorage(sessionId, itemId, tripoGlbUrl);
        }

        await updateCollectionItem(sessionId, itemId, {
          model3d: { status: 'completed', taskId: item.model3d.taskId, glbUrl: finalGlbUrl }
        });
        return res.json({ success: true, status: 'completed', glbUrl: finalGlbUrl });
      }

      if (taskStatus === 'failed') {
        await updateCollectionItem(sessionId, itemId, {
          model3d: { status: 'failed', taskId: item.model3d.taskId, glbUrl: null }
        });
        return res.json({ success: true, status: 'failed' });
      }

      return res.json({
        success: true,
        status: 'processing',
        progress: statusData.data?.progress || 0
      });
    }

    // 3D生成を開始
    if (item.model3d?.status === 'processing' || item.model3d?.status === 'completed') {
      return res.json({
        success: true,
        status: item.model3d.status,
        message: '既に処理中または完了しています'
      });
    }

    console.log(`🎨 [3D] 生成開始: ${item.name}`);

    // image はSupabase StorageのURLになっているので、フェッチしてバッファ化
    if (!item.image) {
      throw new Error('画像URLがありません');
    }
    const imgRes = await fetch(item.image);
    if (!imgRes.ok) throw new Error(`画像取得失敗: ${imgRes.status}`);
    const imageBuffer = Buffer.from(await imgRes.arrayBuffer());
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const ext = contentType.includes('png') ? 'png' : 'jpg';
    const mimeType = contentType.includes('png') ? 'image/png' : 'image/jpeg';

    // multipart/form-data でTripoにアップロード
    const boundary = '----TripoUpload' + Date.now();
    const bodyParts = [
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="file"; filename="scan.${ext}"\r\n`,
      `Content-Type: ${mimeType}\r\n\r\n`,
    ];
    const bodyStart = Buffer.from(bodyParts.join(''));
    const bodyEnd = Buffer.from(`\r\n--${boundary}--\r\n`);
    const uploadBody = Buffer.concat([bodyStart, imageBuffer, bodyEnd]);

    const uploadRes = await fetch(`${TRIPO_API_BASE}/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tripoKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body: uploadBody
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error(`Tripo upload error: ${uploadRes.status} - ${errText}`);
    }

    const uploadData = await uploadRes.json();
    const imageToken = uploadData.data?.image_token;
    if (!imageToken) throw new Error('画像アップロードに失敗しました（tokenなし）');

    console.log(`📤 [3D] 画像アップロード成功: ${imageToken}`);

    const createRes = await fetch(`${TRIPO_API_BASE}/task`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'image_to_model',
        file: { type: ext, file_token: imageToken }
      })
    });

    if (!createRes.ok) {
      const errBody = await createRes.text();
      throw new Error(`Tripo API error: ${createRes.status} - ${errBody}`);
    }

    const createData = await createRes.json();
    const taskId = createData.data?.task_id;
    if (!taskId) throw new Error('タスク作成に失敗しました（task_idなし）');

    console.log(`✅ [3D] タスク作成成功: ${taskId}`);

    await updateCollectionItem(sessionId, itemId, {
      model3d: { status: 'processing', taskId, glbUrl: null }
    });

    res.json({ success: true, status: 'processing', taskId });

  } catch (error) {
    console.error('❌ [3D] Error:', error);
    res.status(500).json({ error: '3D生成に失敗しました', details: error.message });
  }
};
