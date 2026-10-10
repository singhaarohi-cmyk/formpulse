# FormPulse

Tracks Google Form submissions, shows them on a dashboard, and sends a Slack alert at 50, 100 and 200 submissions. Each alert is sent once.

## Run it

Needs Node 22.13 or newer (no `npm install`).

```
node server.js
```

Open http://localhost:3100.

## How "only once" works

Every submission is stored under its Google response ID, so a repeated or replayed submission is ignored. Each milestone is a row keyed by its number (50, 100, 200). Only the request that flips that row from `pending` to `sending` may call Slack, so parallel requests, retries and restarts cannot send it twice. If Slack fails, the milestone is marked `failed` and retried every minute until it succeeds. The one theoretical gap is a crash in the milliseconds between Slack accepting a message and the database saving that fact; on restart it would retry.

## Connect Slack

1. Go to api.slack.com/apps, create an app, turn on Incoming Webhooks, add a webhook to the channel you want.
2. Paste the URL on the Connect tab, click Save, then "Send test message".

## Connect Google Forms

The Connect tab generates a ready-made Google Apps Script with your URL and secret filled in. Paste it into the form's Apps Script editor, run `setup` once, and optionally `syncAll` to import old responses. Google needs a public address to reach FormPulse, so the dashboard must be deployed (or tunnelled) first.

## Deploy

Any host that runs Node and keeps a disk works (Render, Railway, Fly.io, a small VPS). Set `DASHBOARD_PASSWORD` so strangers cannot open the dashboard (username can be anything). Keep the `data/` folder on persistent storage.

Environment variables: `PORT`, `DB_PATH`, `DASHBOARD_PASSWORD`, `SLACK_WEBHOOK_URL`, `WEBHOOK_SECRET`.

## Tests

```
node test/run-tests.js
```

Starts the real server with a mock Slack and checks thresholds, duplicates, 30 parallel requests across a boundary, restarts, Slack failure and recovery, and bad secrets.
