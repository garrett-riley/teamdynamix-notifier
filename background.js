// TeamDynamix Notifier — Background Service Worker (v1.2.8)
//
// Detection model: TDX gives a ticket grid, not a single count. Each poll fetches the
// grid's DATA directly from the same endpoint the dashboard itself calls, keyed by
// ticket ID, and DIFFs it against the last snapshot. New ID => new ticket. Same ID,
// changed signature => ticket was actioned.
//
// Why a fetch: TDX renders the grid client-side and DEFERS that rendering while
// the tab is hidden, so neither an in-place refresh nor a full reload can read fresh
// rows in the background. A same-origin fetch, injected into the (open, logged-in) TDX
// tab, is NOT visibility-gated — it returns the ticket data whether the tab is shown or
// not, riding the existing session via the browser's own cookies.
//
// Storage model: operational state (snapshot, watched tab, alarm state, counters)
// lives in chrome.storage.session — memory-backed, cleared when the browser closes,
// surviving normal service-worker sleep, and restricted to trusted extension contexts.
// Only user preferences live in disk-backed chrome.storage.local. Updating from a
// version older than 1.2.0 removes any operational data those versions kept on disk.
//
// Alarm model (v1.2.0): two INDEPENDENT alarm states.
//   - ticketAlarmActive  (red "!")    — new/changed tickets; cleared ONLY by Silence.
//   - failureAlarmActive (orange "!") — monitoring is degraded: consecutive failed
//     checks, or the active queue exceeds the monitored page size. Auto-clears when
//     the degraded condition ends; Silence acknowledges the audio without erasing
//     the failure history, and the orange badge stays up while degraded.
// A ticket alarm can no longer suppress the failure alarm, and silencing a ticket
// alarm no longer resets the failure counter.
//
// Truncation policy (v1.2.1): a truncated page (server total > returned rows) is
// NEVER diffed or stored. The last trusted complete snapshot is retained, the
// degraded state engages, and normal comparison resumes automatically at the next
// complete check — a known-incomplete result is never treated as a snapshot.

// Shared config (ALLOWED_HOST, interval bounds, FAILURE_ALARM_THRESHOLD, GROUPS)
// lives in groups.js. MV3 service workers are classic workers, so importScripts
// loads it synchronously into this scope before any of the code below runs.
importScripts("groups.js");

// Approved group allowlist. A watched group must appear in this set — the worker
// enforces it regardless of what the popup sends, so a crafted message naming any
// other queue is rejected rather than monitored. Derived from the shared GROUPS
// table; broadening it is a groups.js change that should go through your
// organization's security/approval process.
const ALLOWED_GROUP_IDS = new Set(Object.keys(GROUPS).map(Number));

const POLL_ALARM   = "tdx-poll";


// SERVER-SIDE status exclusion: internal status IDs for Resolved / Closed /
// Cancelled, captured verbatim from the dashboard's own filtered request. operator 8
// = "is not one of" (operator 13 = "is one of", used for groups). These IDs are
// INSTANCE-SPECIFIC to your-tdx-host.example.edu — if your TDX admins recreate statuses, they
// must be recaptured from DevTools (dashboard request → Payload → filters).
// ⚠ REDACTED FOR PUBLIC RELEASE — REPLACE with your instance's IDs for
// Resolved / Closed / Cancelled (placeholders below match nothing real).
const EXCLUDED_STATUS_IDS = [0 /* RESOLVED_ID */, 0 /* CLOSED_ID */, 0 /* CANCELLED_ID */];

// Client-side name exclusion, kept as DEFENSE-IN-DEPTH behind the server-side filter:
// catches anything the ID filter misses (e.g. a newly created inactive status, or
// drifted IDs) so an inactive ticket still can't alarm. Case-insensitive exact match;
// "completed" is defensive and a no-op unless a status uses that exact name.
const EXCLUDED_STATUSES = ["closed", "resolved", "cancelled", "completed"];

// Builds the data request for the selected groups. Same endpoint the dashboard calls,
// with selectedFields trimmed to ONLY the three fields detection uses (Id, StatusName,
// ModifiedDate) — sensitive fields are never requested — and inactive statuses
// filtered out by the server. pageSize=200 is generous headroom for any active queue.
function buildResultsUrl(groupIds) {
  const selectedFields = JSON.stringify(["Id", "StatusName", "ModifiedDate"]);
  const display = groupIds.map(id => GROUPS[id] || ("Group " + id)).join(", ");
  const filters = JSON.stringify([
    {
      field:           "ResponsibleGroupName",
      operator:        13,                     // "is one of"
      argument:        groupIds,
      argumentDisplay: display
    },
    {
      field:           "StatusName",
      operator:        8,                      // "is not one of"
      argument:        EXCLUDED_STATUS_IDS,
      argumentDisplay: null
    }
  ]);
  return "https://" + ALLOWED_HOST + "/TDWorkManagement/WorkManagement/Queries/Tickets/Results" +
    "?pageNumber=1&pageSize=200&sortField=StatusName&sortDirection=2&groupByField=" +
    "&selectedFields=" + encodeURIComponent(selectedFields) +
    "&filters=" + encodeURIComponent(filters) +
    "&context=" + encodeURIComponent('{"appId":null}');
}

const MAX_ROWS                = 2000;   // sanity cap on rows accepted from the scanner
const BADGE_ALERT_COLOR       = "#f4503a";  // red — ticket change alarm
const BADGE_FAILURE_COLOR     = "#f4a63a";  // orange — monitoring degraded (failures/truncation)

const ICONS_ACTIVE   = { "16": "icon16_active.png", "48": "icon48_active.png", "128": "icon128_active.png" };
const ICONS_INACTIVE = { "16": "icon16.png",        "48": "icon48.png",        "128": "icon128.png" };

const ALARM_SOUNDS = ["chord", "beep", "klaxon", "chime", "buzzer"];

const DEFAULT_SETTINGS = { intervalMinutes: 1, alarmSound: "chord", alarmVolume: 0.6 };

// Operational state — lives in chrome.storage.session ONLY.
const DEFAULT_STATE = {
  lastSnapshot:        {},     // { ticketId: "signature", ... }
  watchedTabId:        null,
  watchSessionId:      null,   // random per-watch nonce; scanner results must echo it
  ticketAlarmActive:   false,  // red alarm — new/changed tickets; cleared only by Silence
  failureAlarmActive:  false,  // orange alarm — monitoring degraded; auto-clears on recovery
  failureAcknowledged: false,  // Silence pressed during the CURRENT degraded condition
  baselineSet:         false,
  lastCheckedAt:       null,   // when the last poll was TRIGGERED (attempt time)
  lastSuccessfulAt:    null,   // when the last fully validated scan COMPLETED
  lastSeenCount:       null,
  lastNewCount:        0,
  lastChangedCount:    0,
  lastScanOk:          null,
  lastTruncated:       false,
  consecutiveFailures: 0,
  alarmNewTotal:       0,      // cumulative new tickets since the ticket alarm began
  alarmChangedTotal:   0       // cumulative updated tickets since the ticket alarm began
};

// v1.0.x kept operational state in disk-backed chrome.storage.local. These are the
// complete top-level keys those versions wrote (besides `settings`); the update
// migration removes them so no ticket-derived data survives an upgrade on disk.
const LEGACY_LOCAL_STATE_KEYS = [
  "lastSnapshot", "watchedTabId", "alarmActive", "baselineSet",
  "lastCheckedAt", "lastSeenCount", "lastNewCount", "lastChangedCount",
  "lastScanOk", "lastTruncated", "alarmNewTotal", "alarmChangedTotal"
];

// Defense in depth: keep disk-backed settings readable only from trusted extension
// contexts, so a future content-script addition can't accidentally expose them.
// Guard BOTH failure shapes across the supported Chrome range: a missing method
// (synchronous TypeError → try/catch) and a rejected Promise (→ .catch). Either
// way this degrades to a silent no-op. storage.session is already
// TRUSTED_CONTEXTS by default.
try {
  const p = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  if (p && typeof p.catch === "function") p.catch(() => {});
} catch (_) {}

// ─── Install / Update / Startup ───────────────────────────────────────────────
chrome.runtime.onInstalled.addListener((details) => {
  chrome.alarms.clear(POLL_ALARM);
  chrome.storage.session.set({ ...DEFAULT_STATE });
  chrome.action.setBadgeText({ text: "" });
  setIcon(false);
  if (details.reason === "install") {
    chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    return;
  }
  if (details.reason === "update") {
    // Migration: purge operational keys that pre-1.2.0 versions kept on disk,
    // then re-save sanitized settings (the only local key this version uses).
    chrome.storage.local.remove(LEGACY_LOCAL_STATE_KEYS, () => {
      chrome.storage.local.get(["settings"], ({ settings }) => {
        const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
        merged.intervalMinutes = clampInterval(merged.intervalMinutes);
        merged.alarmSound      = sanitizeSound(merged.alarmSound);
        merged.alarmVolume     = clampVolume(merged.alarmVolume);
        chrome.storage.local.set({ settings: merged });
        console.log("TDX Notifier: updated — legacy operational keys removed from local storage");
      });
    });
  }
});

// Browser startup: session storage has already been cleared by Chrome, so any
// pre-restart "watching" state is gone by construction. Reconcile the rest: clear
// any surviving alarm and reset the UI so the extension always starts idle.
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.clear(POLL_ALARM);
  chrome.storage.session.set({ ...DEFAULT_STATE });
  chrome.action.setBadgeText({ text: "" });
  setIcon(false);
});

// ─── Icon / Badge ─────────────────────────────────────────────────────────────
function setIcon(active) {
  chrome.action.setIcon({ path: active ? ICONS_ACTIVE : ICONS_INACTIVE });
}
function setBadgeTicket() {
  chrome.action.setBadgeText({ text: "!" });
  chrome.action.setBadgeBackgroundColor({ color: BADGE_ALERT_COLOR });
}
function setBadgeFailure() {
  chrome.action.setBadgeText({ text: "!" });
  chrome.action.setBadgeBackgroundColor({ color: BADGE_FAILURE_COLOR });
}
function clearBadge() {
  chrome.action.setBadgeText({ text: "" });
}

// Single source of truth for the badge, derived from stored state. A degraded
// monitor (orange) takes priority over a ticket alarm (red): failure transparency
// beats change notification — the green icon must never mean "incomplete but fine."
function refreshBadge() {
  chrome.storage.session.get(
    ["watchedTabId", "ticketAlarmActive", "failureAlarmActive", "consecutiveFailures", "lastTruncated"],
    (st) => {
      if (!st.watchedTabId) { clearBadge(); return; }
      const degraded = st.failureAlarmActive ||
                       (st.consecutiveFailures || 0) >= FAILURE_ALARM_THRESHOLD ||
                       !!st.lastTruncated;
      if (degraded)               setBadgeFailure();
      else if (st.ticketAlarmActive) setBadgeTicket();
      else                        clearBadge();
    }
  );
}

// ─── Validation helpers ───────────────────────────────────────────────────────
function isPrivilegedSender(sender) {
  return !!sender && sender.id === chrome.runtime.id && !sender.tab;
}

function isWatchedHost(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === ALLOWED_HOST;
  } catch {
    return false;
  }
}

function clampInterval(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return MIN_INTERVAL_MIN;
  return Math.min(MAX_INTERVAL_MIN, Math.max(MIN_INTERVAL_MIN, n));
}

function sanitizeTickets(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length > MAX_ROWS) return null;
  const clean = {};
  for (const id of keys) {
    if (!/^\d+$/.test(id)) return null;
    const sig = raw[id];
    if (typeof sig !== "string" || sig.length > 300) return null;
    clean[id] = sig;
  }
  return clean;
}

function sanitizeGroupIds(raw) {
  if (!Array.isArray(raw)) return null;
  // Enforce the approved allowlist here, in the worker — not only in the popup — so a
  // crafted message or a hand-entered unknown ID can't cause a queue outside the
  // approved set to be monitored. Server-side TDX authorization remains the primary
  // control; this is a secondary purpose-limitation check.
  const ids = [...new Set(raw.map(Number))].filter(
    n => Number.isInteger(n) && ALLOWED_GROUP_IDS.has(n)
  );
  if (ids.length < 1 || ids.length > 50) return null;
  return ids;
}

function sanitizeSound(s) {
  return ALARM_SOUNDS.includes(s) ? s : "chord";
}

function clampVolume(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.6;
  return Math.min(1, Math.max(0, n));
}

// ─── Failed-check accounting ──────────────────────────────────────────────────
// Every failure path routes here, carrying the watch-session nonce of the poll it
// belongs to — a delayed failure from a stopped/restarted session is discarded, so
// it can't pollute a new session's counter. Diagnostics are METADATA ONLY (status
// codes, content type, byte counts, error names, fixed reason codes) — never
// response-body content.
//
// After FAILURE_ALARM_THRESHOLD consecutive failures the failure alarm activates
// REGARDLESS of whether a ticket alarm is already sounding (independent states).
// If the user has acknowledged the current degraded condition with Silence, the
// audio stays off, but the failure counter keeps counting and the orange badge
// stays up; only a successful check resets the counter.
function markScanFailed(diag, sessionId) {
  console.warn("TDX Notifier: check failed —", diag);
  chrome.storage.session.get(
    ["watchSessionId", "consecutiveFailures", "failureAlarmActive", "failureAcknowledged"],
    (st) => {
      if (!st.watchSessionId || sessionId !== st.watchSessionId) {
        console.log("TDX Notifier: discarded failure report from a previous watch session");
        return;
      }
      const fails = (st.consecutiveFailures || 0) + 1;
      const updates = { lastScanOk: false, consecutiveFailures: fails };
      const activate = fails >= FAILURE_ALARM_THRESHOLD &&
                       !st.failureAlarmActive &&
                       !st.failureAcknowledged;
      if (activate) updates.failureAlarmActive = true;
      chrome.storage.session.set(updates, () => {
        refreshBadge();
        if (activate) {
          console.warn("TDX Notifier:", fails, "consecutive checks failed — sounding failure alarm");
          playAlertSound();
        }
      });
    }
  );
}

// ─── Message bus ──────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const privileged = isPrivilegedSender(sender);

  switch (msg && msg.action) {
    case "startWatcher":
      if (!privileged) { sendResponse({ ok: false, error: "unauthorized" }); return false; }
      startWatcher(msg.settings, msg.tabId).then(sendResponse);
      return true;

    case "stopWatcher":
      if (!privileged) { sendResponse({ ok: false, error: "unauthorized" }); return false; }
      stopWatcher().then(() => sendResponse({ ok: true }));
      return true;

    case "getStatus":
      if (!privileged) { sendResponse({ ok: false, error: "unauthorized" }); return false; }
      chrome.alarms.get(POLL_ALARM, (alarm) => {
        chrome.storage.session.get(
          ["watchedTabId", "ticketAlarmActive", "failureAlarmActive",
           "failureAcknowledged", "consecutiveFailures", "lastTruncated"],
          (st) => {
            const degraded = !!(st.failureAlarmActive ||
                                (st.consecutiveFailures || 0) >= FAILURE_ALARM_THRESHOLD ||
                                st.lastTruncated);
            sendResponse({
              running:             !!alarm,
              watchedTabId:        st.watchedTabId || null,
              alarmActive:         !!(st.ticketAlarmActive || st.failureAlarmActive),
              ticketAlarmActive:   !!st.ticketAlarmActive,
              failureAlarmActive:  !!st.failureAlarmActive,
              degraded:            degraded,
              failureAcknowledged: !!st.failureAcknowledged,
              consecutiveFailures: st.consecutiveFailures || 0,
              lastTruncated:       !!st.lastTruncated
            });
          }
        );
      });
      return true;

    case "silenceAlarm":
      if (!privileged) { sendResponse({ ok: false, error: "unauthorized" }); return false; }
      silenceAlarm();
      sendResponse({ ok: true });
      return false;

    case "soundSettingsChanged":
      if (!privileged) { sendResponse({ ok: false, error: "unauthorized" }); return false; }
      chrome.storage.local.get(["settings"], ({ settings }) => {
        const s = {
          ...DEFAULT_SETTINGS,
          ...(settings || {}),
          alarmSound:  sanitizeSound(msg.sound),
          alarmVolume: clampVolume(msg.volume)
        };
        chrome.storage.local.set({ settings: s });
        // If an alarm is sounding, re-ensure the offscreen document exists and
        // (re)start the loop with the new settings. Chrome may reap a silent
        // AUDIO_PLAYBACK document (e.g. volume 0), which would otherwise leave a
        // mid-alarm volume change doing nothing. playSound is idempotent — an
        // already-running loop just picks up the new sound/volume on its next tick.
        chrome.storage.session.get(
          ["ticketAlarmActive", "failureAlarmActive"],
          async ({ ticketAlarmActive, failureAlarmActive }) => {
            if (ticketAlarmActive || failureAlarmActive) {
              try { await ensureOffscreenDocument(); } catch (_) {}
              chrome.runtime.sendMessage({
                action: "playSound", sound: s.alarmSound, volume: s.alarmVolume
              }).catch(() => {});
            } else {
              chrome.runtime.sendMessage({
                action: "updateSound", sound: s.alarmSound, volume: s.alarmVolume
              }).catch(() => {});
            }
          }
        );
      });
      sendResponse({ ok: true });
      return false;

    case "requestTestSound":
      // Popup → background only. Background forwards as "playTestSound", which is
      // the ONLY test action the offscreen document handles — so the offscreen
      // document can't also receive the popup's broadcast and double-play.
      if (!privileged) { sendResponse({ ok: false, error: "unauthorized" }); return false; }
      (async () => {
        try {
          await ensureOffscreenDocument();
          chrome.runtime.sendMessage({
            action: "playTestSound",
            sound:  sanitizeSound(msg.sound),
            volume: clampVolume(msg.volume)
          }).catch(() => {});
        } catch (err) {
          console.warn("TDX Notifier: test sound failed", err && err.name ? err.name : "unknown");
        }
      })();
      sendResponse({ ok: true });
      return false;

    case "ticketsFound":
      // From the injected scanner — accept only from the watched tab on the locked
      // host, and only if the result carries the CURRENT watch session's nonce.
      // A stale result from a stopped/restarted session is discarded silently.
      chrome.storage.session.get(["watchedTabId", "watchSessionId"], ({ watchedTabId, watchSessionId }) => {
        if (!sender.tab || sender.tab.id !== watchedTabId || !isWatchedHost(sender.tab.url)) {
          console.warn("TDX Notifier: rejected ticketsFound from unexpected sender");
          return;
        }
        if (!watchSessionId || msg.sessionId !== watchSessionId) {
          console.log("TDX Notifier: discarded result from a previous watch session");
          return;
        }
        if (msg.found !== true) {
          markScanFailed(msg.diag || "unknown", msg.sessionId);
          return;
        }
        const tickets = sanitizeTickets(msg.tickets);
        if (tickets === null) {
          markScanFailed("payload_rejected", msg.sessionId);
          return;
        }
        handleSnapshot(tickets, msg.truncated === true);
      });
      return false;
  }
});

// ─── Start / Stop ─────────────────────────────────────────────────────────────
function startWatcher(rawSettings, tabId) {
  return new Promise((resolve) => {
    const interval = clampInterval(rawSettings && rawSettings.intervalMinutes);
    const groupIds = sanitizeGroupIds(rawSettings && rawSettings.groupIds);
    if (groupIds === null) {
      // No silent fallback to any department's groups: an invalid or empty selection
      // fails loudly rather than watching a queue the user never chose.
      resolve({ ok: false, error: "invalid_groups" });
      return;
    }
    const cleanSettings = {
      intervalMinutes: interval,
      groupIds:        groupIds,
      alarmSound:      sanitizeSound(rawSettings && rawSettings.alarmSound),
      alarmVolume:     clampVolume(rawSettings && rawSettings.alarmVolume)
    };

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve({ ok: false, error: "tab_not_found" });
        return;
      }
      if (!isWatchedHost(tab.url)) {
        let dest = "(unknown)";
        try { dest = new URL(tab.url).hostname; } catch {}
        console.warn("TDX Notifier: refusing to watch non-TDX tab on host:", dest);
        resolve({ ok: false, error: "not_tdx_tab" });
        return;
      }

      chrome.alarms.clear(POLL_ALARM, () => {
        chrome.storage.local.set({ settings: cleanSettings }, () => {
          chrome.storage.session.set({
            ...DEFAULT_STATE,
            watchedTabId:   tabId,
            watchSessionId: crypto.randomUUID()   // new nonce invalidates all prior in-flight results
          }, () => {
            // Starting (or restarting) a watch resets alarm state above — make the
            // AUDIO match it, or a loop from the previous watch/alarm would keep
            // sounding with no alarm state left to silence it.
            chrome.runtime.sendMessage({ action: "stopSound" }).catch(() => {});
            chrome.alarms.create(POLL_ALARM, { periodInMinutes: interval });
            setIcon(true);
            clearBadge();
            console.log("TDX Notifier: started, interval =", interval, "min");
            runPoll();             // first check runs immediately; the alarm handles the rest
            resolve({ ok: true });
          });
        });
      });
    });
  });
}

function stopWatcher() {
  return new Promise((resolve) => {
    chrome.alarms.clear(POLL_ALARM, () => {
      chrome.storage.session.set({ ...DEFAULT_STATE }, () => {
        chrome.runtime.sendMessage({ action: "stopSound" }).catch(() => {});
        setIcon(false);
        clearBadge();
        console.log("TDX Notifier: stopped");
        resolve();
      });
    });
  });
}

// ─── Poll execution ───────────────────────────────────────────────────────────
// One complete check: validate the watched tab, then inject the fetch scanner.
// Called by the periodic alarm AND once directly at watch start (Chrome 120+
// clamps alarm delays to a 30-second minimum, and earlier versions clamp them to
// a full minute — so an immediate first check must be a direct call, not a
// short one-shot alarm).
function runPoll() {
  chrome.storage.local.get(["settings"], ({ settings }) => {
    chrome.storage.session.get(["watchedTabId", "watchSessionId"], ({ watchedTabId, watchSessionId }) => {
      if (!settings || !watchedTabId || !watchSessionId) return;

      const groupIds = sanitizeGroupIds(settings.groupIds);
      if (groupIds === null) {
        console.warn("TDX Notifier: stored group selection invalid — stopping");
        stopWatcher();
        return;
      }

      chrome.tabs.get(watchedTabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          console.warn("TDX Notifier: watched tab no longer exists, stopping");
          stopWatcher();
          return;
        }
        if (!isWatchedHost(tab.url)) {
          let dest = "(unknown)";
          try { dest = new URL(tab.url).hostname; } catch {}
          console.warn("TDX Notifier: tab navigated away from", ALLOWED_HOST, "to", dest, "- stopping");
          stopWatcher();
          return;
        }
        chrome.storage.session.set({ lastCheckedAt: Date.now() });
        injectFetchScanner(watchedTabId, buildResultsUrl(groupIds), watchSessionId);
      });
    });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) runPoll();
});

// ─── Tab cleanup ──────────────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.get(["watchedTabId"], ({ watchedTabId }) => {
    if (tabId === watchedTabId) stopWatcher();
  });
});

// ─── Inject the fetch scanner ─────────────────────────────────────────────────
function injectFetchScanner(tabId, resultsUrl, sessionId) {
  chrome.tabs.get(tabId, (tab) => {
    // Defense in depth: runPoll() validated this tab moments ago, but it can close or
    // navigate in the gap between the two checks. That condition is resolved here
    // EXACTLY as runPoll() resolves it — the watcher stops — rather than returning
    // silently, which would let a monitoring attempt vanish without either ending the
    // watch or counting toward the degraded state. (stopWatcher resets all state, so
    // it is deliberately used ALONE here: a markScanFailed write racing the reset
    // could otherwise strand failure counters in an already-stopped watcher.)
    if (chrome.runtime.lastError || !tab) {
      console.warn("TDX Notifier: watched tab disappeared before injection — stopping");
      stopWatcher();
      return;
    }
    if (!isWatchedHost(tab.url)) {
      let dest = "(unknown)";
      try { dest = new URL(tab.url).hostname; } catch {}
      console.warn("TDX Notifier: watched tab left", ALLOWED_HOST, "for", dest, "before injection — stopping");
      stopWatcher();
      return;
    }
    chrome.scripting.executeScript({
      target: { tabId },
      world:  "ISOLATED",                 // make the default explicit: page JS can't see this run
      func:   fetchAndScan,
      args:   [resultsUrl, EXCLUDED_STATUSES, sessionId]
    }).catch(err => {
      console.warn("TDX Notifier: inject failed", err && err.name ? err.name : "unknown");
      markScanFailed("inject_failed", sessionId);   // nonce-scoped like every other failure
    });
  });
}

// Runs INSIDE the watched tab (works whether it's visible or hidden — fetch is not
// visibility-gated). Fetches the ticket data over the existing session, validates the
// response strictly, and builds a { id: "Status|Modified" } snapshot. The response
// format is asserted: an application/json content type with the enforced envelope
// { data: [tickets], total } — a groups property may also be present in live
// responses and is ignored; detection never reads it.
//
// STRICT validation: the entire scan is rejected (reported as a failed check, never a
// trusted partial snapshot) when the content type is not application/json, the body
// exceeds a size cap, any row lacks a valid numeric ID, StatusName or ModifiedDate is
// not a non-empty string, duplicate ticket IDs appear, the total is not a valid
// non-negative integer (a digit-only string is tolerated), or the returned row count
// exceeds the reported total.
//
// Caching: the request is sent with cache: "no-store", asking the browser not to
// read this response from, or write it to, the HTTP cache — every poll reaches the
// server, and the response body is not intentionally persisted by the browser cache.
//
// Diagnostics are METADATA ONLY — status codes, content type, byte counts, error
// names, and fixed reason codes. Response-body content is never included in any
// message or log.
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
    // Self-validate the destination even though the worker builds it: confirm it is
    // exactly the approved TDX Results endpoint over HTTPS with no embedded
    // credentials. Nothing untrusted can supply resultsUrl today; this is a guard
    // against future refactors that might route a different value here.
    {
      let u;
      try { u = new URL(resultsUrl); } catch { send(false, null, "bad_url"); return; }
      if (u.protocol !== "https:" ||
          u.hostname !== "your-tdx-host.example.edu" ||   // REPLACE — must equal ALLOWED_HOST
          u.pathname !== "/TDWorkManagement/WorkManagement/Queries/Tickets/Results" ||
          u.username || u.password) {
        send(false, null, "bad_url");
        return;
      }
    }

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
        referrerPolicy: "no-referrer",       // don't attach a Referer header
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

// ─── Handle snapshot (diff against last) ──────────────────────────────────────
// A validated scan arrived. Reset the failure counter, resolve or raise the
// degraded (orange) state, then diff for ticket changes (red). The two alarm
// states are independent: a failure alarm resolving never silences an
// unacknowledged ticket alarm, and vice versa.
//
// TRUNCATED results (server total > returned rows) take a separate path: the
// degraded state engages, but the partial page is NEVER diffed, never stored,
// and never used as a baseline — page churn at the boundary would otherwise
// manufacture false "new ticket" alarms while silently dropping whichever
// tickets slid off page one. The last trusted complete snapshot is retained,
// and comparison resumes automatically at the next complete check (which then
// diffs against that retained snapshot, so changes during the degraded window
// still surface).
function handleSnapshot(tickets, truncated) {
  chrome.storage.session.get(
    ["lastSnapshot", "baselineSet", "ticketAlarmActive", "failureAlarmActive",
     "failureAcknowledged", "lastTruncated", "alarmNewTotal", "alarmChangedTotal"],
    (st) => {
      const inView = Object.keys(tickets).length;

      if (truncated) {
        // The server was reachable and the response validated, so this is not a
        // failed check (the failure counter resets) — but it is not a successful
        // complete check either: lastSuccessfulAt is NOT stamped, and the
        // snapshot, baseline, and diff are all skipped.
        console.warn("TDX Notifier: active queue exceeds pageSize — monitoring is degraded and comparisons are paused; the last complete snapshot is retained. Narrow the group selection or raise pageSize in buildResultsUrl.");
        const updates = {
          lastScanOk:          true,
          lastSeenCount:       inView,
          consecutiveFailures: 0,
          lastTruncated:       true
        };
        let startSound = false;
        if (!st.lastTruncated) {
          // NEW degradation: the queue just crossed the monitored limit. Alarm even
          // if a previous degraded condition was acknowledged — this is a new one.
          updates.failureAlarmActive  = true;
          updates.failureAcknowledged = false;
          startSound = true;
        }
        // Already-truncated and acknowledged: stay silent, badge stays orange.
        chrome.storage.session.set(updates, () => {
          refreshBadge();
          if (startSound) playAlertSound();
        });
        return;
      }

      // Complete scan from here down.
      const updates = {
        lastScanOk:          true,
        lastSeenCount:       inView,
        lastSuccessfulAt:    Date.now(),
        consecutiveFailures: 0,
        lastTruncated:       false
      };

      let startSound = false;
      let mayStopSound = false;

      // Every degraded condition has ended.
      if (st.failureAlarmActive) {
        updates.failureAlarmActive = false;
        mayStopSound = true;          // stop audio only if no ticket alarm remains
        console.log("TDX Notifier: checks recovered — failure alarm cleared");
      }
      updates.failureAcknowledged = false;

      if (!st.baselineSet) {
        updates.lastSnapshot     = tickets;
        updates.baselineSet      = true;
        updates.lastNewCount     = 0;
        updates.lastChangedCount = 0;
        chrome.storage.session.set(updates, () => {
          refreshBadge();
          if (startSound) playAlertSound();
          else if (mayStopSound && !st.ticketAlarmActive) {
            chrome.runtime.sendMessage({ action: "stopSound" }).catch(() => {});
          }
        });
        console.log("TDX Notifier: baseline set —", inView, "tickets in view");
        return;
      }

      const prev = st.lastSnapshot || {};
      let newCount = 0, changedCount = 0;
      for (const id in tickets) {
        if (!(id in prev)) newCount++;
        else if (tickets[id] !== prev[id]) changedCount++;
      }
      // Tickets that LEFT the view (resolved / reassigned away) intentionally don't alarm.

      updates.lastSnapshot     = tickets;
      updates.lastNewCount     = newCount;
      updates.lastChangedCount = changedCount;

      if (newCount > 0 || changedCount > 0) {
        console.log("TDX Notifier: change detected —", newCount, "new,", changedCount, "updated");
        updates.ticketAlarmActive = true;
        updates.alarmNewTotal     = (st.ticketAlarmActive ? (st.alarmNewTotal     || 0) : 0) + newCount;
        updates.alarmChangedTotal = (st.ticketAlarmActive ? (st.alarmChangedTotal || 0) : 0) + changedCount;
        startSound = true;
      }

      const ticketAlarmAfter = updates.ticketAlarmActive !== undefined
        ? updates.ticketAlarmActive : st.ticketAlarmActive;

      chrome.storage.session.set(updates, () => {
        refreshBadge();
        if (startSound) {
          playAlertSound();   // volume 0 = silent mode; the generator emits nothing at 0
        } else if (mayStopSound && !ticketAlarmAfter) {
          chrome.runtime.sendMessage({ action: "stopSound" }).catch(() => {});
        }
      });
    }
  );
}

// ─── Silence ──────────────────────────────────────────────────────────────────
// Silence is the ACKNOWLEDGMENT for whatever is currently sounding:
//   - clears the ticket alarm and its cumulative counters;
//   - acknowledges (mutes) an active failure alarm WITHOUT erasing the failure
//     history — consecutiveFailures and lastTruncated are untouched, the badge
//     stays orange while degraded, and only a successful complete check resets
//     the counter and re-arms the failure alarm.
function silenceAlarm() {
  chrome.storage.session.get(["failureAlarmActive"], ({ failureAlarmActive }) => {
    const updates = {
      ticketAlarmActive: false,
      alarmNewTotal: 0,
      alarmChangedTotal: 0
    };
    if (failureAlarmActive) {
      updates.failureAlarmActive  = false;
      updates.failureAcknowledged = true;
    }
    chrome.storage.session.set(updates, () => {
      chrome.runtime.sendMessage({ action: "stopSound" }).catch(() => {});
      refreshBadge();
      console.log("TDX Notifier: silenced");
    });
  });
}

// ─── Audio via Offscreen API ──────────────────────────────────────────────────
// Shared-promise creation guard: two near-simultaneous callers (e.g. a detection
// and a settings change) must not both call createDocument — the second call
// would reject. Whoever arrives second awaits the first caller's promise.
let offscreenCreating = null;
async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length > 0) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url:           "offscreen.html",
      reasons:       ["AUDIO_PLAYBACK"],
      justification: "Play alarm tones when TDX tickets are added or changed"
    }).finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
}

async function playAlertSound() {
  try {
    await ensureOffscreenDocument();
    chrome.storage.local.get(["settings"], ({ settings }) => {
      const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
      chrome.runtime.sendMessage({
        action: "playSound",
        sound:  sanitizeSound(s.alarmSound),
        volume: clampVolume(s.alarmVolume)
      }).catch(() => {});
    });
  } catch (err) {
    console.warn("TDX Notifier: sound failed", err && err.name ? err.name : "unknown");
  }
}
