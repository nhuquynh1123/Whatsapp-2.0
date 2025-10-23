const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const sqlite3 = require("sqlite3").verbose();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");

const app = express();
app.use(cors());
app.use(express.json());

const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});

const upload = multer({ storage });
app.use("/uploads", express.static(UPLOAD_DIR));

const db = new sqlite3.Database(path.join(__dirname, "messages.db"), (err) => {
  if (err) {
    console.error("Lỗi DB:", err);
    process.exit(1);
  }
  console.log("DB ok");
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    avatar TEXT,
    status TEXT DEFAULT 'offline',
    last_seen DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL,
    receiver TEXT,
    content TEXT,
    image_urls TEXT,
    type TEXT DEFAULT 'text',
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS friendships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requester TEXT NOT NULL,
    receiver TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(requester, receiver)
  )`);
});

app.post("/register", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Thiếu thông tin" });
  if (username.length < 3) return res.status(400).json({ error: "Username quá ngắn" });
  if (password.length < 6) return res.status(400).json({ error: "Mật khẩu quá ngắn" });

  const hashed = bcrypt.hashSync(password, 10);
  db.run("INSERT INTO users (username, password) VALUES (?, ?)", [username, hashed], function (err) {
    if (err) {
      if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "Tên đã tồn tại" });
      return res.status(500).json({ error: "Lỗi server" });
    }
    res.json({ success: true, message: "Đăng ký ok" });
  });
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Thiếu thông tin" });

  db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
    if (err) return res.status(500).json({ error: "Lỗi DB" });
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(400).json({ error: "Sai tài khoản hoặc mật khẩu" });
    }

    db.run("UPDATE users SET status = 'online', last_seen = CURRENT_TIMESTAMP WHERE username = ?", [username]);
    res.json({
      success: true,
      message: "Đăng nhập thành công",
      user: { id: user.id, username: user.username, avatar: user.avatar },
    });
  });
});

app.post("/upload", upload.array("images", 20), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: "Không có file" });
  const host = req.headers.host || "localhost:3000";
  const protocol = req.protocol || "http";
  const urls = req.files.map((f) => `${protocol}://${host}/uploads/${encodeURIComponent(f.filename)}`);
  res.json({ imageUrls: urls });
});

function isUrl(text) {
  return text && /(https?:\/\/[^\s]+)/gi.test(text);
}

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
const onlineUsers = new Map();
const userSockets = new Map();

io.on("connection", (socket) => {
  console.log("Connect:", socket.id);

  socket.on("register_user", (username) => {
    onlineUsers.set(socket.id, username);
    userSockets.set(username, socket.id);
    db.run("UPDATE users SET status = 'online', last_seen = CURRENT_TIMESTAMP WHERE username = ?", [username]);
    io.emit("user_list", Array.from(onlineUsers.values()));
    io.emit("user_status_changed", { username, status: "online" });
  });

  db.all("SELECT * FROM messages ORDER BY created_at ASC LIMIT 1000", [], (err, rows) => {
    if (!err) {
      socket.emit("load_messages", rows.map((r) => ({ ...r, image_urls: r.image_urls ? JSON.parse(r.image_urls) : [] })));
    }
  });

  socket.on("send_message", (data) => {
    const { sender = "anon", receiver = null, content = "", imageUrls = [] } = data;
    let type = "text";
    if (imageUrls.length > 0) type = "image";
    else if (isUrl(content)) type = "link";

    db.run(
      "INSERT INTO messages (sender, receiver, content, image_urls, type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [sender, receiver, content, JSON.stringify(imageUrls), type, new Date().toISOString()],
      function (err) {
        if (err) return console.error("Lỗi save msg:", err);
        db.get("SELECT * FROM messages WHERE id = ?", [this.lastID], (e, row) => {
          if (!e && row) {
            const msg = { ...row, image_urls: row.image_urls ? JSON.parse(row.image_urls) : [] };
            if (receiver) {
              const rSocket = userSockets.get(receiver);
              const sSocket = userSockets.get(sender);
              if (rSocket) io.to(rSocket).emit("receive_message", msg);
              if (sSocket) io.to(sSocket).emit("receive_message", msg);
            } else {
              io.emit("receive_message", msg);
            }
          }
        });
      }
    );
  });

  socket.on("mark_read", ({ sender, receiver }) => {
    db.run("UPDATE messages SET is_read = 1 WHERE sender = ? AND receiver = ?", [sender, receiver], (err) => {
      if (!err) {
        const target = userSockets.get(sender);
        if (target) io.to(target).emit("messages_read", { by: receiver });
      }
    });
  });

  socket.on("disconnect", () => {
    const user = onlineUsers.get(socket.id);
    if (user) {
      db.run("UPDATE users SET status = 'offline', last_seen = CURRENT_TIMESTAMP WHERE username = ?", [user]);
      onlineUsers.delete(socket.id);
      userSockets.delete(user);
      io.emit("user_list", Array.from(onlineUsers.values()));
      io.emit("user_status_changed", { username: user, status: "offline" });
    }
  });
});

app.post("/friend-request", (req, res) => {
  const { requester, receiver } = req.body;
  if (!requester || !receiver) return res.status(400).json({ error: "Thiếu info" });
  if (requester === receiver) return res.status(400).json({ error: "Không thể tự kết bạn" });

  db.get(
    "SELECT * FROM friendships WHERE (requester = ? AND receiver = ?) OR (requester = ? AND receiver = ?)",
    [requester, receiver, receiver, requester],
    (err, ex) => {
      if (err) return res.status(500).json({ error: "Lỗi" });
      if (ex) return res.status(400).json({ error: ex.status === "accepted" ? "Đã là bạn" : "Đã gửi rồi" });

      db.run("INSERT INTO friendships (requester, receiver) VALUES (?, ?)", [requester, receiver], (err) => {
        if (err) return res.status(500).json({ error: "Không gửi được" });
        res.json({ success: true, message: "Đã gửi lời mời" });
        const rSocket = userSockets.get(receiver);
        if (rSocket) io.to(rSocket).emit("friend_request_received", { from: requester });
      });
    }
  );
});

app.post("/friend-response", (req, res) => {
  const { requester, receiver, accepted } = req.body;
  const status = accepted ? "accepted" : "rejected";
  db.run("UPDATE friendships SET status = ? WHERE requester = ? AND receiver = ?", [status, requester, receiver], (err) => {
    if (err) return res.status(500).json({ error: "Lỗi" });
    res.json({ success: true, message: accepted ? "Đã chấp nhận" : "Đã từ chối" });
    if (accepted) {
      const rSocket = userSockets.get(requester);
      if (rSocket) io.to(rSocket).emit("friend_request_accepted", { by: receiver });
    }
  });
});

// API conversation list giống Zalo
app.get("/conversations/:username", (req, res) => {
  const u = req.params.username;
  const query = `
    WITH friends AS (
      SELECT CASE WHEN requester = ? THEN receiver ELSE requester END as friend
      FROM friendships WHERE (requester = ? OR receiver = ?) AND status = 'accepted'
    ),
    last_msg AS (
      SELECT 
        CASE WHEN sender = ? THEN receiver ELSE sender END as with_user,
        MAX(created_at) as time
      FROM messages WHERE sender = ? OR receiver = ?
      GROUP BY with_user
    )
    SELECT 
      f.friend as username,
      u.avatar, u.status, u.last_seen,
      lm.time as last_time,
      m.content as last_msg,
      m.type as msg_type,
      COALESCE((SELECT COUNT(*) FROM messages WHERE sender = f.friend AND receiver = ? AND is_read = 0), 0) as unread
    FROM friends f
    LEFT JOIN users u ON u.username = f.friend
    LEFT JOIN last_msg lm ON lm.with_user = f.friend
    LEFT JOIN messages m ON m.created_at = lm.time
    ORDER BY lm.time DESC NULLS LAST
  `;
  
  db.all(query, [u, u, u, u, u, u, u], (err, rows) => {
    if (err) return res.status(500).json({ error: "Lỗi" });
    res.json(rows.map(r => ({
      username: r.username,
      avatar: r.avatar,
      status: r.status,
      lastSeen: r.last_seen,
      lastMessage: r.last_msg || "Chưa có tin nhắn",
      lastMessageType: r.msg_type,
      lastMessageTime: r.last_time,
      unreadCount: r.unread
    })));
  });
});

app.get("/friends/:username", (req, res) => {
  const u = req.params.username;
  const query = `
    SELECT CASE WHEN requester = ? THEN receiver ELSE requester END as username,
           u.avatar, u.status, u.last_seen
    FROM friendships f
    LEFT JOIN users u ON u.username = (CASE WHEN requester = ? THEN receiver ELSE requester END)
    WHERE (requester = ? OR receiver = ?) AND status = 'accepted'
    ORDER BY u.status DESC
  `;
  db.all(query, [u, u, u, u], (err, rows) => {
    if (err) return res.status(500).json({ error: "Lỗi" });
    res.json(rows);
  });
});

app.get("/friend-requests/:username", (req, res) => {
  db.all(
    "SELECT f.requester as username, u.avatar, f.created_at FROM friendships f LEFT JOIN users u ON u.username = f.requester WHERE f.receiver = ? AND f.status = 'pending'",
    [req.params.username],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "Lỗi" });
      res.json(rows);
    }
  );
});

app.get("/messages/:user1/:user2", (req, res) => {
  const { user1, user2 } = req.params;
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  
  db.all(
    "SELECT * FROM messages WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?) ORDER BY created_at DESC LIMIT ? OFFSET ?",
    [user1, user2, user2, user1, limit, offset],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "Lỗi" });
      res.json(rows.reverse().map(r => ({ ...r, image_urls: r.image_urls ? JSON.parse(r.image_urls) : [] })));
    }
  );
});

app.get("/search", (req, res) => {
  const q = `%${req.query.query || ""}%`;
  const u = req.query.current_user;
  
  db.all(
    `SELECT u.username, u.avatar, u.status,
     CASE WHEN f.status = 'accepted' THEN 'friend'
          WHEN f.status = 'pending' AND f.requester = ? THEN 'requested'
          WHEN f.status = 'pending' AND f.receiver = ? THEN 'pending'
          ELSE 'none' END as friendship
     FROM users u
     LEFT JOIN friendships f ON (f.requester = ? AND f.receiver = u.username) OR (f.receiver = ? AND f.requester = u.username)
     WHERE u.username LIKE ? AND u.username != ? LIMIT 20`,
    [u, u, u, u, q, u],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "Lỗi" });
      res.json(rows);
    }
  );
});

app.get("/", (req, res) => res.send("Server running"));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server at http://localhost:${PORT}`));