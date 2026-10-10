# HANDOFF: FormPulse

Built 2026-10-10 from Session 4.1, Challenge 2 (form reaches 50 / 100 / 200 submissions, notify on Slack).

## State
- Node 24 server, built-in SQLite, no dependencies. Files: `server.js`, `public/`, `test/run-tests.js`.
- Default port 3100 (3000 is the LeadIQ app).
- 20/20 automated tests pass against a mock Slack.
- Dashboard verified in the in-app browser (demo submissions, pending milestone state, Connect tab).
- Generated Apps Script passes a syntax check.

## NOT verified (needs Jii)
- Real Slack delivery: needs an Incoming Webhook URL.
- Real Google Form: needs the Apps Script pasted into the form and a public URL for the server.

## Decisions
- Apps Script push instead of Forms API polling: no OAuth app needed.
- Webhook is protected by a generated secret; dashboard has optional `DASHBOARD_PASSWORD`.
- Backfill of an existing form with 50+ responses fires the matching alerts immediately.

## Next
- Deploy (Render/Railway) and set `DASHBOARD_PASSWORD`.
- Paste Slack webhook, paste Apps Script, submit the form once, confirm the total moves.

## Update 2026-10-10 (end to end verified)
- Real Slack: webhook connected to #sales-hot-leads, test message and a demo 50 alert delivered once.
- Real Google Form: "FormPulse Test Form" (id 1zvMvMhXtCIj3B9b_O52dcdUj7vrylqtR2Ro4fKFALnA) with a standalone Apps Script project (setup run, onFormSubmit trigger installed). One real submission arrived on the dashboard: total 1.
- Running via cloudflared quick tunnel (tools/cloudflared.exe, not in git). Address changes on restart, so the Apps Script WEBHOOK_URL must be updated then. Dashboard password is in .dashboard-password.txt (not in git).
- Render was set up (render.yaml, repo singhaarohi-cmyk/formpulse) but not deployed: needs a card on file (Starter plan + disk).
- Next: deploy permanently, point the real form's script at the permanent URL, unpublish or delete the test form.
