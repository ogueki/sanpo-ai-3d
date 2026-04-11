/* ---------- ズーム機能 ---------- */
let currentZoom = 1;
const maxZoom = 3;
const minZoom = 1;
const zoomStep = 0.2;

/* ---------- セッション ID（ブラウザごとに固定） ---------- */
const SESSION_ID = (() => {
  try {
    return localStorage.getItem('session-id') || (() => {
      const id = 'ss-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('session-id', id);
      return id;
    })();
  } catch {
    // localStorage が使えない場合のフォールバック
    return 'ss-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
})();

console.log('📱 Session ID:', SESSION_ID);

/* ---------- 定数 & 要素取得 ---------- */
const API_URL_UNIFIED = '/api/unified';
const API_URL_RESET = '/api/reset-session';
const API_URL_STT = '/api/speech-to-text';
const API_URL_COLLECTION = '/api/collection';
const API_URL_GENERATE_3D = '/api/generate-3d';

// 要素の安全な取得
const getElement = (id) => {
  const element = document.getElementById(id);
  if (!element) {
    console.warn(`Element not found: ${id}`);
  }
  return element;
};

const video = getElement('preview') || getElement('video');
const canvas = getElement('canvas');

/* ---------- SpeechSynthesis 初期化 ---------- */
let voiceReady = false;
let jpVoice = null;

function initSpeech() {
  if ('speechSynthesis' in window) {
    const loadVoices = () => {
      const voices = speechSynthesis.getVoices();
      jpVoice = voices.find(v => v.lang.startsWith('ja')) || voices[0];
      console.log('🔊 音声:', jpVoice ? jpVoice.name : '利用不可');
    };

    loadVoices();
    speechSynthesis.onvoiceschanged = loadVoices;
  }
}

function warmUpSpeech() {
  if (voiceReady || !('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(''));
    voiceReady = true;
  } catch (e) {
    console.warn('音声の初期化失敗:', e);
  }
}

/* ---------- カメラ制御 ---------- */
let currentStream = null;
let useBack = true;

async function startCamera(back = true) {
  console.log('📱 カメラ起動開始:', back ? '背面' : '前面');

  if (!video) {
    console.error('❌ video要素が見つかりません');
    showToast('video要素が見つかりません');
    return false;
  }

  warmUpSpeech();

  // 既存ストリームを停止
  if (currentStream) {
    currentStream.getTracks().forEach(track => track.stop());
    currentStream = null;
  }

  // MediaDevices API チェック
  if (!navigator.mediaDevices?.getUserMedia) {
    console.error('❌ カメラAPIがサポートされていません');
    showToast('このブラウザはカメラをサポートしていません');
    return false;
  }

  try {
    updateStatus('カメラ起動中...', false);

    // カメラ制約の設定
    const constraints = {
      video: back ?
        { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } :
        { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }
    };

    console.log('📱 カメラ制約:', constraints);

    try {
      // まず指定された制約で試行
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      currentStream = stream;
      video.srcObject = stream;
    } catch (err) {
      console.log('⚠️ 指定カメラ失敗、基本設定で再試行:', err.message);
      // フォールバック: 基本設定
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      currentStream = stream;
      video.srcObject = stream;
    }

    // 動画読み込み完了まで待機
    await new Promise((resolve) => {
      video.onloadedmetadata = () => {
        video.play().then(resolve).catch(console.error);
      };
    });

    console.log(`✅ カメラ起動成功: ${video.videoWidth}x${video.videoHeight}`);
    updateStatus('カメラ起動完了', true);
    showToast('カメラ起動しました');

    return true;

  } catch (err) {
    console.error('❌ カメラエラー:', err);
    updateStatus('カメラ起動失敗', false);

    if (err.name === 'NotAllowedError') {
      showToast('カメラへのアクセスが拒否されました。設定を確認してください。');
    } else if (err.name === 'NotFoundError') {
      showToast('カメラが見つかりません');
    } else {
      showToast(`カメラエラー: ${err.message}`);
    }

    return false;
  }
}

function flipCamera() {
  console.log('🔄 カメラ切り替え');
  useBack = !useBack;
  startCamera(useBack);
}

/* ---------- ステータス表示 ---------- */
function updateStatus(text, live = false) {
  const statusText = getElement('status-text');
  const statusLed = getElement('status-led');

  if (statusText) statusText.textContent = text;
  if (statusLed) {
    statusLed.className = `inline-block w-2.5 h-2.5 rounded-full ${live ? 'bg-emerald-500' : 'bg-zinc-500'}`;
  }

  if (window.setStatus) {
    window.setStatus(text, live);
  }

  console.log(`📊 Status: ${text} (live: ${live})`);
}

/* ---------- 音声録音 ---------- */
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    audioChunks = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      const base64Audio = await blobToBase64(audioBlob);

      // Base64文字列からプレフィックスを削除
      const base64Data = base64Audio.split(',')[1];

      // Whisper APIに送信
      try {
        const response = await fetch(API_URL_STT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audioBase64: base64Data })
        });

        const data = await response.json();
        if (data.success && data.text) {
          // 認識したテキストをAIに送信
          await sendToUnifiedAI(data.text);
        } else {
          showToast('音声認識に失敗しました');
        }
      } catch (error) {
        console.error('❌ 音声認識エラー:', error);
        showToast('音声認識エラー');
      }

      // ストリームを停止
      stream.getTracks().forEach(track => track.stop());
    };

    mediaRecorder.start();
    isRecording = true;
    updateStatus('録音中...', true);
    showToast('録音開始');

    // RECバッジ表示
    const recBadge = getElement('badge-rec');
    if (recBadge) recBadge.classList.remove('hidden');

  } catch (error) {
    console.error('❌ 録音開始エラー:', error);
    showToast('マイクにアクセスできません');
  }
}

function stopRecording() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
    isRecording = false;
    updateStatus('処理中...', false);
    showToast('録音停止→送信中');

    // RECバッジ非表示
    const recBadge = getElement('badge-rec');
    if (recBadge) recBadge.classList.add('hidden');
  }
}

/* ---------- 統合AI処理 ---------- */
let processingRequest = false;

async function sendToUnifiedAI(text, newImage = null) {
  if (processingRequest) {
    console.log('⚠️ 処理中です');
    showToast('処理中です。しばらくお待ちください。');
    return;
  }

  try {
    processingRequest = true;
    showLoadingIndicator();

    console.log(`🚀 AI送信 - Text: "${text}", 画像: ${!!newImage}`);

    const requestBody = {
      sessionId: SESSION_ID,
      text: text.trim()
    };

    if (newImage) {
      requestBody.image = newImage;
    }

    const response = await fetch(API_URL_UNIFIED, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(errorData.error || `HTTP ${response.status}`);
    }

    const data = await response.json();
    const answer = data.answer;

    console.log(`✅ AI応答受信`);

    // テキスト表示と音声再生を同期させる
    // 先にTTS音声を準備し、準備できたらテキスト表示+再生を同時に行う
    showLoadingIndicator('🔊 音声準備中...');
    const audio = await prepareAudio(answer);
    appendChat(text, answer);
    if (audio) {
      try { await audio.play(); } catch (e) { console.warn('再生失敗:', e); speakFallback(answer); }
    }

  } catch (error) {
    console.error('❌ AI処理エラー:', error);

    const errorMessage = 'エラーが発生しました。もう一度お試しください。';
    appendChat(text, errorMessage);
    showToast('エラーが発生しました');

  } finally {
    processingRequest = false;
    hideLoadingIndicator();
    updateStatus('待機中', false);
  }
}

async function captureAndSendToAI(extraText = '') {
  if (!video) {
    showToast('video要素が見つかりません');
    return;
  }

  if (!video.srcObject || !video.videoWidth) {
    showToast('カメラを起動しています...');
    const success = await startCamera(useBack);
    if (!success) return;

    // カメラ起動後、少し待ってから撮影
    setTimeout(() => captureAndSendToAI(extraText), 1000);
    return;
  }

  try {
    if (!canvas) {
      throw new Error('canvas要素が見つかりません');
    }

    // 画像をキャプチャ
    const SCALE = 0.7; // 画像サイズの調整
    canvas.width = video.videoWidth * SCALE;
    canvas.height = video.videoHeight * SCALE;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) {
      throw new Error('画像の生成に失敗しました');
    }

    const base64Image = await blobToBase64(blob);

    const questionText = extraText || '写真を送信しました。何が見えますか？';

    await sendToUnifiedAI(questionText, base64Image);

    // フラッシュ効果
    showFlash();
    showToast('画像を送信しました');

  } catch (error) {
    console.error('❌ 撮影エラー:', error);
    showToast('画像の処理に失敗しました');
  }
}

/* ---------- UI表示関数 ---------- */
function showLoadingIndicator(message = '🤔 考え中...') {
  hideLoadingIndicator();

  const chatContainer = getElement('chat');
  if (!chatContainer) return;

  const loadingDiv = document.createElement('div');
  loadingDiv.id = 'loading-indicator';
  loadingDiv.className = 'max-w-[80vw] sm:max-w-[60vw] px-3 py-2 rounded-2xl ring-1 ring-white/10 backdrop-blur bg-zinc-900/75';
  loadingDiv.textContent = message;

  chatContainer.appendChild(loadingDiv);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function hideLoadingIndicator() {
  const loadingEl = getElement('loading-indicator');
  if (loadingEl) {
    loadingEl.remove();
  }
}

function appendChat(userText, aiResponse) {
  const chatContainer = getElement('chat');
  if (!chatContainer) return;

  // 既存のローディング削除
  hideLoadingIndicator();

  // ユーザーメッセージ
  const userDiv = document.createElement('div');
  userDiv.className = 'max-w-[80vw] sm:max-w-[60vw] px-3 py-2 rounded-2xl ring-1 ring-white/10 backdrop-blur bg-emerald-700 ml-auto';
  userDiv.textContent = userText;
  chatContainer.appendChild(userDiv);

  // AIレスポンス
  const aiDiv = document.createElement('div');
  aiDiv.className = 'max-w-[80vw] sm:max-w-[60vw] px-3 py-2 rounded-2xl ring-1 ring-white/10 backdrop-blur bg-zinc-900/75';
  aiDiv.textContent = aiResponse;
  chatContainer.appendChild(aiDiv);

  // 古いメッセージをフェードアウト（最新4件のみ表示）
  const messages = Array.from(chatContainer.children).filter(el => el.id !== 'loading-indicator');
  if (messages.length > 4) {
    messages.slice(0, messages.length - 4).forEach(msg => {
      msg.style.animation = 'fadeAway 3.6s ease forwards';
      setTimeout(() => msg.remove(), 3600);
    });
  }

  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function showFlash() {
  const flash = getElement('flash');
  if (flash) {
    flash.classList.remove('hidden');
    setTimeout(() => flash.classList.add('hidden'), 120);
  }
}

function showToast(message) {
  if (window.toast) {
    window.toast(message);
  } else {
    console.log('📢 Toast:', message);
    // 簡易トースト実装
    const toastEl = document.createElement('div');
    toastEl.className = 'fixed bottom-20 left-1/2 -translate-x-1/2 min-w-[220px] max-w-[90vw] px-4 py-2 rounded-xl bg-white/10 backdrop-blur text-sm shadow-2xl z-50';
    toastEl.textContent = message;
    document.body.appendChild(toastEl);
    setTimeout(() => toastEl.remove(), 5000); // 5秒に延長
  }
}

/* ---------- その他の機能 ---------- */
async function sendText() {
  const input = getElement('userText');
  if (!input) {
    console.error('userText input not found');
    return;
  }

  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  await sendToUnifiedAI(text);
}

function quickQuestion(questionText) {
  const input = getElement('userText');
  if (input) {
    input.value = questionText;
    // 少し遅延を入れてから送信
    setTimeout(() => sendText(), 100);
  } else {
    // 直接送信
    sendToUnifiedAI(questionText);
  }
}

async function resetSession() {
  try {
    const response = await fetch(API_URL_RESET, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID })
    });

    if (response.ok) {
      // チャットをクリア
      const chatContainer = getElement('chat');
      if (chatContainer) {
        chatContainer.innerHTML = '';
      }
      updateStatus('リセット完了', false);
      showToast('会話をリセットしました');
    }
  } catch (error) {
    console.error('❌ リセットエラー:', error);
    showToast('リセットに失敗しました');
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    if (!blob) return reject(new Error('blob is null'));
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

const API_URL_TTS = '/api/tts';

// AudioContext（モバイル対応用）
let audioContext = null;
// モバイル用：事前にプリウォームしたAudio
let pendingAudio = null;

function getAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioContext;
}

// ユーザー操作時にAudioContextを解禁
function unlockAudioContext() {
  try {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
  } catch (e) {
    console.warn('AudioContext解禁失敗:', e);
  }
}

// ユーザータップ時にAudioをプリウォーム（モバイル対策）
function prewarmAudio() {
  unlockAudioContext();
  // 空のAudioを作成し、play()を試みることで権限を確保
  pendingAudio = new Audio();
  pendingAudio.volume = 0.01; // ほぼ無音
  // 極小の無音データ（48kHz, 16bit, モノラル, 0.01秒）
  const silentWav = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';
  pendingAudio.src = silentWav;
  pendingAudio.play().then(() => {
    console.log('🔊 Audio prewarm成功');
    pendingAudio.pause();
    pendingAudio.volume = 1.0;
  }).catch(e => {
    console.warn('🔊 Audio prewarm失敗:', e.message);
  });
}

// 初回タップでAudioContextを解禁
['click', 'touchstart'].forEach(event => {
  document.addEventListener(event, unlockAudioContext, { once: true });
});

/**
 * TTS音声を準備して再生可能なAudioオブジェクトを返す（まだ再生しない）
 * @returns {Promise<HTMLAudioElement|null>} 再生準備済みのAudio、失敗時はnull
 */
async function prepareAudio(text) {
  if (!text || text.trim().length === 0) return null;

  unlockAudioContext();

  try {
    const response = await fetch(API_URL_TTS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });

    if (!response.ok) {
      throw new Error(`TTS API error: ${response.status}`);
    }

    const data = await response.json();

    if (data.success && data.audio) {
      const audioSrc = `data:${data.mimeType || 'audio/mpeg'};base64,${data.audio}`;
      const audio = pendingAudio || new Audio();
      pendingAudio = null;
      audio.src = audioSrc;

      // 音声データの読み込み完了を待つ
      await new Promise((resolve, reject) => {
        audio.oncanplaythrough = resolve;
        audio.onerror = reject;
        audio.load();
      });

      console.log('🔊 TTS音声準備完了');
      return audio;
    }

    throw new Error('音声データなし');

  } catch (error) {
    console.warn('🔊 TTS失敗、フォールバック使用:', error.message);
    return null; // nullの場合はフォールバック
  }
}

// speak は後方互換のためにも残す
async function speak(text) {
  const audio = await prepareAudio(text);
  if (audio) {
    try { await audio.play(); } catch (e) { speakFallback(text); }
  } else {
    speakFallback(text);
  }
}

// フォールバック: Web Speech API
function speakFallback(text) {
  if (!('speechSynthesis' in window)) return;

  speechSynthesis.cancel();
  const uttr = new SpeechSynthesisUtterance(text);
  if (jpVoice) uttr.voice = jpVoice;
  uttr.rate = 1.1;
  uttr.pitch = 1.0;
  speechSynthesis.speak(uttr);
}

/* ---------- イベントリスナー ---------- */
document.addEventListener('DOMContentLoaded', () => {
  console.log('🔧 camera.js loaded');

  // 音声初期化
  initSpeech();

  // テキスト入力
  const userTextInput = getElement('userText');
  if (userTextInput) {
    userTextInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendText();
      }
    });
  }

  // ボタンイベントの設定
  const btnStart = getElement('btn-start');
  const btnCapture = getElement('btn-capture');
  const btnShutter = getElement('btn-shutter');
  const btnSwitch = getElement('btn-switch');
  const btnSendText = getElement('btn-send-text');
  const btnReset = getElement('btn-reset');
  const btnRec = getElement('btn-rec');

  if (btnStart) btnStart.addEventListener('click', () => startCamera(useBack));
  if (btnCapture) btnCapture.addEventListener('click', () => captureAndSendToAI());
  if (btnShutter) {
    // モバイル対策: touchstart時にAudioをプリウォーム
    btnShutter.addEventListener('touchstart', prewarmAudio, { passive: true });
    btnShutter.addEventListener('click', () => {
      if (window.currentMode === 'scan') {
        scanAndCollect();
      } else {
        captureAndSendToAI();
      }
    });
  }
  if (btnSwitch) btnSwitch.addEventListener('click', flipCamera);
  if (btnSendText) btnSendText.addEventListener('click', sendText);
  if (btnReset) btnReset.addEventListener('click', resetSession);

  // 録音ボタン（押している間録音）
  if (btnRec) {
    let recordingTimeout;

    const startRec = () => {
      if (!isRecording) {
        startRecording();
        // 最大10秒で自動停止
        recordingTimeout = setTimeout(() => {
          if (isRecording) stopRecording();
        }, 10000);
      }
    };

    const stopRec = () => {
      if (recordingTimeout) clearTimeout(recordingTimeout);
      if (isRecording) stopRecording();
    };

    // デスクトップ
    btnRec.addEventListener('mousedown', startRec);
    btnRec.addEventListener('mouseup', stopRec);
    btnRec.addEventListener('mouseleave', stopRec);

    // モバイル
    btnRec.addEventListener('touchstart', (e) => {
      e.preventDefault();
      startRec();
    });
    btnRec.addEventListener('touchend', (e) => {
      e.preventDefault();
      stopRec();
    });
  }

  // 初期カメラ起動（0.5秒後）
  setTimeout(() => startCamera(true), 500);
});

/* ---------- スキャンモード & コレクション ---------- */
let scanProcessing = false;

async function scanAndCollect() {
  if (scanProcessing) {
    showToast('スキャン中です...');
    return;
  }

  if (!video || !video.srcObject || !video.videoWidth) {
    showToast('カメラを起動しています...');
    const success = await startCamera(useBack);
    if (!success) return;
    setTimeout(() => scanAndCollect(), 1000);
    return;
  }

  try {
    scanProcessing = true;

    if (!canvas) throw new Error('canvas要素が見つかりません');

    // 画像をキャプチャ
    const SCALE = 0.7;
    canvas.width = video.videoWidth * SCALE;
    canvas.height = video.videoHeight * SCALE;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) throw new Error('画像の生成に失敗しました');

    const base64Image = await blobToBase64(blob);

    // フラッシュ効果
    showFlash();
    updateStatus('スキャン中...', true);
    showToast('🔍 対象を分析中...');

    // コレクションAPIに送信
    const response = await fetch(API_URL_COLLECTION, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        image: base64Image
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${response.status}`);
    }

    const data = await response.json();
    const item = data.item;

    console.log(`✅ スキャン成功: ${item.name} (${item.rarity})`);
    updateStatus('スキャン完了!', true);

    // レアリティに応じたエフェクト
    const rarityEmoji = {
      'コモン': '⬜',
      'レア': '🔵',
      'スーパーレア': '🟣',
      'レジェンド': '🌟'
    };

    // スキャン結果カードを表示
    if (window.showScanResult) {
      window.showScanResult(`
        <div class="flex items-start gap-3">
          <div class="text-3xl">${rarityEmoji[item.rarity] || '⬜'}</div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <span class="font-bold text-lg">${item.name}</span>
              <span class="text-xs px-1.5 py-0.5 rounded-full ring-1 ring-white/20 ${
                item.rarity === 'レジェンド' ? 'bg-yellow-500/20 text-yellow-300' :
                item.rarity === 'スーパーレア' ? 'bg-purple-500/20 text-purple-300' :
                item.rarity === 'レア' ? 'bg-blue-500/20 text-blue-300' :
                'bg-zinc-500/20 text-zinc-300'
              }">${item.rarity}</span>
            </div>
            <div class="text-sm text-zinc-400 mb-2">${item.category}</div>
            <div class="text-sm text-zinc-300">${item.description}</div>
          </div>
        </div>
        <div class="mt-3 text-xs text-zinc-500 text-center">コレクションに追加しました！</div>
      `);
    }

    // TTS で名前を読み上げ
    const audio = await prepareAudio(`${item.name}を発見しました！${item.rarity}です！`);
    if (audio) {
      try { await audio.play(); } catch (e) { speakFallback(`${item.name}を発見！`); }
    }

    // 3D生成を裏で開始（APIキーがあれば）
    start3DGeneration(item.id);

  } catch (error) {
    console.error('❌ スキャンエラー:', error);
    showToast('スキャンに失敗しました');
    updateStatus('エラー', false);
  } finally {
    scanProcessing = false;
  }
}

// 3D生成をバックグラウンドで開始
async function start3DGeneration(itemId) {
  try {
    const response = await fetch(API_URL_GENERATE_3D, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        itemId,
        action: 'generate'
      })
    });

    const data = await response.json();

    if (data.status === 'unavailable') {
      console.log('ℹ️ 3D生成: APIキー未設定');
      return;
    }

    if (data.status === 'processing') {
      console.log(`🎨 3D生成開始: taskId=${data.taskId}`);
      // ポーリングで状態を確認
      poll3DStatus(itemId);
    }
  } catch (error) {
    console.warn('3D生成の開始に失敗:', error.message);
  }
}

// 3D生成の状態をポーリング
async function poll3DStatus(itemId) {
  const maxAttempts = 60; // 最大5分（5秒×60回）
  let attempts = 0;

  const check = async () => {
    if (attempts++ >= maxAttempts) {
      console.warn('3D生成: タイムアウト');
      return;
    }

    try {
      const response = await fetch(API_URL_GENERATE_3D, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          itemId,
          action: 'status'
        })
      });

      const data = await response.json();

      if (data.status === 'completed') {
        console.log('✅ 3D生成完了!');
        showToast('3Dモデルが完成しました！');
        return;
      }

      if (data.status === 'failed') {
        console.warn('3D生成失敗');
        return;
      }

      // まだ処理中 → 5秒後に再チェック
      setTimeout(check, 5000);
    } catch {
      setTimeout(check, 10000);
    }
  };

  // 10秒後から開始
  setTimeout(check, 10000);
}

// コレクション読み込み・表示
async function loadCollection() {
  const grid = document.getElementById('collection-grid');
  const empty = document.getElementById('collection-empty');
  const stats = document.getElementById('collection-stats');
  if (!grid) return;

  try {
    const response = await fetch(`${API_URL_COLLECTION}?sessionId=${SESSION_ID}`);
    const data = await response.json();
    const items = data.collection || [];

    if (items.length === 0) {
      grid.innerHTML = '';
      empty.style.display = '';
      stats.textContent = '';
      return;
    }

    empty.style.display = 'none';
    stats.textContent = `${items.length} アイテム収集済み`;

    grid.innerHTML = items.map(item => {
      const has3D = item.model3d?.status === 'completed' && item.model3d?.glbUrl;
      const isProcessing = item.model3d?.status === 'processing';
      const slotInner = has3D
        ? `<model-viewer src="${item.model3d.glbUrl}"
              auto-rotate rotation-per-second="30deg" interaction-prompt="none"
              disable-zoom disable-pan disable-tap
              shadow-intensity="0" exposure="1.1"
              style="width:100%;height:100%;background:transparent;"></model-viewer>`
        : isProcessing
          ? `<div class="flex flex-col items-center justify-center text-yellow-400">
               <div class="text-3xl animate-spin">⏳</div>
               <div class="text-[10px] mt-1">生成中</div>
             </div>`
          : `<div class="text-4xl opacity-60">📦</div>`;
      return `
      <div class="collection-card rounded-xl bg-zinc-900 ring-1 ring-white/10 overflow-hidden cursor-pointer rarity-${item.rarity || 'コモン'} border-2 border-transparent"
           onclick="showItemDetail('${item.id}')"
           style="${item.rarity === 'レジェンド' ? 'border-color: #eab308; box-shadow: 0 0 12px rgba(234,179,8,0.3);' :
                    item.rarity === 'スーパーレア' ? 'border-color: #a855f7;' :
                    item.rarity === 'レア' ? 'border-color: #3b82f6;' : 'border-color: #3f3f46;'}">
        <div class="aspect-square relative flex items-center justify-center overflow-hidden"
             style="background: radial-gradient(circle at 50% 40%, #3f3f46 0%, #18181b 70%);">
          ${slotInner}
        </div>
        <div class="p-2">
          <div class="text-sm font-bold truncate">${item.name}</div>
          <div class="flex items-center justify-between mt-1">
            <span class="text-xs text-zinc-500">${item.category || ''}</span>
            <span class="text-xs ${
              item.rarity === 'レジェンド' ? 'text-yellow-400' :
              item.rarity === 'スーパーレア' ? 'text-purple-400' :
              item.rarity === 'レア' ? 'text-blue-400' :
              'text-zinc-500'
            }">${item.rarity || ''}</span>
          </div>
        </div>
      </div>
    `;}).join('');
  } catch (error) {
    console.error('コレクション読み込みエラー:', error);
    grid.innerHTML = '<div class="col-span-2 text-center text-zinc-500 py-8">読み込みに失敗しました</div>';
  }
}

// アイテム詳細表示
async function showItemDetail(itemId) {
  const content = document.getElementById('item-detail-content');
  if (!content) return;

  content.innerHTML = '<div class="text-center py-8 text-zinc-500">読み込み中...</div>';
  if (window.openItemDetail) window.openItemDetail();

  try {
    const response = await fetch(API_URL_COLLECTION, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        action: 'get',
        itemId
      })
    });

    const data = await response.json();
    const item = data.item;

    if (!item) {
      content.innerHTML = '<div class="text-center py-8 text-zinc-500">アイテムが見つかりません</div>';
      return;
    }

    const rarityColor = {
      'コモン': 'text-zinc-400 bg-zinc-800',
      'レア': 'text-blue-400 bg-blue-900/30',
      'スーパーレア': 'text-purple-400 bg-purple-900/30',
      'レジェンド': 'text-yellow-400 bg-yellow-900/30'
    };

    content.innerHTML = `
      <!-- 画像 -->
      <div class="rounded-xl overflow-hidden mb-4 ring-1 ring-white/10">
        ${item.image ? `<img src="${item.image}" class="w-full" alt="${item.name}">` : ''}
      </div>

      <!-- 名前 & レアリティ -->
      <div class="flex items-center gap-3 mb-3">
        <h3 class="text-2xl font-bold flex-1">${item.name}</h3>
        <span class="px-2 py-1 rounded-lg text-xs font-bold ${rarityColor[item.rarity] || rarityColor['コモン']}">${item.rarity}</span>
      </div>

      <!-- カテゴリ -->
      <div class="text-sm text-zinc-500 mb-3">${item.category || 'その他'}</div>

      <!-- 説明 -->
      <div class="rounded-xl bg-zinc-900 ring-1 ring-white/10 p-3 mb-4">
        <div class="text-sm text-zinc-300 leading-relaxed">${item.description}</div>
      </div>

      <!-- 3Dモデル -->
      <div class="rounded-xl bg-zinc-900 ring-1 ring-white/10 p-3 mb-4">
        <div class="text-sm text-zinc-400 mb-2">🧊 3Dモデル</div>
        ${item.model3d?.status === 'completed' && item.model3d?.glbUrl
          ? `<model-viewer src="${item.model3d.glbUrl}" auto-rotate camera-controls
               touch-action="pan-y" shadow-intensity="1"
               style="width:100%;height:300px;background:#18181b;border-radius:12px;">
             </model-viewer>`
          : item.model3d?.status === 'processing'
            ? '<div class="text-center py-8 text-yellow-400">⏳ 3Dモデル生成中...</div>'
            : '<div class="text-center py-8 text-zinc-600">3Dモデルは未生成です</div>'
        }
      </div>

      <!-- メタ情報 -->
      <div class="text-xs text-zinc-600">
        取得日時: ${new Date(item.createdAt).toLocaleString('ja-JP')}
      </div>
    `;
  } catch (error) {
    console.error('アイテム詳細エラー:', error);
    content.innerHTML = '<div class="text-center py-8 text-zinc-500">読み込みに失敗しました</div>';
  }
}

/* ---------- グローバル公開 ---------- */
window.startCamera = startCamera;
window.captureAndSendToAI = captureAndSendToAI;
window.flipCamera = flipCamera;
window.sendText = sendText;
window.quickQuestion = quickQuestion;
window.updateStatus = updateStatus;
window.resetSession = resetSession;
window.scanAndCollect = scanAndCollect;
window.loadCollection = loadCollection;
window.showItemDetail = showItemDetail;

