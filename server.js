'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const MESSAGE_TTL = 30 * 60 * 1000; // 30 minutes
const SESSION_HOURS = 12;

// ---------- Config check ----------
const required = [
  'USER1_NAME', 'USER1_PASSWORD',
  'USER2_NAME', 'USER2_PASSWORD',
  'JWT_SECRET'
];
for (const key of required) {
  if (!process.env[key]) {
    console.error('Missing environment variable: ' + key);
    process.exit(1);
  }
}
const JWT_SECRET = process.env.JWT_SECRET;
if (JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must be at least 32 characters');
  process.exit(1);
}

// ---------- The two users only ----------
const users = [1, 2].map((i) => {
  const name = process.env['USER' + i + '_NAME'].trim();
  const pass = process.env['USER' + i + '_PASSWORD'];
  if (!name || name.length > 32) {
    console.error('Invalid name for USER' + i);
    process.exit(1);
  }
  if (pass.length < 10) {
    console.error('Password of USER' + i + ' must be at least 10 characters');
    process.exit(1);
  }
  const user = { name, key: name.toLowerCase(), hash: bcrypt.hashSync(pass, 12) };
  delete process.env['USER' + i + '_PASSWORD']; // remove plain password from memory
  return user;
});
if (users[0].key === users[1].key) {
  console.error('The two usernames must be different');
  process.exit(1);
}
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12);

// ---------- Helpers ----------
function verifyToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    const user = users.find((u) => u.name === payload.u);
    return user ? user.name : null;
  } catch (e) {
    return null;
  }
}

// ---------- App ----------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'"],
  imgSrc: ["'self'", 'data:'],
  connectSrc: ["'self'", 'ws:', 'wss:'],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"]
};
if (!IS_PROD) cspDirectives.upgradeInsecureRequests = null;

app.use(helmet({ contentSecurityPolicy: { directives: cspDirectives } }));
app.use(express.json({ limit: '2kb' }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'محاولات كثيرة، حاول لاحقاً بعد 15 دقيقة' }
});

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (
    typeof username !== 'string' || typeof password !== 'string' ||
    username.length > 64 || password.length > 128
  ) {
    return res.status(400).json({ error: 'بيانات غير صالحة' });
  }
  const user = users.find((u) => u.key === username.trim().toLowerCase());
  const ok = await bcrypt.compare(password, user ? user.hash : DUMMY_HASH);
  if (!user || !ok) {
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }
  const token = jwt.sign({ u: user.name }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: SESSION_HOURS + 'h'
  });
  res.cookie('token', token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'strict',
    maxAge: SESSION_HOURS * 60 * 60 * 1000,
    path: '/'
  });
  res.json({ username: user.name });
});

app.get('/api/me', (req, res) => {
  const cookies = cookie.parse(req.headers.cookie || '');
  const name = verifyToken(cookies.token);
  if (!name) return res.status(401).json({ error: 'غير مسجل' });
  res.json({ username: name });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token', { path: '/' });
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  res.status(400).json({ error: 'طلب غير صالح' });
});

// ---------- Socket.IO ----------
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 4 * 1024,
  allowRequest: (req, cb) => {
    const origin = req.headers.origin;
    if (!origin) return cb(null, true);
    try {
      cb(null, new URL(origin).host === req.headers.host);
    } catch (e) {
      cb(null, false);
    }
  }
});

io.use((socket, next) => {
  const cookies = cookie.parse(socket.request.headers.cookie || '');
  const name = verifyToken(cookies.token);
  if (!name) return next(new Error('unauthorized'));
  socket.user = name;
  next();
});

let messages = []; // kept in memory only

io.on('connection', (socket) => {
  socket.join('chat');

  const now = Date.now();
  socket.emit('history', {
    ttl: MESSAGE_TTL,
    messages: messages.filter((m) => m.ts + MESSAGE_TTL > now)
  });

  let recent = [];
  socket.on('message', (text) => {
    if (typeof text !== 'string') return;
    text = text.trim();
    if (!text || text.length > 1000) return;

    const t = Date.now();
    recent = recent.filter((x) => t - x < 5000);
    if (recent.length >= 5) return; // max 5 messages per 5 seconds
    recent.push(t);

    const msg = {
      id: crypto.randomUUID(),
      from: socket.user,
      text,
      ts: t
    };
    messages.push(msg);
    io.to('chat').emit('message', msg);
  });
});

// ---------- Delete messages older than 30 minutes ----------
setInterval(() => {
  const now = Date.now();
  const expired = messages.filter((m) => m.ts + MESSAGE_TTL <= now).map((m) => m.id);
  if (expired.length) {
    messages = messages.filter((m) => m.ts + MESSAGE_TTL > now);
    io.to('chat').emit('expired', expired);
  }
}, 10 * 1000);

server.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
