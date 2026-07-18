// server.js для Deno Deploy
import express from "npm:express@4";
import cors from "npm:cors";
import { createClient } from "npm:@libsql/client";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// ---------- Turso ----------
const turso = createClient({
  url: Deno.env.get("TURSO_URL"),
  authToken: Deno.env.get("TURSO_TOKEN"),
});

// ---------- Создание таблиц ----------
await turso.execute(`
  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    name TEXT,
    peer_id TEXT,
    last_seen INTEGER,
    blocked JSON DEFAULT '{}',
    avatar TEXT,
    bio TEXT,
    is_online BOOLEAN DEFAULT 0,
    created_at INTEGER
  )
`);

await turso.execute(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT,
    from_id TEXT,
    from_name TEXT,
    text TEXT,
    file TEXT,
    time INTEGER,
    is_read BOOLEAN DEFAULT 0,
    reply_to_id TEXT,
    deleted BOOLEAN DEFAULT 0
  )
`);

await turso.execute(`
  CREATE TABLE IF NOT EXISTS email_codes (
    email TEXT PRIMARY KEY,
    code TEXT,
    expires INTEGER,
    name TEXT
  )
`);

await turso.execute(`
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    type TEXT,
    name TEXT,
    creator_id TEXT,
    members JSON DEFAULT '[]',
    admins JSON DEFAULT '[]',
    created_at INTEGER,
    last_message_time INTEGER
  )
`);

// ---------- Brevo ----------
const BREVO_API_KEY = Deno.env.get("BREVO_API_KEY");

async function sendEmail(to, subject, htmlContent) {
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: { name: "Sashka Messenger", email: Deno.env.get("ADMIN_EMAIL") || "sashka@yourdomain.com" },
      to: [{ email: to }],
      subject: subject,
      htmlContent: htmlContent,
    }),
  });
  return response.json();
}

// ---------- Вспомогательные функции ----------
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function now() {
  return Date.now();
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m] || m));
}

// ---------- API ----------

// 1. Отправить код
app.post("/api/send-code", async (req, res) => {
  const { email, name } = req.body;
  if (!email || !name) return res.status(400).json({ error: "Email и имя обязательны" });

  const code = generateCode();
  const expires = now() + 10 * 60 * 1000;

  await turso.execute({
    sql: "INSERT OR REPLACE INTO email_codes (email, code, expires, name) VALUES (?, ?, ?, ?)",
    args: [email, code, expires, name],
  });

  try {
    await sendEmail(
      email,
      "Код подтверждения Sashka Messenger",
      `<h2>Ваш код: <strong>${code}</strong></h2><p>Действителен 10 минут</p>`
    );
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка отправки письма" });
  }
});

// 2. Проверить код
app.post("/api/verify", async (req, res) => {
  const { email, code } = req.body;
  const record = await turso.execute({
    sql: "SELECT * FROM email_codes WHERE email = ?",
    args: [email],
  });

  if (record.rows.length === 0) {
    return res.json({ success: false, reason: "code_not_found" });
  }
  const row = record.rows[0];
  if (row.code !== code) return res.json({ success: false, reason: "wrong_code" });
  if (row.expires < now()) return res.json({ success: false, reason: "expired" });

  const userExists = await turso.execute({
    sql: "SELECT * FROM users WHERE email = ?",
    args: [email],
  });

  let name = row.name;
  if (userExists.rows.length === 0) {
    await turso.execute({
      sql: "INSERT INTO users (email, name, peer_id, last_seen, created_at) VALUES (?, ?, ?, ?, ?)",
      args: [email, name, "", now(), now()],
    });
    await sendEmail(
      email,
      "Добро пожаловать в Sashka Messenger!",
      `<h2>Привет, ${name}!</h2><p>Ты успешно зарегистрировался.</p>`
    );
  } else {
    name = userExists.rows[0].name;
  }

  await turso.execute({
    sql: "DELETE FROM email_codes WHERE email = ?",
    args: [email],
  });

  res.json({ success: true, name });
});

// 3. Получить пользователей
app.get("/api/users", async (req, res) => {
  const result = await turso.execute(
    "SELECT email, name, avatar, bio, is_online, last_seen FROM users"
  );
  res.json(result.rows);
});

// 4. Сохранить сообщение
app.post("/api/save-message", async (req, res) => {
  const { id, chatId, fromId, fromName, text, file, time, replyToId } = req.body;
  await turso.execute({
    sql: "INSERT INTO messages (id, chat_id, from_id, from_name, text, file, time, reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    args: [id, chatId, fromId, fromName, text || "", file || "", time || now(), replyToId || ""],
  });
  res.json({ success: true });
});

// 5. История чата
app.post("/api/messages", async (req, res) => {
  const { chatId, limit = 1000 } = req.body;
  const result = await turso.execute({
    sql: "SELECT * FROM messages WHERE chat_id = ? AND deleted = 0 ORDER BY time ASC LIMIT ?",
    args: [chatId, limit],
  });
  res.json(result.rows);
});

// 6. Уведомление на почту
app.post("/api/notify", async (req, res) => {
  const { toEmail, fromName, type, chatId, messagePreview } = req.body;
  const user = await turso.execute({
    sql: "SELECT is_online FROM users WHERE email = ?",
    args: [toEmail],
  });
  if (user.rows.length === 0) return res.json({ success: false, reason: "user_not_found" });
  const isOnline = user.rows[0].is_online === 1;
  if (isOnline && type === "message") return res.json({ success: true, delivered: "p2p" });

  const siteUrl = Deno.env.get("SITE_URL") || "https://ваш-сайт.com";
  const acceptUrl = `${siteUrl}?action=accept_call&from=${encodeURIComponent(fromName)}&chatId=${chatId}`;
  const rejectUrl = `${siteUrl}?action=reject&from=${encodeURIComponent(fromName)}&chatId=${chatId}`;

  let html = "";
  if (type === "call") {
    html = `
      <h2>📞 Входящий звонок от ${fromName}</h2>
      <a href="${acceptUrl}" style="background:#4CAF50;color:white;padding:10px 20px;text-decoration:none;border-radius:8px;margin-right:10px;">✅ Принять</a>
      <a href="${rejectUrl}" style="background:#f44336;color:white;padding:10px 20px;text-decoration:none;border-radius:8px;">❌ Отклонить</a>
    `;
  } else {
    html = `
      <h2>💬 Сообщение от ${fromName}</h2>
      <p>${escapeHtml(messagePreview || "")}</p>
      <a href="${siteUrl}" style="background:#5b9bd5;color:white;padding:10px 20px;text-decoration:none;border-radius:8px;">📱 Перейти в чат</a>
    `;
  }
  try {
    await sendEmail(toEmail, type === "call" ? `📞 Звонок от ${fromName}` : `💬 Сообщение от ${fromName}`, html);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка отправки письма" });
  }
});

// 7. Блокировка звонков
app.post("/api/set-block", async (req, res) => {
  const { email, blockedFrom, durationMinutes } = req.body;
  const blockedUntil = now() + durationMinutes * 60 * 1000;
  const user = await turso.execute({
    sql: "SELECT blocked FROM users WHERE email = ?",
    args: [email],
  });
  let blocked = {};
  if (user.rows.length > 0 && user.rows[0].blocked) {
    try { blocked = JSON.parse(user.rows[0].blocked); } catch {}
  }
  blocked[blockedFrom] = blockedUntil;
  await turso.execute({
    sql: "UPDATE users SET blocked = ? WHERE email = ?",
    args: [JSON.stringify(blocked), email],
  });
  res.json({ success: true });
});

// 8. Проверка блокировки
app.post("/api/is-blocked", async (req, res) => {
  const { email, fromName } = req.body;
  const user = await turso.execute({
    sql: "SELECT blocked FROM users WHERE email = ?",
    args: [email],
  });
  let blocked = {};
  if (user.rows.length > 0 && user.rows[0].blocked) {
    try { blocked = JSON.parse(user.rows[0].blocked); } catch {}
  }
  const until = blocked[fromName] || 0;
  res.json({ blocked: until > now(), until });
});

// 9. Статус
app.get("/api/status", (req, res) => {
  res.json({ status: "ok", time: now() });
});

// ---------- Запуск ----------
const PORT = 8000;
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
