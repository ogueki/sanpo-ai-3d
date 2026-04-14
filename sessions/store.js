// sessions/store.js
// 会話履歴・撮影画像はインメモリ（揮発OK、Vercelでも各リクエスト内で完結）
// コレクションは Supabase Postgres + Storage で永続化

import { supabase } from '../lib/supabase.js';

const MAX_TURNS = 5;
const sessions = {};

function ensureSession(id) {
  return sessions[id] ||= { history: [], images: [], descriptions: [] };
}

/* ── 会話履歴・画像（揮発） ── */

export const getHistory = (id) => sessions[id]?.history ?? [];

export const getLatestImage = (id) => {
  const images = sessions[id]?.images ?? [];
  return images.length > 0 ? images[images.length - 1] : null;
};

export const getDescriptions = (id) => sessions[id]?.descriptions ?? [];

export const pushHistory = (id, msg) => {
  const s = ensureSession(id);
  s.history.push(msg);
  while (s.history.length > MAX_TURNS * 2) s.history.shift();
};

export const resetSession = (id) => {
  if (sessions[id]) {
    delete sessions[id];
    return true;
  }
  return false;
};

export const addImageAndDescription = (id, image, description) => {
  const s = ensureSession(id);
  s.images.push({ data: image, timestamp: new Date().toISOString() });
  s.descriptions.push(description);
  while (s.images.length > 5) s.images.shift();
  while (s.descriptions.length > 5) s.descriptions.shift();
  console.log(`✅ [Store] 履歴保存. 画像数: ${s.images.length}`);
};

/* ── コレクション（Supabase永続化） ── */

// DB行を旧来のitem形状に変換（呼び出し側の互換維持）
function rowToItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    category: row.category || 'その他',
    description: row.description,
    rarity: row.rarity,
    image: row.image_url,
    model3d: {
      status: row.glb_status || 'none',
      taskId: row.tripo_task_id || null,
      glbUrl: row.glb_url || null
    },
    createdAt: row.created_at
  };
}

export const getCollection = async (sessionId) => {
  const { data, error } = await supabase
    .from('collections')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('❌ [Store] getCollection error:', error);
    return [];
  }
  return (data || []).map(rowToItem);
};

export const addToCollection = async (sessionId, item) => {
  const insertRow = {
    session_id: sessionId,
    name: item.name,
    category: item.category || 'その他',
    description: item.description,
    rarity: item.rarity || 'コモン',
    image_url: item.image_url || null,
    glb_status: 'none'
  };

  const { data, error } = await supabase
    .from('collections')
    .insert(insertRow)
    .select()
    .single();

  if (error) {
    console.error('❌ [Store] addToCollection error:', error);
    throw error;
  }
  console.log(`🎒 [Store] コレクション追加: ${data.name} (${data.id})`);
  return rowToItem(data);
};

export const getCollectionItem = async (sessionId, itemId) => {
  const { data, error } = await supabase
    .from('collections')
    .select('*')
    .eq('session_id', sessionId)
    .eq('id', itemId)
    .maybeSingle();

  if (error) {
    console.error('❌ [Store] getCollectionItem error:', error);
    return null;
  }
  return rowToItem(data);
};

export const updateCollectionItem = async (sessionId, itemId, updates) => {
  // 旧API互換: { model3d: { status, taskId, glbUrl } } を受け取る
  const dbUpdates = {};
  if (updates.model3d) {
    if (updates.model3d.status !== undefined) dbUpdates.glb_status = updates.model3d.status;
    if (updates.model3d.taskId !== undefined) dbUpdates.tripo_task_id = updates.model3d.taskId;
    if (updates.model3d.glbUrl !== undefined) dbUpdates.glb_url = updates.model3d.glbUrl;
  }
  if (updates.image_url !== undefined) dbUpdates.image_url = updates.image_url;
  if (updates.name !== undefined) dbUpdates.name = updates.name;
  if (updates.description !== undefined) dbUpdates.description = updates.description;

  const { data, error } = await supabase
    .from('collections')
    .update(dbUpdates)
    .eq('session_id', sessionId)
    .eq('id', itemId)
    .select()
    .maybeSingle();

  if (error) {
    console.error('❌ [Store] updateCollectionItem error:', error);
    return null;
  }
  console.log(`🔄 [Store] コレクション更新: ${itemId}`);
  return rowToItem(data);
};
