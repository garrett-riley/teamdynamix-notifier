# TDX Notifier — Technical Design Document

**Version:** 1.2.8 · **Platform:** Chrome (Manifest V3) · **Watched host:** `your-tdx-host.example.edu` — placeholder (TeamDynamix / TDWorkManagement)

---

## 1. Plain-Language Overview

*This section requires no technical background.*

### The problem

TeamDynamix (TDX), the organization's ticketing system, has no sound alerts. Nothing beeps, chimes, or pops up when a new ticket arrives or an existing ticket changes. The only way to know something happened is to be looking at the ticket screen at that moment. For a helpdesk team working in other tabs and applications all day, that means tickets can sit unnoticed long enough to miss response-time targets.

### What the extension does

The extension continuously monitors the ticket queue:

1. **Once per interval** (every 1–60 minutes; default 1), it quietly asks the TDX server: *"What tickets are in my queue right now, and when was each one last touched?"*
2. It **remembers what the answer was last time** and compares.
3. If a **new ticket ID appears**, or an existing ticket's returned **status/modified-time fingerprint changes**, it sounds a continuous alarm — a chime that repeats every few seconds until it is acknowledged with **Silence** (stopping the watcher or closing the watched tab also ends it).
4. The toolbar icon shows the state at a glance: **red circle** = not watching, **green circle** = watching, **green circle with a red `!`** = alarm sounding.

### Key properties

The extension makes **the same data request the TDX page already makes on its own** — once per configured interval (1–60 minutes; default 1), using the person's own login. It cannot see anything the person couldn't already see by looking at their queue. It stores almost nothing (just ticket IDs, statuses, and timestamps from the last successful check, overwritten at the next one), sends **nothing** to any third party, and only works on your organization's TDX site — it refuses to run anywhere else. The alarm deliberately keeps sounding until acknowledged, so one missed beep never equals a missed ticket.

---

## 2. Architecture at a Glance

The extension is seven small files with sharply separated jobs:

| File | Role |
|---|---|
| `manifest.json` | Declares permissions, locks the extension to the single TDX host |
| `groups.js` | Shared configuration — the approved group table (ID → name), watched host, interval bounds, and failure threshold; loaded by both the worker and the popup so there is one source of truth. Ships with placeholder values — see README.md |
| `background.js` | The brain: scheduling, detection, alarm decisions (MV3 service worker) |
| `popup.html` / `popup.js` | The control panel: start/stop, interval, groups, alarm sound & volume, silence, status |
| `offscreen.html` / `offscreen.js` | The speaker: a hidden document that plays the alarm audio |

Data flows in one loop:

```
groups.js  ─── loaded once at startup (host · groups · interval bounds · threshold) ───┐
   │                                                                                  │
   ▼  shared config                                                    shared config  ▼
popup.js                                                                     background.js
(labels group                                                              (builds Results
 checkboxes)                                                                 URL, schedules)
                                                                                   │
chrome.alarms (per-interval tick, 1–60 min) ───────────────────────────────────────┘
        │
        ▼
background.js  ──── injects ────►  fetchAndScan()  runs inside the TDX tab
        ▲                                │
        │                                │  same-origin fetch to the
        │                                ▼  Results endpoint
        │                        TDX server (existing session)
        │                                │
        └──── ticketsFound message ◄─────┘
        │
        ▼
diff vs. lastSnapshot in chrome.storage.session
        │
        ▼ (if new/changed)
offscreen.js plays looping alarm · toolbar badge shows "!"
```

*(`groups.js` is loaded once at startup and read by both `background.js` and the popup; it is shared configuration, not part of the per-poll data loop.)*

Two design rules govern everything:

- **Single-host lockdown.** `host_permissions` in the manifest covers exactly one origin, and the code re-validates the tab's URL at every step anyway (defense in depth).
- **No egress.** No request ever leaves the TDX host. No analytics, no telemetry, no third-party services.

---

## 3. Execution Model

The governing constraint: `background.js` is a **Manifest V3 service worker**, and a service worker is *not a continuously running program*. Chrome terminates it after ~30 seconds of inactivity and resurrects it when a registered event fires. Every in-memory variable is lost at each termination.

This constraint dictates three foundational design choices:

### 3.1 Scheduling via `chrome.alarms`

A `setInterval` would die with the worker. `chrome.alarms` lives in the browser itself and *wakes the worker up* on schedule — surviving worker teardown, minimized windows, and background-tab throttling:

```js
chrome.alarms.create(POLL_ALARM, { periodInMinutes: interval });  // 1–60 min
runPoll();   // first check runs immediately as a direct call — Chrome 120+ clamps
             // alarm delays to a 30-second minimum (earlier versions clamp them to a
             // full minute), so a short one-shot alarm can't deliver an instant check
```

### 3.2 State persistence: session storage for state, local storage for settings

Because memory is wiped between events, anything that must survive the worker's sleep — the previous snapshot, the watched tab ID, whether the alarm is active — is persisted to `chrome.storage.session`: memory-backed storage that survives service-worker termination but is cleared when the browser closes, and is accessible only to trusted extension contexts. Only user *settings* (interval, groups, alarm sound, volume) use disk-backed `chrome.storage.local`, so no ticket metadata ever persists past the browser session. Every handler **reads its state back at the start and writes results at the end**, assuming nothing from the previous run:

```js
const DEFAULT_STATE = {
  lastSnapshot:        {},     // { ticketId: "signature", ... } — the previous successful scan's picture
  watchedTabId:        null,
  watchSessionId:      null,   // random per-watch nonce; scanner results must echo it
  ticketAlarmActive:   false,  // red alarm — new/changed tickets; cleared only by Silence
  failureAlarmActive:  false,  // orange alarm — monitoring degraded; auto-clears on recovery
  failureAcknowledged: false,  // Silence pressed during the current degraded condition
  baselineSet:         false,
  lastCheckedAt:       null,   // when the last poll was TRIGGERED (attempt time)
  lastSuccessfulAt:    null,   // when the last fully validated scan COMPLETED
  lastSeenCount:       null,
  lastNewCount:        0,
  lastChangedCount:    0,
  lastScanOk:          null,
  lastTruncated:       false,
  consecutiveFailures: 0,
  alarmNewTotal:       0,
  alarmChangedTotal:   0
};
```

### 3.3 Per-poll validation

```js
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== POLL_ALARM) return;

  chrome.storage.local.get(["settings"], ({ settings }) => {
    chrome.storage.session.get(["watchedTabId", "watchSessionId"], ({ watchedTabId, watchSessionId }) => {
      if (!settings || !watchedTabId || !watchSessionId) return;

    chrome.tabs.get(watchedTabId, (tab) => {
      if (chrome.runtime.lastError || !tab) { stopWatcher(); return; }  // tab closed
      if (!isWatchedHost(tab.url))          { stopWatcher(); return; }  // navigated off TDX

      chrome.storage.session.set({ lastCheckedAt: Date.now() });        // stamp at trigger time
      injectFetchScanner(watchedTabId);
    });
  });
});
```

Line by line:

- **`alarm.name !== POLL_ALARM`** — the extension only reacts to its own named alarm, so future alarms can coexist and cleanup can clear by name rather than `clearAll()`.
- **State is read from storage, not memory** — the worker may have just been resurrected.
- **`chrome.tabs.get` + `isWatchedHost`** — if the watched tab was closed or navigated anywhere off the TDX host, the watcher shuts itself down rather than continuing to run in the wrong place. This runs on *every* poll even though the manifest already restricts the host, because layered checks are cheap and misplaced trust is not.
- **`lastCheckedAt` is stamped at trigger time** — it records when a poll was *attempted*, not that it completed or validated. A separate `lastSuccessfulAt` is stamped only when a scan passes full validation, and the popup's principal status line ("Last successful check Xs ago") is driven by that value, so a string of failed attempts can never masquerade as fresh successful monitoring.

---

## 4. The Detection Pipeline

### 4.1 Why a direct data fetch

Three approaches were evaluated; the failures of the first two explain the final design:

1. **Full tab reload, then read the rendered grid** (the original SolarWinds model). Failed on TDX: the grid is client-rendered by Kendo UI, and TDX **defers that rendering while the tab is hidden**. A background reload loads the page shell, but the ticket rows never paint until the tab is shown.
2. **Click the dashboard's own Refresh button and read the grid after it settles.** Same failure for the same reason — the in-place refresh is also visibility-gated. Works beautifully in the foreground, does nothing in the background.
3. **Fetch the grid's data directly.** The dashboard's refresh fires a request to `.../WorkManagement/Queries/Tickets/Results?...`. The extension makes **that same request itself**. Network requests are **not** visibility-gated, so this works identically whether the tab is focused, buried, or the window is minimized — which is the entire point of the extension.

**The extension does not interact with the page at all.** Detection is a pure data fetch — no page elements are read, and nothing on the page is clicked. Earlier versions additionally clicked the dashboard's own Refresh control each cycle as a cosmetic nicety, to keep the visible grid current for anyone looking at it. That click was removed in v1.2.4 after the current TDX dashboard viewer's own refresh behavior was characterized directly (authenticated DevTools observation, July 2026):

| Watched tab state | TDX dashboard viewer | Effect on the visible grid |
|---|---|---|
| Foreground | Fetches and re-renders each widget on a ~60-second timer | Stays current on its own |
| Hidden | Refresh cycle pauses entirely — no fetch, no render | Not visible to anyone; extension detection continues via its own fetch |
| Returns to foreground | Runs an immediate catch-up fetch and render on focus | Current within ~2 seconds of becoming visible |

On this UI the cosmetic click was therefore redundant in every state a user can observe, and it carried a real risk: fired while the dashboard *editor* or a modal was open (rather than the viewer), the dashboard's refresh handler forcibly remounts the viewer and corrupts the SPA's editor/modal state. Removing it makes the injected function DOM-free — the single detection GET is now the extension's only interaction with the tab. The trade-off is that a widget whose own auto-refresh is disabled will not visually update between manual refreshes; enabling auto-refresh on the widget restores that. (Detection is unaffected regardless: it has never depended on the page rendering.)

### 4.2 Where the code runs, and why

`background.js` doesn't fetch directly. It injects a function into the watched TDX tab:

```js
chrome.scripting.executeScript({
  target: { tabId },
  func:   fetchAndScan,
  args:   [resultsUrl, EXCLUDED_STATUSES, sessionId]   // per-poll URL, status backstop, watch nonce
});
```

The injected function runs in the tab's **isolated world** — a sandbox that shares the page's DOM and **origin/session**, but not its JavaScript variables. Running there means the `fetch` is a genuine same-origin, first-party request: the browser attaches the existing TDX session cookies automatically. **This version does not call the Cookies API, read `document.cookie`, or inspect authentication tokens** — cookie handling stays inside the browser, exactly as it does for the page's own requests.

### 4.3 The core routine: `fetchAndScan`

The function injected into the tab on each poll:

```js
async function fetchAndScan(resultsUrl, excludedStatuses, sessionId) {
  const MAX_BODY_BYTES = 2000000;   // hard cap before parsing — a sane queue is ~KBs
  const send = (found, tickets, diag, truncated) => {
    chrome.runtime.sendMessage({
      action: "ticketsFound", found, tickets,
      diag, truncated: !!truncated, sessionId
    });
  };
  const isExcluded = (status) =>
    excludedStatuses.includes(String(status || "").trim().toLowerCase());

  try {
    // This function does NOT touch the page DOM. Detection is a pure data fetch:
    // it neither reads page elements nor clicks anything. (Earlier versions also
    // clicked the dashboard's own Refresh control to keep the visible grid current,
    // but the current TDX dashboard viewer refreshes its own widgets on a ~60s timer
    // while focused and runs an immediate catch-up refresh when a hidden tab regains
    // focus, so the click was redundant on that UI — and firing it outside the
    // mounted viewer could corrupt the SPA's editor/modal state. It has been removed.
    // See the design document, §4.1.)

    // Explicit timeout so a stalled request becomes a reported failed check.
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), 20000);
    let resp;
    try {
      resp = await fetch(resultsUrl, {
        method:      "GET",
        credentials: "include",              // browser attaches session cookies
        redirect:    "error",                // never follow a redirect off-host
        cache:       "no-store",             // never satisfy from / write to the HTTP cache
        headers:     { "X-Requested-With": "XMLHttpRequest", "Accept": "application/json" },
        signal:      ctrl.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const ctype = (resp.headers.get("content-type") || "unknown").split(";")[0].trim().toLowerCase();
    if (!resp.ok) { send(false, null, "http_" + resp.status); return; }
    if (ctype !== "application/json") {
      // A login page after session expiry arrives as text/html — fail fast, and
      // never hand non-JSON (or mislabeled) content to the parser as trusted data.
      send(false, null, "bad_ctype type=" + ctype);
      return;
    }
    const declared = Number(resp.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      send(false, null, "body_too_large declared=" + declared);
      return;
    }
    const text = await resp.text();
    const meta = "type=" + ctype + " bytes=" + text.length;
    if (text.length > MAX_BODY_BYTES) {
      send(false, null, "body_too_large " + meta);
      return;
    }

    let data = null;
    try { data = JSON.parse(text); } catch {
      send(false, null, "not_json " + meta);
      return;
    }
    const arr = data && Array.isArray(data.data) ? data.data : null;
    if (!arr) { send(false, null, "bad_envelope " + meta); return; }

    // Validate total with exact types (no truthy coercion: null/false/"" must not
    // silently become 0 and disable the truncation comparison). The server sends a
    // JSON number; a digit-only string is explicitly tolerated as the one alternate.
    // Both forms must land on a SAFE non-negative integer — an absurdly long digit
    // string converts to Infinity and must be rejected as malformed, not accepted
    // as a truncation signal.
    let total = null;
    if (typeof data.total === "number") {
      total = data.total;
    } else if (typeof data.total === "string" && /^\d+$/.test(data.total)) {
      total = Number(data.total);
    }
    if (total === null || !Number.isSafeInteger(total) || total < 0) {
      send(false, null, "bad_total " + meta);
      return;
    }
    if (arr.length > total) { send(false, null, "count_mismatch rows=" + arr.length + " total=" + total); return; }

    const tickets = {};
    const seen = new Set();
    for (const o of arr) {
      if (!o || typeof o !== "object")   { send(false, null, "bad_row"); return; }
      if (typeof o.Id !== "number" && typeof o.Id !== "string") { send(false, null, "bad_row"); return; }
      const id = String(o.Id).trim();
      if (!/^\d+$/.test(id))             { send(false, null, "bad_row"); return; }
      if (seen.has(id))                  { send(false, null, "dup_row"); return; }
      seen.add(id);
      if (typeof o.StatusName   !== "string") { send(false, null, "bad_row"); return; }
      if (typeof o.ModifiedDate !== "string") { send(false, null, "bad_row"); return; }
      const status   = o.StatusName.trim();
      if (!status)                       { send(false, null, "bad_row"); return; }
      const modified = o.ModifiedDate.trim();
      if (!modified)                     { send(false, null, "bad_row"); return; }
      if (isExcluded(status)) continue;            // defense-in-depth behind the server filter
      tickets[id] = status + "|" + modified;
    }

    send(true, tickets, undefined, total > arr.length);   // {} is a valid empty queue
  } catch (err) {
    // err.name only (e.g. AbortError, TypeError) — never message content.
    send(false, null, "error:" + (err && err.name ? err.name : "unknown"));
  }
}
```

**Walkthrough:**

- **(A) No page interaction.** The function reads no page elements and clicks nothing — it opens directly with the fetch below. (Earlier versions began with a cosmetic click of the dashboard's own Refresh control; that was removed in v1.2.4, see §4.1.)

- **(B) The poll.** `resultsUrl` is built per-poll by `buildResultsUrl()` from the user's selected groups (validated in the worker), targeting the same endpoint the dashboard calls with `pageSize=200` — with one deliberate difference: its `selectedFields` parameter is trimmed to only `Id`, `StatusName`, and `ModifiedDate`, asking the server to populate only the three values detection uses (see §5 for observed server behavior). `credentials: "include"` makes it authenticated; `cache: "no-store"` instructs Chrome not to satisfy the request from, or write the response to, its HTTP cache — each poll requests a fresh response (no absolute claim is made about intermediaries outside the browser); `X-Requested-With: XMLHttpRequest` mirrors the page's own header so the server treats it as the AJAX request it expects. This is a plain GET — ASP.NET Core only enforces anti-forgery tokens on unsafe methods (POST/PUT/DELETE), so no token juggling is needed.

- **(C) The fingerprint.** (Inactive statuses are excluded server-side per Limitation 3; the name check here is the defense-in-depth backstop.) Each ticket is reduced to `ID → "Status|Modified"` (e.g. `"1234567" → "On Hold|Mon 1/5/26 9:00 AM"`). Why these two fields: TDX bumps a ticket's Modified timestamp on virtually **any** action — assignment, status change, comment, edit — so one string comparison catches nearly everything that can happen to a ticket without modeling each event type. Status is included so a status flip registers even in the rare case the timestamp string doesn't change.

- **(D) Confirmed-format parsing, enforced.** The endpoint's response was verified live via DevTools: `Content-Type: application/json` with envelope `{ data: [ticket objects], total, groups }`, where `total` is the count matching the request's filters and unrequested fields come back as `null` (the `selectedFields` trim visibly enforced server-side). The parser *enforces* the `{ data, total }` contract rather than coercing alternatives (a `groups` property may be present in live responses and is ignored — detection never reads it): the content type must be `application/json`; the body is size-capped before parsing — rejected up front when a `Content-Length` header declares an over-limit size, and after buffering otherwise (the cap counts UTF-16 code units via `text.length`, not network bytes); `total` must be a non-negative *safe* integer (a digit-only string is the one tolerated alternate, and an absurdly long digit string that converts to `Infinity` is rejected as malformed rather than read as truncation); and each row's `Id`, `StatusName`, and `ModifiedDate` must be the expected primitive types with non-empty values — objects coerced into strings are rejected, not accepted. Every failure path sends a fixed reason code plus metadata (status, content type, byte count) so an unexpected shape — or a login page after session expiry, which now fails fast on content type — is diagnosable from the service-worker console without any response-body content ever appearing in a message or log.

### 4.4 Message validation

The injected function reports back via `chrome.runtime.sendMessage`. The worker treats that channel as **untrusted input** — not because arbitrary web pages can reach it (they can't: with no `externally_connectable` declaration, ordinary page script cannot invoke the extension's `runtime.onMessage`), but because the message originates from an injected script running in an authenticated TDX tab, and a compromised page or renderer could influence that context. The scanner's result is therefore validated by sender, tab, host, nonce, and schema before it is trusted:

```js
case "ticketsFound":
  chrome.storage.session.get(["watchedTabId", "watchSessionId"], ({ watchedTabId, watchSessionId }) => {
    // 1. Must come from a tab, and specifically THE watched tab, on the locked host
    if (!sender.tab || sender.tab.id !== watchedTabId || !isWatchedHost(sender.tab.url)) {
      console.warn("TDX Watcher: rejected ticketsFound from unexpected sender");
      return;
    }
    // 2. Failed scans update status but never touch the snapshot. Every failure
    //    report carries the nonce of the session it belongs to — markScanFailed
    //    re-validates it, so a delayed failure (including a delayed injection
    //    failure) from a previous watch session can't touch a new session's counter.
    if (msg.found !== true) {
      markScanFailed(msg.diag || "unknown", msg.sessionId);
      return;
    }
    // 3. Payload validation: plain object, numeric IDs, bounded strings, capped rows
    const tickets = sanitizeTickets(msg.tickets);
    if (tickets === null) {
      markScanFailed("payload_rejected", msg.sessionId);
      return;
    }
    handleSnapshot(tickets, msg.truncated === true);
  });
```

`sanitizeTickets` enforces: plain object (not array), ≤ 2000 keys, every key `/^\d+$/`, every value a string ≤ 300 chars. Control messages (`startWatcher`, `silenceAlarm`, etc.) have a stricter gate — they're only accepted from the extension's **own privileged contexts** (`sender.id === chrome.runtime.id && !sender.tab`), i.e. the popup and offscreen document, never from any tab.

### 4.5 Change detection

```js
const prev = lastSnapshot || {};
let newCount = 0, changedCount = 0;
for (const id in tickets) {
  if (!(id in prev))                 newCount++;      // never-seen ID  → new ticket
  else if (tickets[id] !== prev[id]) changedCount++;  // fingerprint moved → ticket actioned
}
```

- **New ticket:** an ID in the current snapshot that wasn't in the previous one.
- **Actioned ticket:** same ID, different `"Status|Modified"` string.
- **Departed tickets** (resolved, reassigned away — present in `prev`, absent now) are deliberately **not** alerted on: a ticket leaving the queue is not something a responder needs to be interrupted for.

If `newCount > 0 || changedCount > 0`, `ticketAlarmActive` flips on, the badge is set, and the audio starts (volume 0 = silent mode). Either way, the new snapshot **overwrites** the old one.

The ticket alarm is one of **two independent alarm states**. The other, `failureAlarmActive`, marks *degraded monitoring* — three consecutive failed checks, or a queue exceeding the monitored page size — and is governed by different rules: it activates even while a ticket alarm is already sounding, it auto-clears when a fully successful complete scan arrives, and Silence merely *acknowledges* it (mutes the audio) without resetting the failure counter, which only a successful check can reset. The orange (failure) badge takes priority over the red (ticket) badge, so a green-and-quiet or red-only icon always means monitoring itself is healthy.

**Truncated results are never diffed.** When the server reports more tickets than the returned page (`total > rows`), the scan is treated as degraded, not as a snapshot: the partial page is not compared, not stored, and not used as a baseline — page churn at the boundary would otherwise manufacture false "new ticket" alarms while silently dropping whichever tickets slid off page one. The last trusted complete snapshot is retained, and the next complete check diffs against it, so changes that occurred during the degraded window still surface.

### 4.6 The baseline

```js
if (!baselineSet) {
  updates.lastSnapshot = tickets;   // record, don't compare — even an empty queue
  updates.baselineSet  = true;
  chrome.storage.session.set(updates);
  return;
}
```

On the first poll after Watch is clicked, there is nothing to compare against, so the snapshot is recorded silently as the starting point. This prevents the extension from alarming on the 30 tickets already sitting in the queue at startup. An **empty queue is a valid baseline** — the code distinguishes "the server said zero tickets" (valid, baseline it) from "the request failed" (skip, don't baseline), so the very first ticket after a clean queue is still caught. A **truncated page is never a baseline** either: if the first scan already exceeds the page size, the watcher goes straight to the degraded state and waits for a complete result before establishing its starting point.

---

## 5. Data Storage and Retention

| Data | Where | Contents | Lifetime |
|---|---|---|---|
| `lastSnapshot` | `chrome.storage.session` (memory-backed, trusted contexts only) | Ticket IDs → `"Status|Modified"` strings | Replaced at each successful **complete** check (truncated pages are never stored); retained across failed or over-limit checks; cleared on Stop, tab close, navigation off TDX, **browser close/restart**, or extension update/reinstall |
| `settings` | `chrome.storage.local` (disk-backed) | Interval (1–60 min), watched groups, alarm sound, volume | Until changed; survives restarts; removed on uninstall |
| Status fields | `chrome.storage.session` | `watchSessionId`, `ticketAlarmActive`, `failureAlarmActive`, `failureAcknowledged`, `lastCheckedAt`, `lastSuccessfulAt`, `lastSeenCount`, `lastNewCount`, `lastChangedCount`, `lastScanOk`, `lastTruncated`, `consecutiveFailures`, `alarmNewTotal`, `alarmChangedTotal` | Overwritten continuously; wiped on Stop or browser close |
| Fetch response body | In-memory only, inside the injected function | Envelope metadata plus ticket objects in which only the three requested values (Id/StatusName/ModifiedDate) are populated (unrequested properties returned as `null` in live testing) | Held only while parsed; not intentionally persisted — the request instructs Chrome not to use or populate its HTTP cache (`cache: "no-store"`) |
| Credentials / cookies | **Never touched by the extension** | — | The browser attaches session cookies to the same-origin request itself |

The extension writes nothing to any other location: no files, no sync storage, and no network destination beyond its request to your organization's own TDX host. The complete answer to "how long does the extension store ticket data" is: **one poll cycle — replaced at each successful complete check (every 1–60 minutes per the configured interval), retained across failed or over-limit checks so a broken or partial scan never erases the last trusted picture, and gone entirely when watching stops.** Updating from a pre-1.2.0 version additionally deletes the operational keys those versions kept in disk-backed local storage (see §8, migration).

*Data minimization at the source:* the request's `selectedFields` parameter is trimmed to exactly the three fields detection uses — `Id`, `StatusName`, `ModifiedDate`. Sensitive fields the dashboard normally retrieves (Title, requestor, account/department, priority, responsible parties) are **never requested**; in live testing (July 2026) the server returned unrequested properties as `null`, so sensitive values were absent from the response. Independent of server behavior, the extension retains only the three requested values — everything else is discarded during parsing and never persisted.

---

## 6. Background Audio Architecture

### 6.1 The constraint

An MV3 service worker has **no DOM and no audio APIs** — it is architecturally incapable of making sound. The popup *can* play audio, but the popup is destroyed the instant the user clicks anywhere else. The extension's entire purpose is to alert someone who is *not looking at TDX* — so the only context that could naturally play sound is the one guaranteed not to exist at alert time.

### 6.2 The offscreen document

Chrome's **Offscreen API** lets an extension create an invisible document — not a tab, not the popup — that persists independently and has full DOM APIs, including Web Audio:

```js
async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length > 0) return;                       // reuse if already alive
  await chrome.offscreen.createDocument({
    url:           "offscreen.html",
    reasons:       ["AUDIO_PLAYBACK"],                   // declared purpose, enforced by Chrome
    justification: "Play alarm tones when TDX tickets are added or changed"
  });
}
```

The worker decides *when* something is alarm-worthy; the offscreen document only knows *how* to make noise. They communicate with a small message set: `playSound`, `stopSound`, `updateSound` (live sound/volume changes), and `playTestSound` (a one-shot preview the popup requests via the worker as `requestTestSound` — the worker-forwarded name is the only test action the offscreen document handles, so the popup's own broadcast cannot cause a double-play). This loose coupling is deliberate — it's why the audio can be changed or silenced (volume 0) independently of the alarm state, so the Silence button and acknowledgment step are always preserved regardless of what the sound is doing.

Two robustness details: document *creation* is guarded by a shared promise, so two near-simultaneous callers (a detection and a settings change, say) can't both call `createDocument` and have the second rejected. And because Chrome may reap a silent `AUDIO_PLAYBACK` document (e.g. at volume 0), a sound-settings change during an active alarm re-ensures the document exists and re-issues `playSound` — `startLoop` is idempotent, so an already-running loop simply picks up the new settings, while a reaped one is resurrected. Without that, raising the volume mid-alarm could do nothing.

### 6.3 The sound generator

```js
function startLoop() {
  if (loopInterval) return;                    // already looping — don't stack
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  playTones();                                 // sound immediately
  loopInterval = setInterval(playTones, 3000); // then every 3s until silenced
}

function playTones() {
  const tones    = [880, 1047, 1319];          // A5, C6, E6 — a rising three-note chime
  const duration = 0.2;
  const start    = ctx.currentTime;

  tones.forEach((freq, i) => {
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    osc.type            = "sine";
    const t = start + i * duration;            // stagger the notes in sequence
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.6, t + 0.03);            // 30ms fade-in
    gain.gain.linearRampToValueAtTime(0,   t + duration - 0.03); // fade-out
    osc.start(t);
    osc.stop(t + duration);
  });
}
```

Design details:

- **Five selectable sounds, all synthesized** — volume 0 is silent mode (visual-only alerts; there is deliberately no separate mute toggle, so silencing never disables detection): Rising chord (default), Single beep, Klaxon, Descending chime, and Low buzzer — each built from enveloped oscillators, so there are no audio assets to bundle. A volume slider (0–100%) sets the peak gain directly, and a 🔊 Test button in the popup plays a one-shot preview at the current settings (a one-shot that never touches the alarm loop). Sound and volume changes save immediately and are forwarded live to the offscreen document, so a change mid-alarm is heard on the next loop tick. The worker validates the sound name against a whitelist and clamps volume to 0–1 before storing or forwarding.
- **Gain ramps.** Starting or stopping a raw oscillator at non-zero amplitude produces an audible click/pop. The 30 ms fade-in and fade-out make each note clean.
- **The 3-second loop is deliberate.** The alarm repeats until acknowledged, so one missed chime never equals a missed ticket. The two alarm types end differently by design: a **ticket-change** alarm requires explicit acknowledgment (the popup's Silence button) and never auto-dismisses, while a **monitoring-failure** alarm clears automatically when monitoring fully recovers — the alerted condition has ended — and can also be acknowledged early with Silence, which mutes the audio without erasing the failure history.
- **`ctx.resume()`** handles the `AudioContext` starting suspended; the extension owns this document, so it may resume without a user gesture.
- **The `if (loopInterval) return` guard** prevents stacked loops if two detections land close together.
- **Silence** clears the interval and closes the context, releasing the audio hardware.

---

## 7. The Popup

The popup is non-authoritative: it holds only transient UI state (the running flag, current tab id, display ticker) and reconstructs persistent state from storage each time it opens, sending privileged control messages (`startWatcher`, `stopWatcher`, `silenceAlarm`, `soundSettingsChanged`, `requestTestSound`) for anything that matters. Notable details:

- **Live status via storage events** (the state area is `chrome.storage.session`; settings arrive from `local`). While alarming, the status line shows cumulative counts since the alarm began (e.g., "🚨 3 new, 1 updated detected — alarm sounding!"), accumulating across polls and resetting on Silence — so it always answers "what happened since I was last caught up?" rather than showing a confusing per-poll zero. Rather than polling, it subscribes to `chrome.storage.onChanged` — when the worker writes new state (a completed check, an alarm firing), the open popup updates instantly. A 1-second ticker keeps the "Last successful check Xs ago" line counting up in real time — the principal status is anchored to the last *validated* scan, with failed attempts shown separately, so the line can never present a stale success as fresh.
- **Silence is explicit.** While watching continues, the Silence button is the acknowledgment mechanism — opening the popup or switching tabs never auto-silences, keeping navigation and acknowledgment decoupled. (Stopping the watcher, closing or navigating the watched tab away, or disabling the extension also ends the alarm, since alarm state cannot outlive the watch.)
- **Acknowledged degradation stays visible.** The popup renders one of three presentations while running — alarming (red, pulsing, Silence shown), degraded (amber dot and an explicit "acknowledged — monitoring remains degraded" status), or healthy (green). Silencing a monitoring-problem alarm mutes the audio but the popup remains amber, matching the orange toolbar badge, until a complete successful check actually occurs — the healthy green presentation is never restored by acknowledgment alone.
- **No page-controllable strings rendered.** The popup renders no tab titles or any other text a web page can influence — all popup text is static or extension-generated, avoiding that particular rendering sink.
- **Interval clamping happens in both the popup and the worker** (1–60 minutes), so neither a UI bug nor a crafted message can create an abusive polling rate. The 1-minute floor is a deliberate courtesy to the TDX server.

---

## 8. Security Posture

**Scope containment**
- `host_permissions` declares privileged access for exactly one origin, `https://your-tdx-host.example.edu/*`, and this version's code contains no network destination or scripting target outside that host.
- Least-privilege permissions: the broad `tabs` permission is not requested. Not requesting it withholds sensitive tab properties (URL, title) for tabs outside the permitted TDX origin; many Tabs API operations require no `tabs` permission, and the calls this extension makes are limited to identifying the active tab and validating the watched tab.
- Incognito is disabled (`"incognito": "not_allowed"`): the extension has no private-browsing use case, so it cannot be enabled there.
- The scanner is injected with an explicit `world: "ISOLATED"`, so it runs in the isolated world that shares the page's origin and session but not its JavaScript — the default, made explicit — and it cannot see or be seen by page script.
- The injected fetch self-validates its destination before sending: even though the worker builds the URL, `fetchAndScan` re-checks that it is exactly the approved Results endpoint over HTTPS on the locked host with no embedded credentials, and the request is sent with `referrerPolicy: "no-referrer"`. Nothing untrusted can supply that URL today; the check is a guard against future changes.
- Group selection is allowlist-enforced in the worker: a watched group ID must appear in the approved set (`ALLOWED_GROUP_IDS`, derived from the shared `GROUPS` table), and `sanitizeGroupIds` rejects anything else regardless of what the popup sends. Server-side TDX authorization remains the primary access control; this is a secondary purpose-limitation check. The popup offers no free-entry group field, and broadening the approved set is a `groups.js` change that should go through the deploying organization's approval process.
- The watched tab is validated at two checkpoints each cycle — when the poll is scheduled and again immediately before injection — and **both** resolve a missing or off-host tab the same way: the watcher stops. A tab that closes or navigates in the gap between the two checks therefore ends the watch rather than producing a poll that silently does nothing (tab *closure* is also handled promptly via `tabs.onRemoved`).
- The detection fetch uses `redirect: "error"`, so the request chain can never follow a redirect off the locked host — an expired session fails fast as a skipped scan rather than fetching an SSO page.
- Diagnostic logging is metadata-only: HTTP status, content type, byte count, error names (e.g. `AbortError`), and fixed reason codes. Response-body content is never logged; navigation-away events log only the destination hostname, never full URLs.

**Network behavior**
- Each poll issues exactly one detection GET, to the locked host only, hitting the same endpoint the TDX page calls itself — but requesting fewer fields than the page does, and sent with `cache: "no-store"`. The extension no longer interacts with the page (the cosmetic refresh click was removed in v1.2.4), so it originates no other requests of any kind; the watched TDX page may of course continue issuing its own requests (e.g. its widgets' own auto-refresh), all likewise to the locked host. The extension's code contains no network destination outside that host — no analytics, telemetry, or third-party services.
- No credentials are handled: the browser attaches the existing session cookies to the same-origin request. Session expiry degrades gracefully (the fetch returns a login page → logged as a skipped scan, never a false alarm).

**Message security**
- Control actions accepted only from the extension's own privileged contexts (`sender.id === chrome.runtime.id && !sender.tab`).
- Scanner payloads accepted only from the watched tab on the locked host (ordinary page script cannot reach the channel — no `externally_connectable` is declared), carrying the current watch session's random nonce (results from a stopped or restarted session are discarded), then schema-validated before touching state. Validation is strict and typed against the enforced `{ data, total }` contract: a non-`application/json` content type, an over-size body, any row with a missing/invalid ID, a non-string or empty status or modified date, any duplicate ID, an invalid `total` (exact-type checked and safe-integer bounded; no truthy coercion, and an over-range digit string is malformed rather than a truncation signal), or a row-count/metadata conflict rejects the entire scan as a failed check — a malformed response is never accepted as a trusted partial snapshot. Failure reports are nonce-scoped: a delayed failure (including an injection failure) from a stopped or restarted watch session is discarded.

**Data minimization**
- The request itself is minimized at the source: `selectedFields` asks the server for only `Id`, `StatusName`, and `ModifiedDate`. Sensitive fields (ticket titles, requestor names, account/department) are never requested; in live testing the server returned them as `null`, and the extension retains only the three requested values regardless of what the server returns.
- Retained ticket data is limited to those same three fields per ticket, held in session-only storage: replaced each successful check (retained across failed checks) and cleared on stop, browser close, or uninstall. In this version, nothing ticket-derived touches disk-backed storage — and the update handler enforces that historically too: **migration** on update removes the operational keys that pre-1.2.0 versions kept in `chrome.storage.local` (the complete key list lives in `LEGACY_LOCAL_STATE_KEYS`), so upgraded installations end in the same state as fresh ones.
- Disk-backed settings are additionally restricted with `chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })`, guarded against both failure shapes — a synchronously missing method and a rejected Promise — so it degrades to a silent no-op on any Chrome version where the call is unavailable, and a future content-script addition can't accidentally expose settings to a page-adjacent context.

**Failure transparency**
- Failure modes — fetch timeout (explicit 20-second `AbortController`), HTTP errors, wrong content types, over-size bodies, unparseable or unexpected responses, strict-validation rejections, and script-injection failures — are all reported as *failed checks*, never as a zero-ticket reading. Every monitoring attempt reaches one of exactly three outcomes: a validated scan, a counted failed check, or a stopped watcher. No path returns silently — an injection that cannot proceed because the tab is gone or off-host stops the watcher, while an injection that is attempted and rejected counts as a failed check.
- The failure alarm is **independent of the ticket alarm**: after three consecutive failed checks, `failureAlarmActive` engages (orange badge, alarm audio) even if a ticket alarm is already sounding, so a session expiry mid-alarm cannot hide. A queue exceeding the monitored page size engages the same degraded state — and the partial page is **never diffed or stored**: the last trusted complete snapshot is retained, comparisons pause, and they resume automatically (against that retained snapshot) at the next complete check. The extension never presents an incomplete watch as healthy, and never manufactures alarms from page churn at the boundary. Silence acknowledges the audio without resetting the failure counter; the orange badge persists while degraded, and only a fully successful complete check resets the counter, clears the degraded state, and re-arms the failure alarm. A recovering failure alarm never auto-silences an unacknowledged ticket alarm.

---

### Independent verification

The principal network, response, and storage claims above are independently verifiable in approximately five minutes with Chrome DevTools, without reading source code (complete control-flow, migration, and message-validation behavior require reading the source, which is short and unminified):

*Provenance note: instance-specific claims in this document — the Results endpoint format, the response envelope, server-side `selectedFields` and status-filter behavior, and the internal status IDs — were confirmed by live authenticated DevTools captures against `your-tdx-host.example.edu` on July 14–15, 2026. They describe observed behavior of the target TDX instance as of that date, not properties guaranteed by the source code alone, and should be re-verified if TDX is upgraded or reconfigured.*

1. **What is requested:** on the watched TDX tab, DevTools → Network → filter `Results` → select the extension's request → **Payload** tab. Observe `selectedFields` = `["Id","StatusName","ModifiedDate"]` and the two `filters` clauses (groups; inactive statuses excluded).
2. **What comes back:** the **Preview** tab shows the `{ data, total, groups }` envelope, with every unrequested field returned as `null` by the server.
3. **No third-party traffic:** with the Network panel open across several poll cycles, the extension issues one direct `Results` request per cycle; when the watched tab is the dashboard, its triggered dashboard refresh may add the page's own TDX requests. All traffic remains on `your-tdx-host.example.edu` — no third-party hosts, no telemetry endpoints.
4. **What is stored:** `chrome://extensions` → the extension's service worker console → run both `chrome.storage.local.get(null, s => console.log('settings:', s))` and `chrome.storage.session.get(null, s => console.log('state:', s))`. Disk-backed storage contains only user settings (on installations upgraded from pre-1.2.0 versions, the update migration has removed the operational keys those versions wrote); all monitoring state — the latest `{ ticketId: "Status|Modified" }` snapshot, the watch-session nonce, both alarm flags, timestamps, and counters — lives in the session area and does not survive a browser restart.
5. **What it can touch:** the extension's entry on `chrome://extensions` lists site access as `your-tdx-host.example.edu` only.

## 9. Known Limitations

1. **Minute-granularity blind spot.** The Modified timestamp resolves to the minute. Two actions on the same ticket within the same minute produce identical fingerprints; only the first registers. Rare in practice, but real.
2. **Self-triggered alarms.** The user's *own* actions bump Modified, so the watcher alarms on tickets the user just touched. This is currently intentional — the requirement was to alarm on any change to a ticket's returned status/modified-time fingerprint, whoever caused it; filtering rows where Modified-By is the user is a small scanner change if it becomes noisy.
3. **Group scope is user-selected; status exclusion is server-side with a client-side backstop.** The popup's group picker chooses which of the approved queues are watched; the request URL is built dynamically from that selection (validated against the approved group allowlist in the worker before URL construction — any queue outside the approved set is rejected, not monitored, and the popup has no free-entry group field). Inactive tickets (Resolved / Closed / Cancelled) are excluded **by the server**: the request carries a second filter — `StatusName`, operator 8 ("is not one of"), with the instance's internal status IDs, captured verbatim from the dashboard's own filtered request — so they never cross the wire or consume page slots. Those IDs are instance-specific; if your TDX admins recreate statuses, they must be recaptured (dashboard request → Payload → filters). A client-side name exclusion (closed/resolved/cancelled/completed, case-insensitive) remains as defense-in-depth against ID drift or newly created inactive statuses. Any action on an excluded ticket flips it to an active status, at which point it re-enters the snapshot as new and alarms. Group changes apply on watch start (the picker locks while running), which implicitly rebuilds the baseline and prevents a scope change from mass-alarming. If the active queue ever exceeds the request's page size (200), the scanner detects it from the response's `total` field and the extension treats it as **degraded monitoring with comparisons paused**: the failure alarm sounds on the transition, the badge turns orange and stays orange while the condition persists, the popup states that some tickets are NOT monitored, and the partial page is neither compared nor stored — the last complete snapshot is retained, and diffing resumes against it automatically once the queue returns under the limit (changes from the degraded window then surface in that first complete diff). Silence mutes the audio but the amber presentation and orange badge remain until a complete check succeeds — a green icon never means "incomplete but fine."
4. **A logged-in TDX tab must exist.** The fetch runs inside the watched tab and rides its session. No open TDX tab (or an expired session) means skipped scans until the user logs back in — visible in the popup's status line.
5. **The extension does not refresh the visible grid.** Detection is a pure data fetch and never interacts with the page, so the on-screen grid stays current only by the TDX dashboard viewer's own means: its widgets refresh on a ~60-second timer while the tab is focused, and it runs a catch-up refresh when a hidden tab regains focus. A widget with its own auto-refresh disabled will not update visually between manual refreshes — enabling auto-refresh on the widget restores that. Detection is unaffected either way. (Prior versions clicked the dashboard's Refresh control cosmetically; that was removed in v1.2.4, see §4.1.)
6. **No DOM dependency.** As of v1.2.4 the extension does not read or interact with any page element; detection depends only on the JSON shape of the `Results` endpoint's response. There is no CSS/selector coupling to the TDX frontend that a UI redeploy could break. (The endpoint's URL parameters and response envelope remain instance-specific — see the provenance note above — and should be re-verified if TDX is upgraded.)

---

## 10. Glossary

| Term | Meaning |
|---|---|
| **Service worker** | The extension's background script under MV3; event-driven, terminated when idle, no DOM |
| **Isolated world** | The sandbox where injected scripts run: shares the page's DOM and origin, not its JS variables |
| **Offscreen document** | A hidden, extension-owned page with full DOM APIs; used here solely as the audio player |
| **Snapshot** | One poll's map of `ticketId → "Status\|Modified"` |
| **Fingerprint / signature** | The `"Status\|Modified"` string; if it changes, the ticket was actioned |
| **Baseline** | The first snapshot after starting, recorded without comparison so pre-existing tickets don't alarm |
| **Skipped scan** | A poll whose result couldn't be trusted (error, timeout, login page); never treated as "zero tickets" |
