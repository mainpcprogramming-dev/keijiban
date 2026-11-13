let authMode = 'login';
let currentUser = null;
let currentThreadId = null;
let currentRoomCode = null;
let pendingPrivateThreadId = null;
let selectedImageBase64 = null;

// Service Workerの登録（プッシュ通知用）
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => console.error('SW登録失敗:', err));
}

// スレッドごとの最終閲覧時刻を保存・取得するヘルパー
function getSeenMap() {
  if (!currentUser) return {};
  try {
    return JSON.parse(localStorage.getItem(`seen_threads_${currentUser.id}`) || '{}');
  } catch {
    return {};
  }
}

function markThreadAsSeen(threadId, updatedAt) {
  if (!currentUser) return;
  const map = getSeenMap();
  const timestamp = updatedAt ? new Date(updatedAt).getTime() : Date.now();
  map[threadId] = Math.max(Date.now(), timestamp);
  localStorage.setItem(`seen_threads_${currentUser.id}`, JSON.stringify(map));
}

// 初期起動時のログイン確認
window.addEventListener('DOMContentLoaded', async () => {
  const res = await fetch('/api/me');
  const data = await res.json();
  if (data.loggedIn) {
    currentUser = {
      id: data.userId,
      username: data.username,
      notificationsEnabled: data.notificationsEnabled
    };
    showLoggedInUI();

    // 通知クリック時のURLパラメータ(?thread=ID)があれば該当スレッドを開く
    const params = new URLSearchParams(window.location.search);
    const targetThread = params.get('thread');
    if (targetThread) {
      window.history.replaceState({}, document.title, '/');
      loadThreadDetail(targetThread);
    } else {
      goLobby();
    }
  } else {
    showView('auth-view');
  }
});

function showView(viewId) {
  document.querySelectorAll('.view').forEach(el => el.classList.add('hidden'));
  document.getElementById(viewId).classList.remove('hidden');
}

function showLoggedInUI() {
  document.getElementById('header-user-area').classList.remove('hidden');
  document.getElementById('current-username').textContent = currentUser.username;
  document.getElementById('thread-author').value = currentUser.username;
}

// ==========================================
// 認証関連
// ==========================================

function switchAuthTab(mode) {
  authMode = mode;
  document.getElementById('auth-error').textContent = '';
  document.getElementById('tab-login').classList.toggle('active', mode === 'login');
  document.getElementById('tab-register').classList.toggle('active', mode === 'register');
  document.getElementById('auth-submit-btn').textContent = mode === 'login' ? 'ログイン' : '登録してはじめる';
}

async function handleAuth(e) {
  e.preventDefault();
  const username = document.getElementById('auth-username').value;
  const password = document.getElementById('auth-password').value;
  const errorEl = document.getElementById('auth-error');
  errorEl.textContent = '';

  const endpoint = authMode === 'login' ? '/api/login' : '/api/register';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();

  if (!res.ok) {
    errorEl.textContent = data.error;
    return;
  }

  currentUser = {
    id: data.user.id,
    username: data.user.username,
    notificationsEnabled: data.user.notifications_enabled ?? true
  };
  document.getElementById('auth-form').reset();
  showLoggedInUI();
  goLobby();
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  currentUser = null;
  document.getElementById('header-user-area').classList.add('hidden');
  showView('auth-view');
}

// ==========================================
// 設定画面（通知ON/OFF・パスワード変更・アカウント削除）
// ==========================================

async function openSettings() {
  if (!currentUser) return;
  showView('settings-view');
  document.getElementById('settings-username').textContent = currentUser.username;
  document.getElementById('password-change-form').classList.add('hidden');
  document.getElementById('show-pw-form-btn').classList.remove('hidden');
  document.getElementById('pw-change-error').textContent = '';

  // 現在のブラウザの通知購読状態とDB設定を確認
  const toggleEl = document.getElementById('notification-toggle');
  const statusLabel = document.getElementById('notification-status-label');

  let isBrowserSubscribed = false;
  if ('serviceWorker' in navigator && 'PushManager' in window) {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    isBrowserSubscribed = !!sub;
  }

  const isOn = currentUser.notificationsEnabled && isBrowserSubscribed && Notification.permission === 'granted';
  toggleEl.checked = isOn;
  statusLabel.textContent = isOn ? '通知：オン（受信中）' : '通知：オフ';
}

async function handleNotificationToggle(e) {
  const wantEnable = e.target.checked;
  const toggleEl = e.target;
  const statusLabel = document.getElementById('notification-status-label');

  if (wantEnable) {
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      alert('お使いのブラウザはプッシュ通知に対応していません。\n※iPhone/iPadの場合は「ホーム画面に追加」してから開いてください。');
      toggleEl.checked = false;
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      alert('ブラウザの通知許可がブロックされています。端末やブラウザの設定から通知を許可してください。');
      toggleEl.checked = false;
      return;
    }

    try {
      const keyRes = await fetch('/api/push/vapid-public-key');
      const { publicKey } = await keyRes.json();

      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });

      const subRes = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription })
      });

      if (!subRes.ok) throw new Error('サーバー登録失敗');

      currentUser.notificationsEnabled = true;
      statusLabel.textContent = '通知：オン（受信中）';
    } catch (err) {
      console.error(err);
      alert('プッシュ通知の有効化に失敗しました。');
      toggleEl.checked = false;
    }
  } else {
    try {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) await sub.unsubscribe();
      }
      await fetch('/api/push/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false })
      });
      currentUser.notificationsEnabled = false;
      statusLabel.textContent = '通知：オフ';
    } catch (err) {
      console.error(err);
    }
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function togglePasswordForm() {
  const form = document.getElementById('password-change-form');
  const btn = document.getElementById('show-pw-form-btn');
  const isHidden = form.classList.contains('hidden');
  form.classList.toggle('hidden', !isHidden);
  btn.classList.toggle('hidden', isHidden);
  document.getElementById('pw-change-error').textContent = '';
  form.reset();
}

async function submitPasswordChange(e) {
  e.preventDefault();
  const currentPassword = document.getElementById('current-password').value;
  const newPassword = document.getElementById('new-password').value;
  const errEl = document.getElementById('pw-change-error');
  errEl.textContent = '';

  const res = await fetch('/api/account/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword })
  });
  const data = await res.json();

  if (!res.ok) {
    errEl.textContent = data.error;
    return;
  }

  alert('パスワードを変更しました。新しいパスワードで再度ログインしてください。');
  currentUser = null;
  document.getElementById('header-user-area').classList.add('hidden');
  showView('auth-view');
}

function openDeleteAccountModal() {
  document.getElementById('delete-account-modal').classList.remove('hidden');
}

function closeDeleteAccountModal() {
  document.getElementById('delete-account-modal').classList.add('hidden');
}

async function confirmDeleteAccount() {
  const res = await fetch('/api/account', { method: 'DELETE' });
  closeDeleteAccountModal();
  if (!res.ok) {
    alert('アカウントの削除中にエラーが発生しました。');
    return;
  }
  alert('アカウントとすべての投稿データを削除しました。');
  currentUser = null;
  document.getElementById('header-user-area').classList.add('hidden');
  showView('auth-view');
}

// ==========================================
// ロビー画面
// ==========================================

function goLobby() {
  if (!currentUser) return;
  currentThreadId = null;
  currentRoomCode = null;
  showView('lobby-view');
  loadLobby();
}

async function loadLobby() {
  const res = await fetch('/api/threads');
  if (!res.ok) return;
  const threads = await res.json();
  const seenMap = getSeenMap();

  const listEl = document.getElementById('thread-list');
  listEl.innerHTML = '';

  if (threads.length === 0) {
    listEl.innerHTML = '<p style="color: var(--text-muted);">まだスレッドがありません。最初のスレッドを立ててみましょう。</p>';
    return;
  }

  threads.forEach(t => {
    const updatedTime = new Date(t.updated_at).getTime();
    const lastSeenTime = seenMap[t.id] || 0;
    const isUpdated = updatedTime > lastSeenTime;

    const item = document.createElement('div');
    item.className = `thread-item ${isUpdated ? 'updated' : ''}`;
    
    let badges = '';
    if (isUpdated) {
      badges += `<span class="badge badge-updated">NEW</span> `;
    }
    if (t.is_private) {
      badges += `<span class="badge badge-private">🔒 プライベート</span> `;
      if (t.room_code) {
        badges += `<span class="badge badge-code">部屋番号: ${t.room_code}</span> `;
      }
    }
    if (t.is_readonly) {
      badges += `<span class="badge badge-readonly">閲覧モード</span>`;
    }

    item.innerHTML = `
      <div class="thread-item-header">
        <div class="thread-item-title">${escapeHtml(t.title)}</div>
        <div>${badges}</div>
      </div>
      <div class="thread-item-meta">
        <span>スレ主: 👑${escapeHtml(t.author_name)}</span>
        <span>💬 ${t.comment_count}件</span>
      </div>
    `;

    item.onclick = () => openThread(t.id, t.is_private, t.creator_id === currentUser.id);
    listEl.appendChild(item);
  });
}

async function createThread(e) {
  e.preventDefault();
  const title = document.getElementById('thread-title').value;
  const authorName = document.getElementById('thread-author').value;
  const isPrivate = document.getElementById('thread-private').checked;

  const res = await fetch('/api/threads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, authorName, isPrivate })
  });
  const data = await res.json();

  if (!res.ok) {
    alert(data.error);
    return;
  }

  document.getElementById('thread-title').value = '';
  document.getElementById('thread-private').checked = false;

  if (data.is_private && data.room_code) {
    alert(`プライベートスレッドを作成しました！\n部屋番号は【 ${data.room_code} 】です。\n招待したい相手にこの番号を伝えてください。`);
  }

  openThread(data.id, data.is_private, true, data.room_code);
}

// ==========================================
// スレッド閲覧・更新・入室処理
// ==========================================

function openThread(threadId, isPrivate, isCreator, knownCode = null) {
  if (isPrivate && !isCreator && !knownCode) {
    pendingPrivateThreadId = threadId;
    document.getElementById('modal-room-input').value = '';
    document.getElementById('modal-error').textContent = '';
    document.getElementById('room-modal').classList.remove('hidden');
    return;
  }
  loadThreadDetail(threadId, knownCode);
}

function closeModal() {
  document.getElementById('room-modal').classList.add('hidden');
  pendingPrivateThreadId = null;
}

async function submitRoomCode() {
  const code = document.getElementById('modal-room-input').value.trim();
  if (!code) return;
  const success = await loadThreadDetail(pendingPrivateThreadId, code);
  if (success) {
    closeModal();
  }
}

async function refreshCurrentThread() {
  if (!currentThreadId) return;
  await loadThreadDetail(currentThreadId, currentRoomCode);
}

async function loadThreadDetail(threadId, code = null) {
  const url = code ? `/api/threads/${threadId}?code=${encodeURIComponent(code)}` : `/api/threads/${threadId}`;
  const res = await fetch(url);
  const data = await res.json();

  if (!res.ok) {
    if (data.requireCode) {
      document.getElementById('modal-error').textContent = data.error;
    } else {
      alert(data.error);
      goLobby();
    }
    return false;
  }

  currentThreadId = threadId;
  currentRoomCode = code;

  markThreadAsSeen(threadId, data.thread.updated_at);

  showView('thread-view');
  renderThreadDetail(data);
  return true;
}

function renderThreadDetail(data) {
  const { thread, comments, currentUserId } = data;
  const isCreator = thread.creator_id === currentUserId;

  document.getElementById('detail-title').textContent = thread.title;
  document.getElementById('detail-author').textContent = `👑${thread.author_name}`;

  document.getElementById('detail-private-badge').classList.toggle('hidden', !thread.is_private);
  const codeEl = document.getElementById('detail-room-code');
  if (thread.is_private && thread.room_code) {
    codeEl.textContent = `部屋番号: ${thread.room_code}`;
    codeEl.classList.remove('hidden');
  } else {
    codeEl.classList.add('hidden');
  }
  document.getElementById('detail-readonly-badge').classList.toggle('hidden', !thread.is_readonly);

  const controls = document.getElementById('creator-controls');
  if (isCreator) {
    controls.classList.remove('hidden');
    document.getElementById('toggle-readonly-btn').textContent =
      thread.is_readonly ? '書き込みを許可する' : '閲覧モードにする';
  } else {
    controls.classList.add('hidden');
  }

  document.getElementById('comment-form-container').classList.toggle('hidden', thread.is_readonly);
  document.getElementById('readonly-notice').classList.toggle('hidden', !thread.is_readonly);

  const listEl = document.getElementById('comments-list');
  listEl.innerHTML = '';

  comments.forEach(c => {
    const canDelete = isCreator || (c.user_id === currentUserId);
    const isThreadCreatorComment = c.user_id === thread.creator_id;
    const displayAuthor = isThreadCreatorComment ? `👑${c.author_name}` : c.author_name;

    const dateStr = new Date(c.created_at).toLocaleString('ja-JP', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    const card = document.createElement('div');
    card.className = 'comment-card';

    if (c.is_deleted) {
      card.innerHTML = `
        <div class="comment-header">
          <span class="comment-author">${escapeHtml(displayAuthor)}</span>
          <span>${dateStr}</span>
        </div>
        <div class="deleted-message">メッセージが削除されました</div>
      `;
    } else {
      card.innerHTML = `
        <div class="comment-header">
          <span class="comment-author">${escapeHtml(displayAuthor)}</span>
          <span>${dateStr}</span>
        </div>
        ${c.content ? `<div class="comment-body">${escapeHtml(c.content)}</div>` : ''}
        ${c.image_data ? `<img src="${c.image_data}" class="comment-image" alt="添付画像">` : ''}
        <div class="comment-footer">
          <button class="like-btn ${c.is_liked ? 'liked' : ''}" onclick="toggleLike(${c.id})">
            💕 <span>${c.like_count}</span>
          </button>
          ${canDelete ? `<button class="delete-comment-btn" onclick="deleteComment(${c.id})">削除</button>` : ''}
        </div>
      `;
    }

    listEl.appendChild(card);
  });
}

// ==========================================
// コメント投稿・画像処理・削除・いいね
// ==========================================

function previewImage(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(event) {
    const img = new Image();
    img.onload = function() {
      const canvas = document.createElement('canvas');
      const MAX_WIDTH = 800;
      let width = img.width;
      let height = img.height;

      if (width > MAX_WIDTH) {
        height *= MAX_WIDTH / width;
        width = MAX_WIDTH;
      }
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      selectedImageBase64 = canvas.toDataURL('image/jpeg', 0.8);
      document.getElementById('image-preview').src = selectedImageBase64;
      document.getElementById('image-preview-area').classList.remove('hidden');
    };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
}

function clearImage() {
  selectedImageBase64 = null;
  document.getElementById('comment-image').value = '';
  document.getElementById('image-preview-area').classList.add('hidden');
}

async function postComment(e) {
  e.preventDefault();
  const content = document.getElementById('comment-content').value;

  const res = await fetch(`/api/threads/${currentThreadId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, imageData: selectedImageBase64 })
  });

  if (!res.ok) {
    const data = await res.json();
    alert(data.error);
    return;
  }

  document.getElementById('comment-content').value = '';
  clearImage();
  await loadThreadDetail(currentThreadId, currentRoomCode);
}

async function deleteComment(commentId) {
  if (!confirm('このコメントを削除しますか？')) return;
  const res = await fetch(`/api/comments/${commentId}`, { method: 'DELETE' });
  if (res.ok) {
    loadThreadDetail(currentThreadId, currentRoomCode);
  }
}

async function toggleLike(commentId) {
  const res = await fetch(`/api/comments/${commentId}/like`, { method: 'POST' });
  if (res.ok) {
    loadThreadDetail(currentThreadId, currentRoomCode);
  }
}

async function toggleReadonly() {
  const res = await fetch(`/api/threads/${currentThreadId}/readonly`, { method: 'PATCH' });
  if (res.ok) {
    loadThreadDetail(currentThreadId, currentRoomCode);
  }
}

async function deleteThread() {
  if (!confirm('本当にこのスレッドを削除しますか？（コメントもすべて消去されます）')) return;
  const res = await fetch(`/api/threads/${currentThreadId}`, { method: 'DELETE' });
  if (res.ok) {
    goLobby();
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}