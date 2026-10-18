# TeamDynamix Notifier

> Chrome extension that watches a TeamDynamix (TDX) ticket queue and sounds a continuous alarm when tickets are added or changed — so work in another tab never sits on an incoming ticket.

![Manifest V3](https://img.shields.io/badge/manifest-v3-blue)
![Version](https://img.shields.io/badge/version-1.2.8-brightgreen)

> [!IMPORTANT]
> **Redacted for public release.** This repository is a sanitized copy of an extension built for an internal TeamDynamix instance. Instance-specific values (the TDX hostname, responsible-group IDs and names, and internal status IDs) have been replaced with placeholders, so **it will not work until you configure it** for your own TDX instance:
>
> | What | Where | Placeholder |
> |---|---|---|
> | TDX hostname | `groups.js` → `ALLOWED_HOST`; `manifest.json` → `host_permissions`; `background.js` → hostname check in `fetchAndScan` | `your-tdx-host.example.edu` |
> | Responsible groups (ID → name) | `groups.js` → `GROUPS` | `100001: "Example Group A"`, etc. |
> | Inactive status IDs (Resolved / Closed / Cancelled) | `background.js` → `EXCLUDED_STATUS_IDS` | `0, 0, 0` |
>
> To find your real values: open your TDX dashboard, filter a ticket widget by the groups you want and exclude inactive statuses, then in DevTools → Network → `Results` → **Payload** → `filters`, copy the group IDs (`ResponsibleGroupName` argument) and status IDs (`StatusName` argument). Only configure queues you are authorized to monitor, and follow your organization's approval process. Do **not** commit your real values to a public repo — keep them in a private fork or local copy.

## The problem

TeamDynamix has no audible notifications. Nothing alerts you when a new ticket arrives or an existing ticket changes — the only way to know is to be looking at the queue at that moment.

## What it does

- Once per interval (default 1 minute), fetches the current ticket queue **data** directly from the same endpoint the TDX dashboard uses, over your existing login.
- Compares against the previous check: a **new ticket ID**, or a change to an existing ticket's returned **status/modified-time fingerprint**, triggers the alarm.
- The alarm loops until you explicitly click **Silence** — one missed beep never equals a missed ticket.
- If monitoring degrades — checks repeatedly fail (expired login, network problems), or the active queue exceeds the monitored limit — the extension sounds the alarm with a distinct "monitoring problem" state and an orange badge, so a broken or incomplete monitor can't be mistaken for a quiet queue. It clears automatically when full checks recover; Silence mutes the audio without erasing the failure history, and the popup stays visibly amber until a complete check succeeds.
- Works with the TDX tab **in the background** — detection is data-based, not screen-based, so it doesn't depend on the page being visible.
- Detection is a pure data fetch and never interacts with the TDX page. The on-screen dashboard grid is kept current by TDX's own viewer (its widgets refresh on a timer while focused, and catch up when you return to the tab); detection works regardless of what the page displays. If a widget's own auto-refresh is turned off, enable it to keep the visible grid current.
- Toolbar icon: red = idle, green = watching, green + red `!` = ticket alarm active, green + orange `!` = monitoring problem (failed checks or queue over the monitored limit).

## Privacy & security

One direct GET request per check, to your organization's TDX host only, requesting exactly three fields per ticket (ID, status, modified date) with inactive tickets filtered out by the server. The extension does not interact with the page, so it originates no other requests (the watched TDX page may still issue its own, e.g. its widgets' auto-refresh). The extension does not read, store, or manage cookies or authentication tokens; it initiates a same-origin TDX request, and the browser attaches your existing session to it. Nothing sent anywhere else — no analytics, no third parties. The request asks the browser not to cache the response (`cache: "no-store"`). The last snapshot (those three fields) is held in session-only storage: replaced at each successful check and cleared on stop, browser close, or uninstall. Updating from a version older than 1.2.0 removes any operational data those versions kept on disk. Only user settings persist between browser sessions. Locked to a single configured TDX host by manifest host permissions and re-validated in code on every cycle. Full details and independent verification steps: [PRIVACY.md](./PRIVACY.md) and [TECHNICAL_DESIGN.md](./TECHNICAL_DESIGN.md).

## Install (unpacked)

1. Clone or download this repository.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked**, select this folder (the one containing `manifest.json`).
4. Pin the extension from the toolbar puzzle-piece menu.

## Usage

1. Open your TDX dashboard tab (logged in).
2. Click the extension icon → set the interval → **Watch This Tab**.
3. The first check silently records a baseline — existing tickets do not alarm.
4. On any new or changed ticket: looping chime + red `!` badge until you click **Silence Alarm**.
5. **Stop Watching** or closing the tab fully deactivates it.

## Configuration

- **Groups:** pick which responsible groups to watch from the checklist in the popup. Only groups listed in the approved `GROUPS` table can be selected; the extension cannot watch any other queue, and there is no free-entry group field. Changes apply when you start watching.
- **Inactive tickets (Resolved, Closed, Cancelled) are filtered out by the server** — they never even cross the wire, with a client-side name check as backup. When such a ticket is reopened, its status becomes active and it re-enters as a new ticket — which *does* alarm.
- **Interval:** 1–60 minutes (default 1). **Sound:** five selectable alarm tones with a volume slider and test button; volume 0 is silent mode (visual-only alerts). Saved immediately.
- The known-groups table lives in `GROUPS` in `groups.js`, a shared config file loaded by both the service worker and the popup; update it there (one place) if your groups change.

## Known limitations

- Modified timestamps resolve to the minute; two actions on one ticket in the same minute register once.
- Your own actions on tickets also trigger the alarm (intentional — it alarms on any change to a ticket's returned status/modified-time fingerprint, whoever caused it).
- Requires an open, logged-in TDX tab; expired sessions show as failed checks in the popup until you log back in.
- Watches up to 200 active tickets per check (generous, since inactive tickets are server-filtered). If the active queue ever exceeds that, the extension treats it as a monitoring problem and **pauses comparisons**: it sounds the alarm, shows the orange badge, states in the popup that some tickets are NOT monitored, and keeps the last complete snapshot instead of trusting a partial page — comparisons resume automatically once the queue is back under the limit. A green icon never means "incomplete but fine."

## Disclaimer

Developed by Garrett Riley. Not affiliated with or endorsed by TeamDynamix, Inc. Use within the bounds of your organization's IT and acceptable-use policies.

## Author

**Garrett Riley** — [github.com/garrett-riley](https://github.com/garrett-riley)
