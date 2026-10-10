'use strict';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const post = async (p, body) => {
  const r = await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
};
const fmt = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const LABEL = { upcoming: 'Upcoming', pending: 'Waiting to send', sending: 'Sending', sent: 'Notified', failed: 'Failed, retrying' };

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

function render(s) {
  $('#total').textContent = s.total.toLocaleString();
  $('#formName').textContent = s.config.formName;
  $('#chip24').textContent = `${s.last24h} in the last 24h`;
  $('#chipNext').textContent = s.next ? `Next milestone: ${s.next} (${s.next - s.total} to go)` : 'All milestones reached';
  $('#setupBanner').hidden = s.config.slackConfigured;

  const max = Math.max(1, ...s.daily.map((d) => d.n));
  $('#bars').innerHTML = s.daily.length
    ? s.daily.map((d) => `<div class="bar" style="height:${Math.max(4, (d.n / max) * 100)}%" data-tip="${esc(d.day)}: ${d.n}"></div>`).join('')
    : '<div class="empty-bars">No submissions yet</div>';

  $('#milestones').innerHTML = s.milestones.map((m) => {
    const done = m.status === 'sent';
    const foot = done ? `Slack alert sent ${fmt(m.notifiedAt)}`
      : m.status === 'failed' ? `<span class="err">${esc(m.lastError)}</span>`
      : m.status === 'pending' ? 'Reached. Connect Slack to send the alert.'
      : `${m.remaining} more to go`;
    return `<div class="card ms ${done ? 'done' : ''}">
      <div class="ms-top"><div class="ms-n">${m.threshold}<small>submissions</small></div><span class="badge b-${m.status}">${LABEL[m.status]}</span></div>
      <div class="progress"><i style="width:${m.progress}%"></i></div>
      <div class="ms-foot">${m.progress}% &middot; ${foot}</div>
    </div>`;
  }).join('');

  $('#history').innerHTML = s.history.length
    ? s.history.map((h) => `<div class="item"><div><div class="t">${h.status === 'sent' ? 'Sent' : 'Failed'}: ${h.threshold} submissions</div>
        <div class="s">${esc(h.message)}</div>${h.error ? `<div class="err">${esc(h.error)}</div>` : ''}</div>
        <div><span class="badge b-${h.status}">${h.status === 'sent' ? 'Delivered' : 'Failed'}</span><div class="s" style="text-align:right;margin-top:4px">${fmt(h.created_at)}</div></div></div>`).join('')
    : '<div class="empty">No notifications yet. Alerts appear here at 50, 100 and 200 submissions.</div>';

  $('#recent').innerHTML = s.recent.length
    ? s.recent.map((r) => `<div class="item"><div><div class="t">${r.source === 'demo' ? 'Demo submission' : 'Form submission'}</div><div class="s">${esc(r.response_id.slice(0, 18))}</div></div><div class="s">${fmt(r.submitted_at)}</div></div>`).join('')
    : '<div class="empty">Waiting for the first submission.</div>';

  $('#slackCurrent').textContent = s.config.slackConfigured ? `Connected: ${s.config.slackHint}` : 'Not connected yet.';
  if (document.activeElement !== $('#inFormName') && !$('#inFormName').value) $('#inFormName').value = s.config.formName === 'Your Google Form' ? '' : s.config.formName;
}

let failures = 0;
async function refresh() {
  try {
    const s = await (await fetch('/api/stats')).json();
    render(s); failures = 0;
    $('#liveText').textContent = 'Live'; document.querySelector('.dot').classList.remove('off');
  } catch {
    if (++failures > 1) { $('#liveText').textContent = 'Offline'; document.querySelector('.dot').classList.add('off'); }
  }
}

function show(view) {
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== 'view-' + view));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  if (view === 'connect') buildScript();
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => show(t.dataset.view)));
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => show(b.dataset.goto)));

document.querySelectorAll('[data-demo]').forEach((b) => b.addEventListener('click', async () => {
  b.disabled = true;
  try { render(await post('/api/demo/add', { count: Number(b.dataset.demo) })); } catch (e) { toast(e.message); }
  b.disabled = false;
}));
$('#demoReset').addEventListener('click', async () => {
  if (!confirm('Remove all demo submissions? Real form data is kept.')) return;
  render(await post('/api/demo/reset'));
});

$('#saveSlack').addEventListener('click', async () => {
  const msg = $('#slackMsg'); msg.className = 'msg'; msg.textContent = '';
  try {
    const body = { formName: $('#inFormName').value };
    if ($('#inSlack').value.trim()) body.slackWebhookUrl = $('#inSlack').value;
    render(await post('/api/settings', body));
    $('#inSlack').value = '';
    msg.className = 'msg ok'; msg.textContent = 'Saved';
  } catch (e) { msg.className = 'msg bad'; msg.textContent = e.message; }
});
$('#testSlack').addEventListener('click', async () => {
  const msg = $('#slackMsg'); const b = $('#testSlack'); b.disabled = true;
  try { await post('/api/slack/test'); msg.className = 'msg ok'; msg.textContent = 'Test message sent. Check Slack.'; }
  catch (e) { msg.className = 'msg bad'; msg.textContent = e.message; }
  b.disabled = false;
});

async function buildScript() {
  const { secret } = await (await fetch('/api/settings')).json();
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  $('#localWarn').hidden = !local;
  const code = `const WEBHOOK_URL = '${location.origin}/api/webhook';
const SECRET = '${secret}';

function send_(payload) {
  payload.secret = SECRET;
  UrlFetchApp.fetch(WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
}

// Runs automatically on every new submission.
function onFormSubmit(e) {
  const r = e.response;
  const ts = {}; ts[r.getId()] = r.getTimestamp().toISOString();
  send_({ formName: FormApp.getActiveForm().getTitle(), responseId: r.getId(), timestamps: ts });
}

// Run once: connects the form so submissions are sent to FormPulse.
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('onFormSubmit').forForm(FormApp.getActiveForm()).onFormSubmit().create();
}

// Optional: imports responses that already exist. Safe to run many times.
function syncAll() {
  const all = FormApp.getActiveForm().getResponses();
  for (let i = 0; i < all.length; i += 100) {
    const chunk = all.slice(i, i + 100);
    const ts = {};
    chunk.forEach(function (r) { ts[r.getId()] = r.getTimestamp().toISOString(); });
    send_({ formName: FormApp.getActiveForm().getTitle(), responseIds: chunk.map(function (r) { return r.getId(); }), timestamps: ts });
  }
}`;
  $('#script').textContent = code;
}
$('#copyScript').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#script').textContent); toast('Script copied'); } catch { toast('Select the code and copy it manually'); }
});

refresh();
setInterval(refresh, 4000);
