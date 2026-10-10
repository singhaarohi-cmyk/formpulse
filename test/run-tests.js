'use strict';
// End-to-end tests. Starts the real server against a temp DB and a mock Slack server.
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SECRET = 'test-secret';
let passed = 0, failed = 0;
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log('  PASS', name); }
  else { failed++; console.log('  FAIL', name, extra); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- mock Slack ----
let slackMode = 'ok';
let slackMessages = [];
const slack = http.createServer((req, res) => {
  let d = '';
  req.on('data', (c) => (d += c));
  req.on('end', () => {
    if (slackMode === 'fail') { res.writeHead(500); return res.end('server_error'); }
    slackMessages.push(JSON.parse(d));
    res.writeHead(200); res.end('ok');
  });
});

function startApp(port, dbPath, extraEnv = {}) {
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: port, DB_PATH: dbPath, WEBHOOK_SECRET: SECRET, ALLOW_ANY_SLACK_URL: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve) => p.stdout.on('data', (b) => String(b).includes('running') && resolve(p)));
}
const api = async (port, method, p, body) => {
  const r = await fetch(`http://localhost:${port}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
};
const hook = (port, ids) => api(port, 'POST', '/api/webhook', { secret: SECRET, responseIds: ids });
const ids = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);
const thresholdsSent = () => slackMessages.map((m) => /hit (\d+)/.exec(m.text)?.[1]).filter(Boolean).map(Number);

(async () => {
  await new Promise((r) => slack.listen(0, r));
  const slackUrl = `http://localhost:${slack.address().port}/hook`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'formpulse-'));
  const dbPath = path.join(dir, 't.db');
  const port = 3911;
  let app = await startApp(port, dbPath);

  console.log('Security and validation');
  check('bad secret rejected with 401', (await api(port, 'POST', '/api/webhook', { secret: 'nope', responseId: 'x' })).status === 401);
  check('empty payload rejected with 400', (await api(port, 'POST', '/api/webhook', { secret: SECRET })).status === 400);
  const strict = await startApp(3913, path.join(dir, 't3.db'), { ALLOW_ANY_SLACK_URL: '0' });
  const bad = await api(3913, 'POST', '/api/settings', { slackWebhookUrl: 'https://evil.example.com/x' });
  check('non-Slack webhook URL rejected', bad.status === 400);
  strict.kill();

  console.log('Milestones when Slack is NOT yet configured');
  await hook(port, ids('a', 1, 55));
  let s = (await api(port, 'GET', '/api/stats')).data;
  check('total is 55', s.total === 55);
  check('50 milestone is pending, nothing sent', s.milestones[0].status === 'pending' && slackMessages.length === 0);
  check('100 and 200 are upcoming', s.milestones[1].status === 'upcoming' && s.milestones[2].status === 'upcoming');

  console.log('Connecting Slack sends the waiting alert once');
  await api(port, 'POST', '/api/settings', { slackWebhookUrl: slackUrl, formName: 'Test Form' });
  check('exactly one message (50)', JSON.stringify(thresholdsSent()) === '[50]', JSON.stringify(thresholdsSent()));
  await api(port, 'POST', '/api/retry');
  await api(port, 'POST', '/api/retry');
  check('retry calls do not resend', thresholdsSent().length === 1);

  console.log('Duplicates');
  const dup = await hook(port, ids('a', 1, 55));
  check('same response ids are ignored', dup.data.added === 0 && dup.data.total === 55);

  console.log('Concurrency across the 100 boundary');
  const batches = Array.from({ length: 30 }, (_, i) => hook(port, [`b${i}`, `b${i}-2`]));
  await Promise.all(batches); // 55 + 60 = 115
  await sleep(300);
  check('total is 115', (await api(port, 'GET', '/api/stats')).data.total === 115);
  check('100 sent exactly once', thresholdsSent().filter((t) => t === 100).length === 1, JSON.stringify(thresholdsSent()));
  // same racing requests replayed
  await Promise.all(batches.map((_, i) => hook(port, [`b${i}`, `b${i}-2`])));
  check('replaying all requests sends nothing new', thresholdsSent().length === 2, JSON.stringify(thresholdsSent()));

  console.log('Restart does not resend');
  app.kill(); await sleep(400);
  app = await startApp(port, dbPath);
  await api(port, 'POST', '/api/retry');
  check('still 2 messages after restart', thresholdsSent().length === 2);

  console.log('Slack failure then recovery');
  slackMode = 'fail';
  await hook(port, ids('c', 1, 90)); // 205 total, crosses 200
  s = (await api(port, 'GET', '/api/stats')).data;
  check('200 is marked failed', s.milestones[2].status === 'failed' && /500/.test(s.milestones[2].lastError || ''));
  check('failed attempt is in history', s.history.some((h) => h.threshold === 200 && h.status === 'failed'));
  slackMode = 'ok';
  await api(port, 'POST', '/api/retry');
  await api(port, 'POST', '/api/retry');
  s = (await api(port, 'GET', '/api/stats')).data;
  check('200 delivered once after recovery', thresholdsSent().filter((t) => t === 200).length === 1);
  check('all three milestones sent', s.milestones.every((m) => m.status === 'sent'));
  check('no further milestones', s.next === null);

  console.log('Big jump past all thresholds on a fresh DB');
  const dbPath2 = path.join(dir, 't2.db');
  const before = slackMessages.length;
  const app2 = await startApp(3912, dbPath2, { SLACK_WEBHOOK_URL: slackUrl });
  await hook(3912, ids('z', 1, 210));
  const sent2 = thresholdsSent().slice(before);
  check('50, 100, 200 each sent once', JSON.stringify(sent2.sort((a, b) => a - b)) === '[50,100,200]', JSON.stringify(sent2));
  app2.kill();

  console.log('Message content');
  check('message names the form and threshold', slackMessages.some((m) => /Test Form just hit 50 submissions/.test(m.text)));

  app.kill(); slack.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
