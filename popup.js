const intervalEl     = document.getElementById("interval");
const mainBtn        = document.getElementById("mainBtn");
const silenceBtn     = document.getElementById("silenceBtn");
const statusEl       = document.getElementById("status");
const statusDetailEl = document.getElementById("statusDetail");
const dot            = document.getElementById("dot");
const groupListEl    = document.getElementById("groupList");
const groupSectionEl = document.getElementById("groupSection");
const alarmSoundEl   = document.getElementById("alarmSound");
const volumeEl       = document.getElementById("volume");
const testBtn        = document.getElementById("testBtn");

// ALLOWED_HOST, MIN_INTERVAL_MIN, MAX_INTERVAL_MIN, FAILURE_ALARM_THRESHOLD, and
// GROUPS come from groups.js (loaded by a <script> tag before this file) — the
// single source of truth shared with background.js.


let isRunning      = false;
let currentTabId   = null;
let detailInterval = null;   // live "Xs ago" ticker while the popup is open

// ─── Group picker ────────────────────────────────────────────────────────────
// Checkboxes are built with createElement/textContent (never innerHTML) per the
// project's self-XSS convention, even though names here are a local constant.
function renderGroupList(selectedIds) {
  const selected = new Set(selectedIds);
  while (groupListEl.firstChild) groupListEl.removeChild(groupListEl.firstChild);
  const ids = Object.keys(GROUPS).map(Number).sort((a, b) => GROUPS[a].localeCompare(GROUPS[b]));
  for (const id of ids) {
    const label = document.createElement("label");
    label.className = "group-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = String(id);
    cb.checked = selected.has(id);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(GROUPS[id]));
    groupListEl.appendChild(label);
  }
  // Saved IDs outside the approved table are dropped: only approved groups render,
  // and the worker's allowlist would reject anything else regardless.
}

// Collect checked boxes. Selection is limited to the approved groups rendered from
// GROUPS (shared with the worker's allowlist) — there is no free-entry field.
function collectGroupIds() {
  const ids = new Set();
  groupListEl.querySelectorAll("input[type=checkbox]:checked")
    .forEach(cb => ids.add(Number(cb.value)));
  return [...ids];
}

function setGroupSectionLocked(locked) {
  groupSectionEl.classList.toggle("locked", locked);
  groupSectionEl.disabled = locked;   // fieldset: also blocks keyboard interaction, not just pointer
  document.getElementById("groupHint").textContent = locked
    ? "Stop watching to change groups."
    : "Changes apply when you start watching.";
}

// ─── Load saved settings ────────────────────────────────────────────────────
chrome.storage.local.get(["settings"], ({ settings }) => {
  if (settings) {
    intervalEl.value = clampInterval(settings.intervalMinutes);
    if (typeof settings.alarmSound === "string") alarmSoundEl.value = settings.alarmSound;
    if (Number.isFinite(settings.alarmVolume)) {
      volumeEl.value = Math.round(Math.min(1, Math.max(0, settings.alarmVolume)) * 100);
    }
  }
  // Fresh install: no boxes pre-checked, so no department inherits another's defaults.
  // Once the user starts watching, their selection is saved and restored on reopen.
  const saved = (settings && Array.isArray(settings.groupIds)) ? settings.groupIds : [];
  renderGroupList(saved);
});

// ─── Determine current tab + watcher state ──────────────────────────────────
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (!tabs[0]) return;
  currentTabId = tabs[0].id;

  chrome.runtime.sendMessage({ action: "getStatus" }, (resp) => {
    if (resp?.running && resp?.watchedTabId === currentTabId) {
      setRunning(true);          // ends by calling refreshPresentation()
      refreshStatusDetail();
    } else if (resp?.running && resp?.watchedTabId !== currentTabId) {
      setRunning(false);
      statusEl.textContent = "⚠ Watching a different tab — starting here will switch the watcher.";
      statusEl.className   = "status warn";
    } else {
      setRunning(false);
    }
  });
});

// ─── Main watch / stop button ────────────────────────────────────────────────
mainBtn.addEventListener("click", () => {
  if (isRunning) {
    chrome.runtime.sendMessage({ action: "stopWatcher" }, () => {
      setRunning(false);
    });
    return;
  }

  const interval = clampInterval(intervalEl.value);
  intervalEl.value = interval;

  const groupIds = collectGroupIds();
  if (groupIds.length === 0) {
    statusEl.textContent = "⚠ Select at least one group to watch.";
    statusEl.className   = "status warn";
    return;
  }

  const settings = {
    intervalMinutes: interval,
    groupIds:        groupIds,
    alarmSound:      alarmSoundEl.value,
    alarmVolume:     parseInt(volumeEl.value, 10) / 100
  };

  chrome.runtime.sendMessage(
    { action: "startWatcher", settings, tabId: currentTabId },
    (resp) => {
      if (!resp || resp.ok === false) {
        const reason = resp && resp.error;
        statusEl.textContent =
            (reason === "not_tdx_tab")   ? `⚠ This tab is not ${ALLOWED_HOST}. Open TeamDynamix first.`
          : (reason === "invalid_groups") ? "⚠ Group selection invalid — re-select and try again."
          : "⚠ Could not start watcher.";
        statusEl.className = "status warn";
        return;
      }
      setRunning(true);
      refreshStatusDetail();
    }
  );
});

// ─── Sound preference saves immediately on toggle ───────────────────────────
// Background will also stop any in-progress alarm sound when this is disabled.
// ─── Alarm sound + volume save immediately ──────────────────────────────────
// `input` on the slider fires per pixel of drag; that's fine — the messages are
// cheap, and a live drag during an alarm should reflect on the next loop tick.
alarmSoundEl.addEventListener("change", sendSoundSettings);
volumeEl.addEventListener("input", sendSoundSettings);

function sendSoundSettings() {
  chrome.runtime.sendMessage({
    action: "soundSettingsChanged",
    sound:  alarmSoundEl.value,
    volume: parseInt(volumeEl.value, 10) / 100
  });
}

// ─── Test sound button ──────────────────────────────────────────────────────
testBtn.addEventListener("click", () => {
  // Push the latest settings first — covers the (unlikely) race where the user
  // clicks Test before the slider's input event has propagated.
  sendSoundSettings();
  chrome.runtime.sendMessage({
    action: "requestTestSound",   // background forwards as "playTestSound" — the only
    sound:  alarmSoundEl.value,   // test action the offscreen document handles, so the
    volume: parseInt(volumeEl.value, 10) / 100   // popup's broadcast can't double-play
  });
});

// ─── Silence button ──────────────────────────────────────────────────────────
silenceBtn.addEventListener("click", () => {
  // The worker clears/acknowledges alarm state; presentation follows from the
  // resulting storage events. The explicit refresh covers the message round-trip.
  chrome.runtime.sendMessage({ action: "silenceAlarm" }, () => refreshPresentation());
});

// ─── React to state changes via storage events ──────────────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" && area !== "local") return;
  if ("ticketAlarmActive"   in changes || "failureAlarmActive" in changes ||
      "consecutiveFailures" in changes || "lastTruncated"      in changes) {
    // Presentation is a function of the full alarm/degradation state — re-read
    // it rather than trusting any single changed key.
    refreshPresentation();
  }
  if ("alarmNewTotal"      in changes || "alarmChangedTotal"   in changes ||
      "failureAlarmActive" in changes || "consecutiveFailures" in changes ||
      "lastTruncated"      in changes) {
    updateAlarmText();
  }
  if ("lastCheckedAt"    in changes || "lastSeenCount"    in changes ||
      "lastScanOk"       in changes || "baselineSet"      in changes ||
      "lastNewCount"     in changes || "lastChangedCount" in changes ||
      "lastTruncated"    in changes || "lastSuccessfulAt" in changes) {
    refreshStatusDetail();
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function clampInterval(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return MIN_INTERVAL_MIN;
  return Math.min(MAX_INTERVAL_MIN, Math.max(MIN_INTERVAL_MIN, n));
}

function formatTimeAgo(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60)  return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60)  return `${min}m ago`;
  const hr = Math.round(min / 60);
  return `${hr}h ago`;
}

function refreshStatusDetail() {
  if (!isRunning) {
    statusDetailEl.textContent = "";
    return;
  }
  chrome.storage.session.get(
    ["lastCheckedAt", "lastSuccessfulAt", "lastSeenCount", "lastScanOk", "baselineSet", "lastTruncated"],
    (data) => {
      if (!data.lastCheckedAt) {
        statusDetailEl.textContent = "Awaiting first check…";
        return;
      }
      // Principal status is the last SUCCESSFUL check — lastCheckedAt only marks
      // when a poll was attempted, not that it completed or validated.
      if (data.lastScanOk === false) {
        const attempt = formatTimeAgo(Date.now() - data.lastCheckedAt);
        const success = data.lastSuccessfulAt
          ? ` · Last successful check ${formatTimeAgo(Date.now() - data.lastSuccessfulAt)}`
          : "";
        statusDetailEl.textContent =
          `Last attempt ${attempt} — failed (will retry; if this persists, log into TDX)${success}`;
      } else {
        const ago  = formatTimeAgo(Date.now() - (data.lastSuccessfulAt ?? data.lastCheckedAt));
        const note = data.baselineSet ? "" : " (setting baseline)";
        const cnt  = data.lastSeenCount ?? 0;
        const trunc = data.lastTruncated ? " — ⚠ over page limit, some tickets unmonitored" : "";
        statusDetailEl.textContent =
          `Last successful check ${ago} — ${cnt} ticket${cnt === 1 ? "" : "s"} in view${note}${trunc}`;
      }
    }
  );
}

// ─── UI state ────────────────────────────────────────────────────────────────
function setRunning(running) {
  isRunning = running;

  if (running) {
    mainBtn.textContent  = "Stop Watching";
    mainBtn.className    = "btn btn-stop";
    setGroupSectionLocked(true);
    refreshStatusDetail();
    refreshPresentation();   // healthy / degraded / alarming, from stored state
    // Live-tick the "Xs ago" line every second while the popup is open.
    if (!detailInterval) detailInterval = setInterval(refreshStatusDetail, 1000);
  } else {
    dot.classList.remove("active", "alarming", "degraded");
    mainBtn.textContent  = "Watch This Tab";
    mainBtn.className    = "btn btn-start";
    statusEl.textContent = "";
    statusEl.className   = "status";
    statusDetailEl.textContent = "";
    silenceBtn.style.display = "none";
    setGroupSectionLocked(false);
    if (detailInterval) { clearInterval(detailInterval); detailInterval = null; }
  }
}

function alarmSummary(nNew, nUpd) {
  const parts = [];
  if (nNew > 0) parts.push(`${nNew} new`);
  if (nUpd > 0) parts.push(`${nUpd} updated`);
  return parts.length ? parts.join(", ") : "Ticket change";
}

function updateAlarmText() {
  chrome.storage.session.get(
    ["alarmNewTotal", "alarmChangedTotal", "failureAlarmActive", "consecutiveFailures", "lastTruncated"],
    (d) => {
      if (!dot.classList.contains("alarming")) return;   // alarm ended while we fetched
      if (d.failureAlarmActive) {
        // Failure transparency outranks change notification in the status line too.
        if ((d.consecutiveFailures || 0) > 0) {
          const n = d.consecutiveFailures;
          statusEl.textContent =
            `🚨 Monitoring is failing — last ${n} check${n === 1 ? "" : "s"} failed!`;
        } else if (d.lastTruncated) {
          statusEl.textContent =
            "🚨 Queue exceeds the monitored limit — some tickets are NOT monitored!";
        } else {
          statusEl.textContent = "🚨 Monitoring problem detected!";
        }
        return;
      }
      statusEl.textContent =
        `🚨 ${alarmSummary(d.alarmNewTotal || 0, d.alarmChangedTotal || 0)} detected — alarm sounding!`;
    }
  );
}

// ─── Presentation: alarming / degraded / healthy ─────────────────────────────
// Three independent dimensions (running, monitoring health, audio state) render
// as one of three looks while running. Crucially, an ACKNOWLEDGED monitoring
// problem stays visibly amber — silencing the audio never restores the healthy
// green presentation until a complete successful check has actually occurred.
function refreshPresentation() {
  if (!isRunning) return;    // the stopped look is handled by setRunning(false)
  chrome.storage.session.get(
    ["ticketAlarmActive", "failureAlarmActive", "consecutiveFailures", "lastTruncated"],
    (d) => {
      const alarming = !!(d.ticketAlarmActive || d.failureAlarmActive);
      const degraded = !!(d.failureAlarmActive ||
                          (d.consecutiveFailures || 0) >= FAILURE_ALARM_THRESHOLD ||
                          d.lastTruncated);
      if (alarming)      applyAlarming();
      else if (degraded) applyDegraded(d);
      else               applyHealthy();
    }
  );
}

function applyAlarming() {
  dot.classList.remove("active", "degraded");
  dot.classList.add("alarming");
  silenceBtn.style.display = "block";
  statusEl.className       = "status alarming";
  updateAlarmText();
}

function applyDegraded(d) {
  dot.classList.remove("active", "alarming");
  dot.classList.add("degraded");
  silenceBtn.style.display = "none";
  statusEl.className       = "status warn";
  if ((d.consecutiveFailures || 0) > 0) {
    const n = d.consecutiveFailures;
    statusEl.textContent =
      `⚠ Monitoring problem acknowledged — audio muted; last ${n} check${n === 1 ? "" : "s"} failed.`;
  } else if (d.lastTruncated) {
    statusEl.textContent =
      "⚠ Acknowledged — queue exceeds the monitored limit; some tickets are NOT monitored.";
  } else {
    statusEl.textContent = "⚠ Monitoring problem acknowledged — monitoring remains degraded.";
  }
}

function applyHealthy() {
  dot.classList.remove("alarming", "degraded");
  dot.classList.add("active");
  silenceBtn.style.display = "none";
  statusEl.textContent = "● Checking for ticket changes…";
  statusEl.className   = "status active";
}

// ─── Version tag ─────────────────────────────────────────────────────────────
// Read live from the manifest so it can never drift from the packaged version.
document.getElementById("versionTag").textContent =
  "v" + chrome.runtime.getManifest().version;
