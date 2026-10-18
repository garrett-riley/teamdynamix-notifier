// TeamDynamix Notifier — shared configuration.
//
// This file is the SINGLE source of truth for values used by BOTH the service
// worker and the popup. It is loaded two ways:
//   • background.js: importScripts("groups.js")  (MV3 service workers are classic
//     workers by default, so importScripts is available; this would become a static
//     `import` if the worker is ever switched to "type": "module")
//   • popup.html:    <script src="groups.js"></script>  before popup.js
//
// Both loaders share one global scope with their consumer, so these plain `const`
// declarations are visible to background.js and popup.js respectively — no exports.
//
// Values used by only ONE context (e.g. the worker's status-ID exclusions, row cap,
// badge colors, and icon paths) deliberately stay in that file; only genuinely shared
// values live here.

// ─── Watched host ─────────────────────────────────────────────────────────────
const ALLOWED_HOST = "your-tdx-host.example.edu";   // REPLACE with your TDX host
// (also update manifest.json host_permissions and the hostname check in
// background.js fetchAndScan, which must match this value exactly)

// ─── Polling interval bounds (minutes) ────────────────────────────────────────
const MIN_INTERVAL_MIN = 1;
const MAX_INTERVAL_MIN = 60;

// ─── Failure alarm threshold ──────────────────────────────────────────────────
// Consecutive failed checks before the monitoring-failure alarm engages.
const FAILURE_ALARM_THRESHOLD = 3;

// ─── Approved TDX responsible groups (ID → display name) ─────────────────────
// ⚠ REDACTED FOR PUBLIC RELEASE — replace these placeholders before use.
// This table is the complete approved set; the service worker's allowlist
// derives from it, so a group not listed here cannot be watched. Group IDs are
// instance-specific: capture them from your TDX dashboard's own Results request
// (DevTools → Network → Results → Payload → filters → ResponsibleGroupName
// argument). Only list queues your users are authorized to monitor, and follow
// your organization's approval process before adding more. See README.md.
const GROUPS = {
  100001: "Example Group A",   // REPLACE: <TDX group ID>: "<group display name>"
  100002: "Example Group B",   // REPLACE
  100003: "Example Group C"    // REPLACE
};
