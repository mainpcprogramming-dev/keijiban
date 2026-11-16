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

    const dateStr = new Date(c.created_at).toLocaleString('ja-JP', {
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
        ${c.image_data ? `<img src="${c.image_data}" class="comment-image" alt="添付画像">` : ''}
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