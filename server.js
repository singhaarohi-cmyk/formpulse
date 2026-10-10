'use strict';
// FormPulse: tracks Google Form submissions, sends each Slack milestone alert exactly once.
// Zero dependencies. Needs Node 22.13+ (uses the built-in node:sqlite).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3100);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'formpulse.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MILESTONES = [50, 100, 200];
const SLACK_PREFIX = 'https://hooks.slack.com/';
const ALLOW_ANY_SLACK_URL = process.env.ALLOW_ANY_SLACK_URL === '1'; // tests only

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    response_id TEXT NOT NULL UNIQUE,
    submitted_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'google'
  );
  CREATE TABLE IF NOT EXISTS milestones (
    threshold INTEGER PRIMARY KEY,
    status TEXT NOT NULL,
    reached_count INTEGER NOT NULL,
    reached_at TEXT NOT NULL,
    notified_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    threshold INTEGER NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
// milestones.status: pending | sending | sent | failed
// notifications.status: sent | failed

const now = () => new Date().toISOString();
const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;
const setSetting = (k, v) =>
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);

if (!getSetting('webhook_secret')) setSetting('webhook_secret', crypto.randomBytes(18).toString('hex'));
const secret = () => process.env.WEBHOOK_SECRET || getSetting('webhook_secret');
const slackUrl = () => process.env.SLACK_WEBHOOK_URL || getSetting('slack_webhook_url') || '';
const formName = () => getSetting('form_name') || 'Your Google Form';

// A crash mid-send leaves a milestone in 'sending'. Mark it failed so it is retried.
db.prepare("UPDATE milestones SET status='failed', last_error='Interrupted, will retry' WHERE status='sending'").run();

const count = () => db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n;

function ingest(responseIds, source = 'google', timestamps = {}) {
  let added = 0;
  const ins = db.prepare('INSERT OR IGNORE INTO submissions(response_id, submitted_at, received_at, source) VALUES(?,?,?,?)');
  db.exec('BEGIN');
  try {
    for (const id of responseIds) {
      const raw = timestamps[id];
      const ts = raw && !Number.isNaN(Date.parse(raw)) ? new Date(raw).toISOString() : now();
      added += Number(ins.run(String(id), ts, now(), source).changes);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return added;
}

function slackPayload(threshold, total) {
  const text = `🎉 ${formName()} just hit ${threshold} submissions (current total: ${total}).`;
  return {
    text,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `🎉 ${threshold} submissions reached`, emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: `*${formName()}* just crossed the *${threshold}* submission milestone.\nCurrent total: *${total}*` } },
    ],
  };
}

async function postToSlack(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Slack returned ${res.status}: ${body.slice(0, 200)}`);
}

// Records every milestone the count has reached, then sends any that are unsent.
// Exactly once: the milestone row is keyed by threshold, and only the caller whose
// UPDATE flips pending/failed -> sending (changes === 1) is allowed to send.
// Runs are also serialized through a promise chain.
let processing = Promise.resolve();
function processMilestones() {
  processing = processing.then(runMilestones).catch((e) => console.error('milestone error', e));
  return processing;
}
async function runMilestones() {
  const total = count();
  for (const t of MILESTONES) {
    if (total >= t) {
      db.prepare("INSERT OR IGNORE INTO milestones(threshold,status,reached_count,reached_at) VALUES(?, 'pending', ?, ?)").run(t, total, now());
    }
  }
  const url = slackUrl();
  if (!url) return;
  for (const t of MILESTONES) {
    const claimed = db.prepare("UPDATE milestones SET status='sending', attempts=attempts+1 WHERE threshold=? AND status IN ('pending','failed')").run(t);
    if (Number(claimed.changes) !== 1) continue;
    const payload = slackPayload(t, count());
    try {
      await postToSlack(url, payload);
      db.prepare("UPDATE milestones SET status='sent', notified_at=?, last_error=NULL WHERE threshold=?").run(now(), t);
      db.prepare("INSERT INTO notifications(threshold,status,message,created_at) VALUES(?, 'sent', ?, ?)").run(t, payload.text, now());
    } catch (e) {
      db.prepare("UPDATE milestones SET status='failed', last_error=? WHERE threshold=?").run(e.message, t);
      db.prepare("INSERT INTO notifications(threshold,status,message,error,created_at) VALUES(?, 'failed', ?, ?, ?)").run(t, payload.text, e.message, now());
    }
  }
}

function stats() {
  const total = count();
  const rows = Object.fromEntries(db.prepare('SELECT * FROM milestones').all().map((r) => [r.threshold, r]));
  const milestones = MILESTONES.map((t) => {
    const r = rows[t];
    return {
      threshold: t,
      progress: Math.min(100, Math.round((total / t) * 100)),
      remaining: Math.max(0, t - total),
      status: r ? r.status : 'upcoming',
      reachedAt: r?.reached_at ?? null,
      notifiedAt: r?.notified_at ?? null,
      attempts: r?.attempts ?? 0,
      lastError: r?.last_error ?? null,
    };
  });
  const next = MILESTONES.find((t) => total < t) ?? null;
  const last24h = db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE submitted_at >= ?').get(new Date(Date.now() - 864e5).toISOString()).n;
  const daily = db.prepare('SELECT substr(submitted_at,1,10) AS day, COUNT(*) AS n FROM submissions GROUP BY day ORDER BY day DESC LIMIT 14').all().reverse();
  const history = db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 50').all();
  const recent = db.prepare('SELECT response_id, submitted_at, source FROM submissions ORDER BY id DESC LIMIT 8').all();
  const u = slackUrl();
  return {
    total, last24h, next, milestones, daily, history, recent,
    config: {
      formName: formName(),
      slackConfigured: Boolean(u),
      slackHint: u ? u.slice(0, 28) + '...' + u.slice(-4) : '',
    },
  };
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 2e6) { reject(new Error('Body too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); } });
});
const safeEq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    // Optional password for the dashboard. The Google webhook uses its own secret instead.
    const pw = process.env.DASHBOARD_PASSWORD;
    if (pw && url.pathname !== '/api/webhook') {
      const given = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString().split(':').slice(1).join(':');
      if (!safeEq(given, pw)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="FormPulse"' });
        return res.end('Password required');
      }
    }
    if (url.pathname === '/api/stats' && req.method === 'GET') return json(res, 200, stats());

    // Google Forms (Apps Script) calls this on every submission, and once to backfill.
    if (url.pathname === '/api/webhook' && req.method === 'POST') {
      const b = await readBody(req);
      if (!safeEq(b.secret ?? '', secret())) return json(res, 401, { error: 'Bad secret' });
      const ids = Array.isArray(b.responseIds) ? b.responseIds : b.responseId ? [b.responseId] : [];
      if (!ids.length) return json(res, 400, { error: 'responseId or responseIds required' });
      if (b.formName) setSetting('form_name', String(b.formName).slice(0, 120));
      const added = ingest(ids, 'google', b.timestamps || {});
      await processMilestones();
      return json(res, 200, { added, duplicates: ids.length - added, total: count() });
    }

    if (url.pathname === '/api/settings' && req.method === 'GET') {
      return json(res, 200, { secret: secret() });
    }
    if (url.pathname === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req);
      if (typeof b.formName === 'string' && b.formName.trim()) setSetting('form_name', b.formName.trim().slice(0, 120));
      if (typeof b.slackWebhookUrl === 'string') {
        const v = b.slackWebhookUrl.trim();
        if (v && !ALLOW_ANY_SLACK_URL && !v.startsWith(SLACK_PREFIX)) {
          return json(res, 400, { error: `Slack webhook URL must start with ${SLACK_PREFIX}` });
        }
        setSetting('slack_webhook_url', v);
        await processMilestones(); // send anything that was waiting for Slack
      }
      return json(res, 200, stats());
    }
    if (url.pathname === '/api/slack/test' && req.method === 'POST') {
      if (!slackUrl()) return json(res, 400, { error: 'Add a Slack webhook URL first.' });
      try {
        await postToSlack(slackUrl(), { text: `✅ FormPulse is connected to Slack for "${formName()}". (Test message, not a milestone.)` });
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }
    if (url.pathname === '/api/retry' && req.method === 'POST') {
      await processMilestones();
      return json(res, 200, stats());
    }
    // Demo helpers so the dashboard can be tried without a real form.
    if (url.pathname === '/api/demo/add' && req.method === 'POST') {
      const b = await readBody(req);
      const n = Math.max(1, Math.min(250, Number(b.count) || 1));
      ingest(Array.from({ length: n }, () => 'demo-' + crypto.randomUUID()), 'demo');
      await processMilestones();
      return json(res, 200, stats());
    }
    if (url.pathname === '/api/demo/reset' && req.method === 'POST') {
      db.exec("DELETE FROM submissions WHERE source='demo'");
      if (count() === 0) db.exec('DELETE FROM milestones; DELETE FROM notifications;');
      return json(res, 200, stats());
    }

    if (req.method === 'GET') {
      const file = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
      if (file.startsWith(PUBLIC_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        return res.end(fs.readFileSync(file));
      }
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: e.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`FormPulse running at http://localhost:${PORT}`));
  setInterval(() => processMilestones(), 60000).unref(); // retries failed Slack sends
}
module.exports = { server, db };
