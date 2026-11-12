require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL接続設定（Renderの環境変数 DATABASE_URL を使用）
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// 画像データ(Base64)を受け取れるように上限を10MBに設定
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Renderのプロキシ背後でSecure Cookieを機能させる設定
app.set('trust proxy', 1);

// セッション設定（PostgreSQLにセッションを保存し、再起動してもログアウトしないようにする）
app.use(session({
  store: new pgSession({
    pool: pool,
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'calm-board-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30日間ログイン状態を維持
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

// データベース初期化（テーブル自動作成）
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS comments (
        id SERIAL PRIMARY KEY,
        thread_id INTEGER REFERENCES threads(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        author_name VARCHAR(50) NOT NULL,
        content TEXT,
        image_data TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS likes (
        id SERIAL PRIMARY KEY,
        comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(comment_id, user_id)
      );
    `);
    console.log('データベースの初期化が完了しました');
  } catch (err) {
    console.error('DB初期化エラー:', err);
  } finally {
    client.release();
  }
}
initDB();

// ログイン確認ミドルウェア
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'ログインが必要です' });
  }
  next();
}

// 4桁のランダム部屋番号生成
function generateRoomCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// ==========================================
// 認証API
// ==========================================

// 現在のログイン状態取得
app.get('/api/me', (req, res) => {
  if (req.session.userId) {
    res.json({ loggedIn: true, userId: req.session.userId, username: req.session.username });
  } else {
    res.json({ loggedIn: false });
  }
});

// アカウント新規登録
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.trim() === '' || password.trim() === '') {
    return res.status(400).json({ error: 'ユーザー名とパスワードは必須です' });
  }
  try {
    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
      [username.trim(), hashed]
    );
    req.session.userId = result.rows[0].id;
    req.session.username = result.rows[0].username;
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') { // 一意性制約違反
      return res.status(400).json({ error: 'そのユーザー名は既に使用されています' });
    }
    res.status(500).json({ error: '登録中にエラーが発生しました' });
  }
});

// ログイン
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
    res.json({ success: true, user: { id: user.id, username: user.username } });
  } catch (err) {
    res.status(500).json({ error: 'ログイン中にエラーが発生しました' });
  }
});

// ログアウト
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ==========================================
// スレッドAPI
// ==========================================

// スレッド一覧取得（ロビー用）
app.get('/api/threads', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        t.id, t.title, t.author_name, t.creator_id, t.is_private, t.is_readonly, t.created_at,
        CASE WHEN t.creator_id = $1 THEN t.room_code ELSE NULL END as room_code,
        COUNT(c.id)::int as comment_count
      FROM threads t
      LEFT JOIN comments c ON t.id = c.thread_id
      GROUP BY t.id
      ORDER BY t.created_at DESC
    `, [req.session.userId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'スレッド一覧の取得に失敗しました' });
  }
});

// スレッド新規作成
app.post('/api/threads', requireAuth, async (req, res) => {
  const { title, authorName, isPrivate } = req.body;
  if (!title || !authorName) {
    return res.status(400).json({ error: 'タイトルとスレ主名は必須です' });
  }
  const roomCode = isPrivate ? generateRoomCode() : null;
  try {
    const result = await pool.query(
      `INSERT INTO threads (title, author_name, creator_id, is_private, room_code)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [title.trim(), authorName.trim(), req.session.userId, !!isPrivate, roomCode]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'スレッドの作成に失敗しました' });
  }
});

// スレッド詳細＆コメント一覧取得
app.get('/api/threads/:id', requireAuth, async (req, res) => {
  const threadId = req.params.id;
  const inputCode = req.query.code;

  try {
    const threadRes = await pool.query('SELECT * FROM threads WHERE id = $1', [threadId]);
    if (threadRes.rows.length === 0) {
      return res.status(404).json({ error: 'スレッドが見つかりません' });
    }
    const thread = threadRes.rows[0];

    // プライベートスレッドの閲覧権限チェック（作成者本人または正しい部屋番号）
    if (thread.is_private && thread.creator_id !== req.session.userId) {
      if (thread.room_code !== inputCode) {
        return res.status(403).json({ error: '部屋番号が正しくありません', requireCode: true });
      }
    }

    // コメント一覧といいね数、自分がいいね済みかを取得
    const commentsRes = await pool.query(`
      SELECT 
        c.id, c.thread_id, c.user_id, c.author_name, c.content, c.image_data, c.created_at,
        COUNT(l.id)::int as like_count,
        BOOL_OR(l.user_id = $1) as is_liked
      FROM comments c
      LEFT JOIN likes l ON c.id = l.comment_id
      WHERE c.thread_id = $2
      GROUP BY c.id
      ORDER BY c.created_at ASC
    `, [req.session.userId, threadId]);

    // 作成者以外にはroom_codeを隠す
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

// スレッドの閲覧モード切り替え（スレ主のみ）
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

// スレッド削除（スレ主のみ）
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

// コメント投稿
app.post('/api/threads/:id/comments', requireAuth, async (req, res) => {
  const threadId = req.params.id;
  const { content, imageData } = req.body;

  if ((!content || content.trim() === '') && !imageData) {
    return res.status(400).json({ error: 'コメントまたは画像を入力してください' });
  }

  try {
    const threadRes = await pool.query('SELECT * FROM threads WHERE id = $1', [threadId]);
    if (threadRes.rows.length === 0) return res.status(404).json({ error: 'スレッドが見つかりません' });
    
    // 閲覧モードチェック
    if (threadRes.rows[0].is_readonly) {
      return res.status(403).json({ error: 'このスレッドは現在閲覧モードのため書き込みできません' });
    }

    await pool.query(
      `INSERT INTO comments (thread_id, user_id, author_name, content, image_data)
       VALUES ($1, $2, $3, $4, $5)`,
      [threadId, req.session.userId, req.session.username, content ? content.trim() : '', imageData || null]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'コメントの投稿に失敗しました' });
  }
});

// コメント削除（スレッド作成者 OR コメント送信者のみ）
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

    await pool.query('DELETE FROM comments WHERE id = $1', [commentId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'コメントの削除に失敗しました' });
  }
});

// いいね切り替え
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
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'いいねの処理に失敗しました' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});