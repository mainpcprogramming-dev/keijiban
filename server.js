require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const webpush = require('web-push');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.set('trust proxy', 1);

app.use(session({
  store: new pgSession({
    pool: pool,
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'calm-board-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

let vapidPublicKey = '';

// データベース初期化＆VAPID鍵の自動生成・読み込み
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_config (
        key VARCHAR(50) PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        notifications_enabled BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS threads (
        id SERIAL PRIMARY KEY,
        title VARCHAR(100) NOT NULL,
        author_name VARCHAR(50) NOT NULL,
        creator_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        is_private BOOLEAN DEFAULT FALSE,
        room_code VARCHAR(10),
        is_readonly BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS comments (
        id SERIAL PRIMARY KEY,
        thread_id INTEGER REFERENCES threads(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        author_name VARCHAR(50) NOT NULL,
        content TEXT,
        image_data TEXT,
        is_deleted BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS likes (
        id SERIAL PRIMARY KEY,
        comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(comment_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT UNIQUE NOT NULL,
        subscription_json TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS notifications_enabled BOOLEAN DEFAULT TRUE;
      ALTER TABLE threads ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE comments ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
    `);

    // Web Push用VAPIDキーをDBから取得、なければ自動生成して永続保存
    const pubRes = await client.query("SELECT value FROM app_config WHERE key = 'vapid_public'");
    const privRes = await client.query("SELECT value FROM app_config WHERE key = 'vapid_private'");

    let publicKey, privateKey;
    if (pubRes.rows.length > 0 && privRes.rows.length > 0) {
      publicKey = pubRes.rows[0].value;
      privateKey = privRes.rows[0].value;
    } else {
      const keys = webpush.generateVAPIDKeys();
      publicKey = keys.publicKey;
      privateKey = keys.privateKey;
      await client.query("INSERT INTO app_config (key, value) VALUES ('vapid_public', $1), ('vapid_private', $2)", [publicKey, privateKey]);
    }

    vapidPublicKey = publicKey;
    webpush.setVapidDetails('mailto:admin@quietboard.example.com', publicKey, privateKey);

    console.log('データベースとプッシュ通知設定の初期化が完了しました');
  } catch (err) {
    console.error('DB初期化エラー:', err);
  } finally {
    client.release();
  }
}
initDB();

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'ログインが必要です' });
  }
  next();
}

function generateRoomCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// 対象ユーザー群にWeb Push通知を送信するヘルパー
async function sendPushNotifications(targetUserIds, payloadObj) {
  if (!targetUserIds || targetUserIds.length === 0) return;
  try {
    const subsRes = await pool.query(`
      SELECT ps.id, ps.subscription_json
      FROM push_subscriptions ps
      JOIN users u ON ps.user_id = u.id
      WHERE ps.user_id = ANY($1::int[]) AND u.notifications_enabled = TRUE
    `, [targetUserIds]);

    const payloadStr = JSON.stringify(payloadObj);

    for (const row of subsRes.rows) {
      try {
        const sub = JSON.parse(row.subscription_json);
        await webpush.sendNotification(sub, payloadStr);
      } catch (err) {
        // 期限切れ・無効になった購読情報は自動削除
        if (err.statusCode === 404 || err.statusCode === 410) {
          await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [row.id]);
        }
      }
    }
  } catch (err) {
    console.error('プッシュ通知送信エラー:', err);
  }
}

// ==========================================
// 認証・アカウント設定API
// ==========================================

app.get('/api/me', async (req, res) => {
  if (!req.session.userId) {
    return res.json({ loggedIn: false });
  }
  try {
    const userRes = await pool.query('SELECT id, username, notifications_enabled FROM users WHERE id = $1', [req.session.userId]);
    if (userRes.rows.length === 0) {
      req.session.destroy();
      return res.json({ loggedIn: false });
    }
    res.json({
      loggedIn: true,
      userId: userRes.rows[0].id,
      username: userRes.rows[0].username,
      notificationsEnabled: userRes.rows[0].notifications_enabled
    });
  } catch {
    res.json({ loggedIn: false });
  }
});

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.trim() === '' || password.trim() === '') {
    return res.status(400).json({ error: 'ユーザー名とパスワードは必須です' });
  }
  try {
    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, notifications_enabled',
      [username.trim(), hashed]
    );
    req.session.userId = result.rows[0].id;
    req.session.username = result.rows[0].username;
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'そのユーザー名は既に使用されています' });
    }
    res.status(500).json({ error: '登録中にエラーが発生しました' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'ユーザー名とパスワードを入力してください' });
  }
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username.trim()]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'ユーザー名またはパスワードが間違っています' });
    }
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'ユーザー名またはパスワードが間違っています' });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({
      success: true,
      user: { id: user.id, username: user.username, notifications_enabled: user.notifications_enabled }
    });
  } catch (err) {
    res.status(500).json({ error: 'ログイン中にエラーが発生しました' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// パスワード変更（変更後は即ログアウト）
app.post('/api/account/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword || newPassword.trim() === '') {
    return res.status(400).json({ error: '現在のパスワードと新しいパスワードを入力してください' });
  }
  try {
    const userRes = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'ユーザーが見つかりません' });

    const match = await bcrypt.compare(currentPassword, userRes.rows[0].password_hash);
    if (!match) {
      return res.status(400).json({ error: '現在のパスワードが一致しません' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.session.userId]);

    // セッションを破棄して即ログアウト
    req.session.destroy(() => {
      res.json({ success: true });
    });
  } catch (err) {
    res.status(500).json({ error: 'パスワードの変更に失敗しました' });
  }
});

// アカウント完全削除（スレッド・コメント・いいね・購読情報もON DELETE CASCADEで全削除）
app.delete('/api/account', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    req.session.destroy(() => {
      res.json({ success: true });
    });
  } catch (err) {
    res.status(500).json({ error: 'アカウントの削除に失敗しました' });
  }
});

// ==========================================
// プッシュ通知設定・購読API
// ==========================================

app.get('/api/push/vapid-public-key', requireAuth, (req, res) => {
  res.json({ publicKey: vapidPublicKey });
});

app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: '不正な購読データです' });
  }
  try {
    await pool.query(`
      INSERT INTO push_subscriptions (user_id, endpoint, subscription_json)
      VALUES ($1, $2, $3)
      ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, subscription_json = $3
    `, [req.session.userId, subscription.endpoint, JSON.stringify(subscription)]);

    await pool.query('UPDATE users SET notifications_enabled = TRUE WHERE id = $1', [req.session.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '通知の登録に失敗しました' });
  }
});

app.post('/api/push/toggle', requireAuth, async (req, res) => {
  const { enabled } = req.body;
  try {
    await pool.query('UPDATE users SET notifications_enabled = $1 WHERE id = $2', [!!enabled, req.session.userId]);
    if (!enabled) {
      await pool.query('DELETE FROM push_subscriptions WHERE user_id = $1', [req.session.userId]);
    }
    res.json({ success: true, enabled: !!enabled });
  } catch (err) {
    res.status(500).json({ error: '通知設定の更新に失敗しました' });
  }
});

// ==========================================
// スレッドAPI
// ==========================================

app.get('/api/threads', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        t.id, t.title, t.author_name, t.creator_id, t.is_private, t.is_readonly, 
        t.created_at, COALESCE(t.updated_at, t.created_at) as updated_at,
        CASE WHEN t.creator_id = $1 THEN t.room_code ELSE NULL END as room_code,
        COUNT(c.id)::int as comment_count
      FROM threads t
      LEFT JOIN comments c ON t.id = c.thread_id
      GROUP BY t.id
      ORDER BY COALESCE(t.updated_at, t.created_at) DESC
    `, [req.session.userId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'スレッド一覧の取得に失敗しました' });
  }
});

app.post('/api/threads', requireAuth, async (req, res) => {
  const { title, authorName, isPrivate } = req.body;
  if (!title || !authorName) {
    return res.status(400).json({ error: 'タイトルとスレ主名は必須です' });
  }
  const roomCode = isPrivate ? generateRoomCode() : null;
  try {
    const result = await pool.query(
      `INSERT INTO threads (title, author_name, creator_id, is_private, room_code, updated_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP) RETURNING *`,
      [title.trim(), authorName.trim(), req.session.userId, !!isPrivate, roomCode]
    );
    const newThread = result.rows[0];

    // 公開スレッドが作成された場合、作成者以外の全ユーザーに通知
    if (!isPrivate) {
      const usersRes = await pool.query('SELECT id FROM users WHERE id != $1', [req.session.userId]);
      const targetIds = usersRes.rows.map(r => r.id);
      sendPushNotifications(targetIds, {
        title: '新しいスレッドが作成されました',
        body: `「${newThread.title}」（スレ主: 👑${newThread.author_name}）`,
        threadId: newThread.id
      });
    }

    res.json(newThread);
  } catch (err) {
    res.status(500).json({ error: 'スレッドの作成に失敗しました' });
  }
});

app.get('/api/threads/:id', requireAuth, async (req, res) => {
  const threadId = req.params.id;
  const inputCode = req.query.code;

  try {
    const threadRes = await pool.query('SELECT * FROM threads WHERE id = $1', [threadId]);
    if (threadRes.rows.length === 0) {
      return res.status(404).json({ error: 'スレッドが見つかりません' });
    }
    const thread = threadRes.rows[0];

    if (thread.is_private && thread.creator_id !== req.session.userId) {
      if (thread.room_code !== inputCode) {
        return res.status(403).json({ error: '部屋番号が正しくありません', requireCode: true });
      }
    }

    const commentsRes = await pool.query(`
      SELECT 
        c.id, c.thread_id, c.user_id, c.author_name, c.content, c.image_data, c.is_deleted, c.created_at,
        COUNT(l.id)::int as like_count,
        BOOL_OR(l.user_id = $1) as is_liked
      FROM comments c
      LEFT JOIN likes l ON c.id = l.comment_id
      WHERE c.thread_id = $2
      GROUP BY c.id
      ORDER BY c.created_at ASC
    `, [req.session.userId, threadId]);

    if (thread.creator_id !== req.session.userId) {
      delete thread.room_code;
    }

    res.json({
      thread,
      comments: commentsRes.rows,
      currentUserId: req.session.userId
    });
  } catch (err) {
    res.status(500).json({ error: 'スレッドの読み込みに失敗しました' });
  }
});

app.patch('/api/threads/:id/readonly', requireAuth, async (req, res) => {
  const threadId = req.params.id;
  try {
    const threadRes = await pool.query('SELECT * FROM threads WHERE id = $1', [threadId]);
    if (threadRes.rows.length === 0) return res.status(404).json({ error: '見つかりません' });
    if (threadRes.rows[0].creator_id !== req.session.userId) {
      return res.status(403).json({ error: '権限がありません' });
    }

    const newState = !threadRes.rows[0].is_readonly;
    await pool.query('UPDATE threads SET is_readonly = $1 WHERE id = $2', [newState, threadId]);
    res.json({ success: true, is_readonly: newState });
  } catch (err) {
    res.status(500).json({ error: '設定の変更に失敗しました' });
  }
});

app.delete('/api/threads/:id', requireAuth, async (req, res) => {
  const threadId = req.params.id;
  try {
    const result = await pool.query(
      'DELETE FROM threads WHERE id = $1 AND creator_id = $2 RETURNING id',
      [threadId, req.session.userId]
    );
    if (result.rows.length === 0) {
      return res.status(403).json({ error: '削除権限がないか、スレッドが存在しません' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'スレッドの削除に失敗しました' });
  }
});

// ==========================================
// コメント・いいねAPI
// ==========================================

app.post('/api/threads/:id/comments', requireAuth, async (req, res) => {
  const threadId = req.params.id;
  const { content, imageData } = req.body;

  if ((!content || content.trim() === '') && !imageData) {
    return res.status(400).json({ error: 'コメントまたは画像を入力してください' });
  }

  try {
    const threadRes = await pool.query('SELECT * FROM threads WHERE id = $1', [threadId]);
    if (threadRes.rows.length === 0) return res.status(404).json({ error: 'スレッドが見つかりません' });
    const thread = threadRes.rows[0];
    
    if (thread.is_readonly) {
      return res.status(403).json({ error: 'このスレッドは現在閲覧モードのため書き込みできません' });
    }

    await pool.query(
      `INSERT INTO comments (thread_id, user_id, author_name, content, image_data)
       VALUES ($1, $2, $3, $4, $5)`,
      [threadId, req.session.userId, req.session.username, content ? content.trim() : '', imageData || null]
    );

    await pool.query('UPDATE threads SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [threadId]);

    // 通知対象：スレッド作成者 ＋ そのスレッドに過去コメントした参加者（投稿者自身は除外）
    const participantsRes = await pool.query(`
      SELECT DISTINCT user_id FROM comments WHERE thread_id = $1 AND user_id != $2
    `, [threadId, req.session.userId]);
    
    const targetSet = new Set(participantsRes.rows.map(r => r.user_id));
    if (thread.creator_id !== req.session.userId) {
      targetSet.add(thread.creator_id);
    }

    const previewText = content && content.trim() ? content.trim().slice(0, 40) : '画像が添付されました';
    sendPushNotifications(Array.from(targetSet), {
      title: `「${thread.title}」に新着メッセージ`,
      body: `${req.session.username}: ${previewText}`,
      threadId: thread.id
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'コメントの投稿に失敗しました' });
  }
});

app.delete('/api/comments/:id', requireAuth, async (req, res) => {
  const commentId = req.params.id;
  try {
    const checkRes = await pool.query(`
      SELECT c.user_id as comment_user_id, t.creator_id as thread_creator_id
      FROM comments c
      JOIN threads t ON c.thread_id = t.id
      WHERE c.id = $1
    `, [commentId]);

    if (checkRes.rows.length === 0) {
      return res.status(404).json({ error: 'コメントが見つかりません' });
    }

    const { comment_user_id, thread_creator_id } = checkRes.rows[0];
    if (req.session.userId !== comment_user_id && req.session.userId !== thread_creator_id) {
      return res.status(403).json({ error: 'このコメントを削除する権限がありません' });
    }

    await pool.query(
      'UPDATE comments SET is_deleted = TRUE, content = NULL, image_data = NULL WHERE id = $1',
      [commentId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'コメントの削除に失敗しました' });
  }
});

app.post('/api/comments/:id/like', requireAuth, async (req, res) => {
  const commentId = req.params.id;
  const userId = req.session.userId;

  try {
    const existing = await pool.query(
      'SELECT id FROM likes WHERE comment_id = $1 AND user_id = $2',
      [commentId, userId]
    );

    if (existing.rows.length > 0) {
      await pool.query('DELETE FROM likes WHERE comment_id = $1 AND user_id = $2', [commentId, userId]);
    } else {
      await pool.query('INSERT INTO likes (comment_id, user_id) VALUES ($1, $2)', [commentId, userId]);

      // コメント投稿者本人以外がいいねを押した場合、コメント投稿者に通知を送る
      const commentInfo = await pool.query(`
        SELECT c.user_id, c.content, c.thread_id, t.title
        FROM comments c
        JOIN threads t ON c.thread_id = t.id
        WHERE c.id = $1
      `, [commentId]);

      if (commentInfo.rows.length > 0) {
        const target = commentInfo.rows[0];
        if (target.user_id !== userId) {
          const msgSnippet = target.content ? `「${target.content.slice(0, 25)}」` : 'あなたの画像投稿';
          sendPushNotifications([target.user_id], {
            title: 'コメントにいいね💕がつきました',
            body: `${req.session.username}さんが${msgSnippet}にいいねしました`,
            threadId: target.thread_id
          });
        }
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'いいねの処理に失敗しました' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});