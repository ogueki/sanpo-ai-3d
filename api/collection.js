// api/collection.js - コレクション管理API
import OpenAI from 'openai';
import { getCollection, addToCollection, getCollectionItem, updateCollectionItem } from '../sessions/store.js';
import { supabase, BUCKETS } from '../lib/supabase.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// data:image/...;base64,xxx を Supabase Storage に保存して公開URLを返す
async function uploadImageToStorage(sessionId, base64DataUrl) {
  const match = base64DataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) throw new Error('画像形式が不正です');
  const mimeType = match[1];
  const ext = mimeType.split('/')[1] || 'jpg';
  const buffer = Buffer.from(match[2], 'base64');

  const filename = `${sessionId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const { error } = await supabase.storage
    .from(BUCKETS.IMAGES)
    .upload(filename, buffer, { contentType: mimeType, upsert: false });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data } = supabase.storage.from(BUCKETS.IMAGES).getPublicUrl(filename);
  return data.publicUrl;
}

export default async (req, res) => {
  if (req.method === 'GET') {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'sessionIdが必要です' });

    const collection = await getCollection(sessionId);
    const list = collection.map(({ id, name, description, image, model3d, createdAt }) => ({
      id, name, description, createdAt,
      thumbnail: image,
      hasImage: !!image,
      model3d: model3d ? { status: model3d.status, glbUrl: model3d.glbUrl } : null
    }));
    return res.json({ success: true, collection: list });
  }

  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { sessionId, image, action, itemId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionIdが必要です' });
    }

    if (action === 'get' && itemId) {
      const item = await getCollectionItem(sessionId, itemId);
      if (!item) return res.status(404).json({ error: 'アイテムが見つかりません' });
      return res.json({ success: true, item });
    }

    if (action === 'update' && itemId) {
      const { name, description } = req.body;
      const updates = {};
      if (typeof name === 'string') {
        const trimmed = name.trim();
        if (!trimmed) return res.status(400).json({ error: '名前は空にできません' });
        if (trimmed.length > 80) return res.status(400).json({ error: '名前が長すぎます（80文字以内）' });
        updates.name = trimmed;
      }
      if (typeof description === 'string') {
        if (description.length > 1000) return res.status(400).json({ error: '説明が長すぎます（1000文字以内）' });
        updates.description = description;
      }
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: '更新内容がありません' });
      }
      const updated = await updateCollectionItem(sessionId, itemId, updates);
      if (!updated) return res.status(404).json({ error: 'アイテムが見つかりません' });
      return res.json({ success: true, item: updated });
    }

    if (!image) {
      return res.status(400).json({ error: '画像が必要です' });
    }

    console.log(`🔍 [Collection] スキャン開始 session: ${sessionId}`);

    const identifyResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `あなたは対象物を識別する専門家です。画像に写っている主要な対象物を識別し、以下のJSON形式で返してください。
必ずJSONのみを返し、他のテキストは含めないでください。

{
  "name": "対象物の名前（短く、日本語）",
  "category": "カテゴリ（建物/植物/動物/食べ物/乗り物/アート/自然/その他）",
  "description": "2-3文の簡潔な説明（特徴や歴史的背景など）",
  "rarity": "コモン/レア/スーパーレア/レジェンド（珍しさに基づく）"
}`
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'この画像の主要な対象物を識別してください。' },
            { type: 'image_url', image_url: { url: image } }
          ]
        }
      ],
      temperature: 0.3,
      max_tokens: 300
    });

    let identified;
    try {
      const raw = identifyResponse.choices[0].message.content;
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      identified = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch {
      identified = {
        name: '不明なアイテム',
        category: 'その他',
        description: identifyResponse.choices[0].message.content,
        rarity: 'コモン'
      };
    }

    // 画像をSupabase Storageへアップロード
    const imageUrl = await uploadImageToStorage(sessionId, image);
    console.log(`📤 [Collection] 画像アップロード完了: ${imageUrl}`);

    const item = await addToCollection(sessionId, {
      name: identified.name,
      category: identified.category || 'その他',
      description: identified.description,
      rarity: identified.rarity || 'コモン',
      image_url: imageUrl
    });

    console.log(`✅ [Collection] "${item.name}" を追加 (${item.rarity})`);

    res.json({
      success: true,
      item: {
        id: item.id,
        name: item.name,
        category: item.category,
        description: item.description,
        rarity: item.rarity,
        model3d: item.model3d,
        createdAt: item.createdAt
      }
    });

  } catch (error) {
    console.error('❌ [Collection] Error:', error);
    res.status(500).json({ error: 'コレクション処理に失敗しました', details: error.message });
  }
};
