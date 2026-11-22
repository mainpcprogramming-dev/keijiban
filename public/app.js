let authMode = 'login';
let currentUser = null;
let currentThreadId = null;
let currentRoomCode = null;
let pendingPrivateThreadId = null;
let selectedImageBase64 = null;
let currentBlockedUsers = [];

// 自動更新（ポーリング）管理用変数
let threadPollTimer = null;
let lastRenderedSnapshot = '';
let lobbyPollTimer = null;
let lastLobbySnapshot = '';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => console.error('SW登録失敗:', err));
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopAllPolling();
  } else {
    if (!document.getElementById('thread-view').classList.contains('hidden') && currentThreadId) {
      loadThreadDetail(currentThreadId, currentRoomCode, true);
      startThreadPolling();
    } else if (!document.getElementById('lobby-view').classList.contains('hidden') && currentUser) {
      loadLobby(true);
      startLobbyPolling();
    }
  }
});

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
  stopAllPolling();
  if (viewId !== 'thread-view') {
    lastRenderedSnapshot = '';
  }
  if (viewId !== 'lobby-view') {
    lastLobbySnapshot = '';
  }
  document.querySelectorAll('.view').forEach(el => el.classList.add('hidden'));
  document.getElementById(viewId).classList.remove('hidden');
  window.scrollTo(0, 0);
}

function showLoggedInUI() {
  document.getElementById('header-user-area').classList.remove('hidden');
  const usernameEl = document.getElementById('current-username');
  usernameEl.textContent = currentUser.username;
  usernameEl.title = currentUser.username;
  document.getElementById('thread-author').value = currentUser.username;
}

// ==========================================
// 自動更新タイマー制御
// ==========================================

function startLobbyPolling() {
  stopLobbyPolling();
  lobbyPollTimer = setInterval(() => {
    if (currentUser && !document.hidden && !document.getElementById('lobby-view').classList.contains('hidden')) {
      loadLobby(true);
    }
  }, 5000);
}

function stopLobbyPolling() {
  if (lobbyPollTimer) {
    clearInterval(lobbyPollTimer);
    lobbyPollTimer = null;
  }
}

function startThreadPolling() {
  stopThreadPolling();
  threadPollTimer = setInterval(() => {
    if (currentThreadId && !document.hidden && !document.getElementById('thread-view').classList.contains('hidden')) {
      loadThreadDetail(currentThreadId, currentRoomCode, true);
    }
  }, 4000);
}

function stopThreadPolling() {
  if (threadPollTimer) {
    clearInterval(threadPollTimer);
    threadPollTimer = null;
  }
}

function stopAllPolling() {
  stopLobbyPolling();
  stopThreadPolling();
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
  stopAllPolling();
  await fetch('/api/logout', { method: 'POST' });
  currentUser = null;
  document.getElementById('header-user-area').classList.add('hidden');
  showView('auth-view');
}

// ==========================================
// 設定画面
// ==========================================

async function openSettings() {
  if (!currentUser) return;
  showView('settings-view');
  document.getElementById('settings-username').textContent = currentUser.username;
  document.getElementById('password-change-form').classList.add('hidden');
  document.getElementById('show-pw-form-btn').classList.remove('hidden');
  document.getElementById('pw-change-error').textContent = '';

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
// ロビー（ホーム）画面
// ==========================================

function goLobby() {
  if (!currentUser) return;
  currentThreadId = null;
  currentRoomCode = null;
  lastLobbySnapshot = '';
  showView('lobby-view');
  loadLobby(false);
  startLobbyPolling();
}

async function loadLobby(isAutoPoll = false) {
  let res;
  try {
    res = await fetch('/api/threads');
  } catch {
    return;
  }
  if (!res.ok) return;
  const threads = await res.json();
  const seenMap = getSeenMap();

  const currentLobbySnapshot = JSON.stringify(
    threads.map(t => {
      const updatedTime = new Date(t.updated_at).getTime();
      const lastSeenTime = seenMap[t.id] || 0;
      return {
        id: t.id,
        title: t.title,
        comment_count: t.comment_count,
        is_readonly: t.is_readonly,
        is_blocked: t.is_blocked,
        is_updated: !t.is_blocked && (updatedTime > lastSeenTime)
      };
    })
  );

  if (isAutoPoll && currentLobbySnapshot === lastLobbySnapshot) {
    return;
  }
  lastLobbySnapshot = currentLobbySnapshot;

  const listEl = document.getElementById('thread-list');
  listEl.innerHTML = '';

  if (threads.length === 0) {
    listEl.innerHTML = '<p style="color: var(--text-muted);">まだスレッドがありません。最初のスレッドを立ててみましょう。</p>';
    return;
  }

  threads.forEach(t => {
    const isBlocked = !!t.is_blocked;
    const updatedTime = new Date(t.updated_at).getTime();
    const lastSeenTime = seenMap[t.id] || 0;
    const isUpdated = !isBlocked && (updatedTime > lastSeenTime);

    const item = document.createElement('div');
    if (isBlocked) {
      item.className = 'thread-item blocked';
    } else if (isUpdated) {
      item.className = 'thread-item updated';
    } else {
      item.className = 'thread-item';
    }

    let badges = '';
    if (isBlocked) {
      badges += `<span class="badge badge-blocked">🚫 ブロック済み（閲覧不可）</span> `;
    } else {
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

    item.onclick = () => {
      if (isBlocked) {
        alert('スレッド作成者によりブロックされているため、このスレッドは開けません。');
        return;
      }
      openThread(t.id, t.is_private, t.creator_id === currentUser.id);
    };
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
// スレッド閲覧・自動同期・ブロック管理
// ==========================================

function openThread(threadId, isPrivate, isCreator, knownCode = null) {
  if (isPrivate && !isCreator && !knownCode) {
    pendingPrivateThreadId = threadId;
    document.getElementById('modal-room-input').value = '';
    document.getElementById('modal-error').textContent = '';
    document.getElementById('room-modal').classList.remove('hidden');
    return;
  }
  loadThreadDetail(threadId, knownCode, false);
}

function closeModal() {
  document.getElementById('room-modal').classList.add('hidden');
  pendingPrivateThreadId = null;
}

async function submitRoomCode() {
  const code = document.getElementById('modal-room-input').value.trim();
  if (!code) return;
  const success = await loadThreadDetail(pendingPrivateThreadId, code, false);
  if (success) {
    closeModal();
  }
}

async function refreshCurrentThread() {
  if (!currentThreadId) return;
  lastRenderedSnapshot = '';
  await loadThreadDetail(currentThreadId, currentRoomCode, false);
}

function scrollToBottom() {
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
}

async function loadThreadDetail(threadId, code = null, isAutoPoll = false) {
  const url = code ? `/api/threads/${threadId}?code=${encodeURIComponent(code)}` : `/api/threads/${threadId}`;
  let res;
  try {
    res = await fetch(url);
  } catch {
    return false;
  }

  if (res.status === 404 && isAutoPoll) {
    stopThreadPolling();
    alert('このスレッドは作成者によって削除されました。ホームに戻ります。');
    goLobby();
    return false;
  }

  const data = await res.json();

  if (!res.ok) {
    if (data.blocked) {
      stopThreadPolling();
      alert('スレッド作成者によりブロックされたため、このスレッドを閲覧できません。');
      goLobby();
      return false;
    }
    if (!isAutoPoll) {
      if (data.requireCode) {
        document.getElementById('modal-error').textContent = data.error;
      } else {
        alert(data.error);
        goLobby();
      }
    }
    return false;
  }

  currentBlockedUsers = data.blockedUsers || [];

  const currentSnapshot = JSON.stringify({
    readonly: data.thread.is_readonly,
    blockedUsers: currentBlockedUsers,
    comments: data.comments.map(c => ({
      id: c.id,
      is_deleted: c.is_deleted,
      like_count: c.like_count,
      is_liked: c.is_liked
    }))
  });

  const prevCommentCount = lastRenderedSnapshot ? JSON.parse(lastRenderedSnapshot).comments.length : 0;
  const newCommentCount = data.comments.length;

  currentThreadId = threadId;
  currentRoomCode = code;
  markThreadAsSeen(threadId, data.thread.updated_at);

  if (!isAutoPoll) {
    showView('thread-view');
    startThreadPolling();
  }

  if (currentSnapshot !== lastRenderedSnapshot) {
    const isNearBottom = (window.innerHeight + window.scrollY) >= (document.body.offsetHeight - 180);

    lastRenderedSnapshot = currentSnapshot;
    renderThreadDetail(data);

    if (isAutoPoll && newCommentCount > prevCommentCount && isNearBottom) {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    }
  }

  return true;
}

function renderThreadDetail(data) {
  const { thread, comments, currentUserId } = data;
  const isCreator = thread.creator_id === currentUserId;
  const blockedIdSet = new Set(currentBlockedUsers.map(u => u.id));

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
    document.getElementById('blocked-count').textContent = currentBlockedUsers.length;
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
    const isUserBlocked = blockedIdSet.has(c.user_id);

    // スレ主のみ、自分以外のユーザーに対してブロックボタンを表示
    const canBlock = isCreator && (c.user_id !== currentUserId);

    const rawTime = String(c.created_at).replace(' ', 'T').replace(/(Z|[+-]\d{2}:?\d{2})$/, '');
    const dateStr = new Date(rawTime).toLocaleString('ja-JP', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    const card = document.createElement('div');
    card.className = 'comment-card';

    const blockButtonHtml = canBlock
      ? (isUserBlocked
        ? `<span style="font-size:0.78rem; color:var(--text-muted);">🚫ブロック中</span>`
        : `<button class="block-user-btn" onclick="blockUser(${c.user_id}, '${escapeJsString(c.author_name)}')">🚫 ブロック</button>`)
      : '';

    if (c.is_deleted) {
      card.innerHTML = `
        <div class="comment-header">
          <span class="comment-author">${escapeHtml(displayAuthor)}</span>
          <span>${dateStr}</span>
        </div>
        <div class="deleted-message">メッセージが削除されました</div>
        ${blockButtonHtml ? `<div class="comment-footer"><span></span><div class="comment-actions-right">${blockButtonHtml}</div></div>` : ''}
      `;
    } else {
      card.innerHTML = `
        <div class="comment-header">
          <span class="comment-author">${escapeHtml(displayAuthor)}</span>
          <span>${dateStr}</span>
        </div>
        ${c.content ? `<div class="comment-body">${escapeHtml(c.content)}</div>` : ''}
        ${c.image_data ? `<img src="${c.image_data}" class="comment-image" alt="添付画像" onclick="openImageLightbox(this.src)">` : ''}
        <div class="comment-footer">
          <button class="like-btn ${c.is_liked ? 'liked' : ''}" onclick="toggleLike(${c.id})">
            💕 <span>${c.like_count}</span>
          </button>
          <div class="comment-actions-right">
            ${blockButtonHtml}
            ${canDelete ? `<button class="delete-comment-btn" onclick="deleteComment(${c.id})">削除</button>` : ''}
          </div>
        </div>
      `;
    }

    listEl.appendChild(card);
  });
}

async function blockUser(targetUserId, targetUsername) {
  if (!confirm(`「${targetUsername}」さんをこのスレッドからブロックしますか？\nブロックされたユーザーはこのスレッドを開けなくなります。`)) {
    return;
  }
  const res = await fetch(`/api/threads/${currentThreadId}/block`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetUserId })
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error);
    return;
  }
  alert(`「${targetUsername}」さんをブロックしました。`);
  refreshCurrentThread();
}

function openBlockedUsersModal() {
  const listEl = document.getElementById('blocked-users-list');
  listEl.innerHTML = '';

  if (currentBlockedUsers.length === 0) {
    listEl.innerHTML = '<p style="font-size:0.88rem; color:var(--text-muted); margin:8px 0;">現在ブロックしているユーザーはいません。</p>';
  } else {
    currentBlockedUsers.forEach(u => {
      const row = document.createElement('div');
      row.className = 'blocked-user-row';
      row.innerHTML = `
        <span>${escapeHtml(u.username)}</span>
        <button class="btn btn-outline btn-sm" onclick="unblockUser(${u.id}, '${escapeJsString(u.username)}')">解除</button>
      `;
      listEl.appendChild(row);
    });
  }
  document.getElementById('blocked-users-modal').classList.remove('hidden');
}

function closeBlockedUsersModal() {
  document.getElementById('blocked-users-modal').classList.add('hidden');
}

async function unblockUser(targetUserId, targetUsername) {
  if (!confirm(`「${targetUsername}」さんのブロックを解除しますか？`)) return;
  const res = await fetch(`/api/threads/${currentThreadId}/block/${targetUserId}`, { method: 'DELETE' });
  if (res.ok) {
    closeBlockedUsersModal();
    refreshCurrentThread();
  }
}

// ==========================================
// コメント投稿・画像処理・削除・いいね
// ==========================================

function previewImage(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (event) {
    const img = new Image();
    img.onload = function () {
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
  await loadThreadDetail(currentThreadId, currentRoomCode, false);
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
}

async function deleteComment(commentId) {
  if (!confirm('このコメントを削除しますか？')) return;
  const res = await fetch(`/api/comments/${commentId}`, { method: 'DELETE' });
  if (res.ok) {
    loadThreadDetail(currentThreadId, currentRoomCode, false);
  }
}

async function toggleLike(commentId) {
  const res = await fetch(`/api/comments/${commentId}/like`, { method: 'POST' });
  if (res.ok) {
    loadThreadDetail(currentThreadId, currentRoomCode, false);
  }
}

async function toggleReadonly() {
  const res = await fetch(`/api/threads/${currentThreadId}/readonly`, { method: 'PATCH' });
  if (res.ok) {
    loadThreadDetail(currentThreadId, currentRoomCode, false);
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

function escapeJsString(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
}

// ==========================================
// 画像拡大表示（画像専用ピンチズーム同時移動・PCクリック拡大対応）
// ==========================================

let lbScale = 1;
let lbTranslateX = 0;
let lbTranslateY = 0;
let lbIsDragging = false;
let lbHasMoved = false;
let lbStartX = 0;
let lbStartY = 0;
let lbInitialPinchDist = 0;
let lbInitialScale = 1;
let lbInitialPinchCenterX = 0;
let lbInitialPinchCenterY = 0;
let lbInitialTranslateX = 0;
let lbInitialTranslateY = 0;
let lbLastTapTime = 0;

function updateLightboxTransform() {
  const img = document.getElementById('lightbox-image');
  if (!img) return;
  if (lbScale <= 1) {
    lbScale = 1;
    lbTranslateX = 0;
    lbTranslateY = 0;
    img.style.cursor = 'zoom-in';
  } else {
    img.style.cursor = lbIsDragging ? 'grabbing' : 'zoom-out';
  }
  img.style.transform = `translate(${lbTranslateX}px, ${lbTranslateY}px) scale(${lbScale})`;
}

function buildCustomLightbox() {
  const oldModal = document.getElementById('image-lightbox-modal');
  if (oldModal) oldModal.remove();

  const modal = document.createElement('div');
  modal.id = 'image-lightbox-modal';
  Object.assign(modal.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '100vw',
    height: '100vh',
    backgroundColor: 'rgba(0, 0, 0, 0.94)',
    zIndex: '99999',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
    touchAction: 'none',
    userSelect: 'none',
    webkitUserSelect: 'none'
  });

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.id = 'lightbox-close-btn';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', '閉じる');
  Object.assign(closeBtn.style, {
    position: 'fixed',
    top: 'max(16px, env(safe-area-inset-top, 16px))',
    right: '16px',
    width: '44px',
    height: '44px',
    borderRadius: '50%',
    border: '1px solid rgba(255, 255, 255, 0.45)',
    backgroundColor: 'rgba(35, 35, 35, 0.88)',
    color: '#ffffff',
    fontSize: '20px',
    fontWeight: 'bold',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    cursor: 'pointer',
    zIndex: '100001'
  });

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeImageLightbox();
  });

  const img = document.createElement('img');
  img.id = 'lightbox-image';
  img.alt = '拡大画像';
  img.draggable = false;
  Object.assign(img.style, {
    maxWidth: '92vw',
    maxHeight: '88vh',
    width: 'auto',
    height: 'auto',
    objectFit: 'contain',
    borderRadius: '6px',
    transformOrigin: 'center center',
    transition: 'transform 0.12s ease-out',
    cursor: 'zoom-in',
    touchAction: 'none'
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeImageLightbox();
    }
  });

  // PCマウス操作
  img.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    lbIsDragging = true;
    lbHasMoved = false;
    lbStartX = e.clientX - lbTranslateX;
    lbStartY = e.clientY - lbTranslateY;
    img.style.transition = 'none';
    if (lbScale > 1) img.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', (e) => {
    if (!lbIsDragging) return;
    const dx = e.clientX - lbStartX;
    const dy = e.clientY - lbStartY;
    if (Math.abs(dx - lbTranslateX) > 3 || Math.abs(dy - lbTranslateY) > 3) {
      lbHasMoved = true;
    }
    if (lbScale > 1) {
      lbTranslateX = dx;
      lbTranslateY = dy;
      updateLightboxTransform();
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (!lbIsDragging) return;
    lbIsDragging = false;
    img.style.transition = 'transform 0.15s ease-out';
    if (!lbHasMoved && e.target === img) {
      if (lbScale === 1) {
        lbScale = 2;
      } else {
        lbScale = 1;
        lbTranslateX = 0;
        lbTranslateY = 0;
      }
    }
    updateLightboxTransform();
  });

  modal.addEventListener('wheel', (e) => {
    e.preventDefault();
    img.style.transition = 'transform 0.08s ease-out';
    const delta = e.deltaY < 0 ? 0.25 : -0.25;
    lbScale = Math.min(4, Math.max(1, lbScale + delta));
    updateLightboxTransform();
  }, { passive: false });

  // スマホタッチ操作：ピンチズームしながら同時に移動（焦点追従＋2本指パン）
  const handleTouchStart = (e) => {
    e.stopPropagation();
    img.style.transition = 'none';

    if (e.touches.length === 2) {
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      lbInitialPinchDist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
      lbInitialScale = lbScale;
      lbInitialPinchCenterX = (t0.clientX + t1.clientX) / 2;
      lbInitialPinchCenterY = (t0.clientY + t1.clientY) / 2;
      lbInitialTranslateX = lbTranslateX;
      lbInitialTranslateY = lbTranslateY;
    } else if (e.touches.length === 1) {
      lbStartX = e.touches[0].clientX - lbTranslateX;
      lbStartY = e.touches[0].clientY - lbTranslateY;

      const now = Date.now();
      if (now - lbLastTapTime < 280) {
        img.style.transition = 'transform 0.18s ease-out';
        if (lbScale === 1) {
          lbScale = 2.2;
        } else {
          lbScale = 1;
          lbTranslateX = 0;
          lbTranslateY = 0;
        }
        updateLightboxTransform();
      }
      lbLastTapTime = now;
    }
  };

  const handleTouchMove = (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.touches.length === 2 && lbInitialPinchDist > 0) {
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
      const newScale = Math.min(4.5, Math.max(1, lbInitialScale * (dist / lbInitialPinchDist)));

      // 現在の2本指の重心座標
      const currentCenterX = (t0.clientX + t1.clientX) / 2;
      const currentCenterY = (t0.clientY + t1.clientY) / 2;

      // 画面中央からのオフセット
      const screenCenterX = window.innerWidth / 2;
      const screenCenterY = window.innerHeight / 2;
      const focalX = lbInitialPinchCenterX - screenCenterX;
      const focalY = lbInitialPinchCenterY - screenCenterY;

      // 拡大倍率の変化に伴う焦点のズレ補正 ＋ 2本指自体の移動量を加算
      const scaleRatio = newScale / lbInitialScale;
      const panDx = currentCenterX - lbInitialPinchCenterX;
      const panDy = currentCenterY - lbInitialPinchCenterY;

      lbScale = newScale;
      lbTranslateX = focalX - (focalX - lbInitialTranslateX) * scaleRatio + panDx;
      lbTranslateY = focalY - (focalY - lbInitialTranslateY) * scaleRatio + panDy;

      updateLightboxTransform();
    } else if (e.touches.length === 1 && lbScale > 1) {
      lbTranslateX = e.touches[0].clientX - lbStartX;
      lbTranslateY = e.touches[0].clientY - lbStartY;
      updateLightboxTransform();
    }
  };

  const handleTouchEnd = (e) => {
    if (e.touches.length === 1) {
      // 2本指から1本指になった瞬間に、残った1本指の現在位置を基準に再セット（ワープ防止）
      lbInitialPinchDist = 0;
      lbStartX = e.touches[0].clientX - lbTranslateX;
      lbStartY = e.touches[0].clientY - lbTranslateY;
    } else if (e.touches.length === 0) {
      lbInitialPinchDist = 0;
      img.style.transition = 'transform 0.15s ease-out';
      if (lbScale < 1.05) {
        lbScale = 1;
        lbTranslateX = 0;
        lbTranslateY = 0;
        updateLightboxTransform();
      }
    }
  };

  // ズームして画像が画面いっぱいに広がった状態でも操作できるよう modal 全体でタッチを受け取る
  modal.addEventListener('touchstart', handleTouchStart, { passive: true });
  modal.addEventListener('touchmove', handleTouchMove, { passive: false });
  modal.addEventListener('touchend', handleTouchEnd, { passive: true });

  modal.appendChild(closeBtn);
  modal.appendChild(img);
  document.body.appendChild(modal);
  return { modal, img };
}

function openImageLightbox(src) {
  if (!src) return;
  lbScale = 1;
  lbTranslateX = 0;
  lbTranslateY = 0;
  lbIsDragging = false;
  lbHasMoved = false;

  const { modal, img } = buildCustomLightbox();
  img.src = src;
  updateLightboxTransform();
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeImageLightbox() {
  const modal = document.getElementById('image-lightbox-modal');
  if (modal) {
    modal.remove();
  }
  lbScale = 1;
  lbTranslateX = 0;
  lbTranslateY = 0;
  document.body.style.overflow = '';
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeImageLightbox();
  }
});
// ==========================================
// いいね押下時の上部ジャンプ完全防止（スクロール追従型）
// ==========================================
(function() {
  const origFetch = window.fetch;

  window.fetch = async function(input, options) {
    const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');

    if (url.includes('/like') && options && options.method && options.method.toUpperCase() === 'POST') {
      // ユーザーが現在見ているスクロール位置（ユーザーが動かしたらその位置に更新する）
      let targetScrollY = window.scrollY;
      let isRestoring = false;
      const docHeight = document.documentElement.scrollHeight;

      // 再描画の瞬間にページ高さが縮んで上へ押し上げられるのを防ぐため高さを一時保持
      document.body.style.minHeight = Math.max(docHeight, targetScrollY + window.innerHeight) + 'px';

      // ユーザー自身のスクロール操作で位置が変わった場合は、それを「新しい正しい位置」として記憶する
      const onScroll = () => {
        if (isRestoring) return;
        // 突然0（一番上）に飛んだ場合はブラウザの強制リセットなので無視し、それ以外の移動は追従する
        if (window.scrollY > 0 || targetScrollY < 150) {
          targetScrollY = window.scrollY;
        }
      };

      window.addEventListener('scroll', onScroll, { passive: true });

      // DOM書き換え（コメント一覧の再描画）が起きた瞬間だけ、記憶している最新位置へ復元する
      const observer = new MutationObserver(() => {
        if (Math.abs(window.scrollY - targetScrollY) > 5) {
          isRestoring = true;
          window.scrollTo(0, targetScrollY);
          requestAnimationFrame(() => {
            isRestoring = false;
          });
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      try {
        const res = await origFetch.apply(this, arguments);

        setTimeout(() => {
          observer.disconnect();
          window.removeEventListener('scroll', onScroll);
          document.body.style.minHeight = '';
        }, 1000);

        return res;
      } catch (err) {
        observer.disconnect();
        window.removeEventListener('scroll', onScroll);
        document.body.style.minHeight = '';
        throw err;
      }
    }

    return origFetch.apply(this, arguments);
  };
})();