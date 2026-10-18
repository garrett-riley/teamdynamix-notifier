# Privacy Policy — TeamDynamix Notifier

**Version:** 1.2.8 · **Applies to:** the TeamDynamix Notifier Chrome extension (single configured TDX host; shown here as the placeholder `your-tdx-host.example.edu`)

## Summary

TeamDynamix Notifier collects **no data for the developer or any third party**. It has no server, no analytics, no telemetry, and no external services of any kind. Its entire function is local to your browser: once per polling interval it asks your organization's TDX server — using your own already-logged-in session — for a minimal, filtered list of active tickets in the groups you selected, holds that list in memory until the next check, and plays a local sound if anything is new or changed. The ticket snapshot and all monitoring state are kept in session-only storage: they are cleared when the watcher is stopped, when the browser closes, or on uninstall. Only user settings (interval, groups, sound, volume) are kept on the device between browser sessions. Updating from a version older than 1.2.0 removes any operational data those versions stored on disk.

## 1. Data collected by the developer

**None.** No usage data, no identifiers, no crash reports, no analytics events. There is no infrastructure that could receive such data — the extension contains no network destination other than your organization's own TDX host.

## 2. Data the extension requests from TDX

Once per polling interval (user-configured, 1–60 minutes; default 1), the extension sends a single HTTPS GET to the TDX Results endpoint on `your-tdx-host.example.edu` — the same endpoint the TDX dashboard itself calls. The request is sent with `cache: "no-store"`, asking Chrome not to satisfy it from, or write the response to, the browser's HTTP cache. The request is deliberately minimized in two dimensions:

- **Fields:** the request asks TDX to populate only three ticket values — **ticket ID, status name, and last-modified date**. Ticket titles, requestor names, department/account names, priorities, and responsible-party identities are not requested; in live testing (July 2026), the TDX server returned unrequested properties as `null`. The extension does not intentionally store the raw response: it requests that the browser not cache it (`cache: "no-store"`), holds it in memory only while it is parsed, and retains only the minimized three-value fingerprint per ticket in extension session storage.
- **Rows:** the request is filtered server-side to the responsible groups the user selected and to **active statuses only** (Resolved, Closed, and Cancelled tickets are excluded by the server and never transmitted).

This is verifiable in Chrome DevTools (Network → the extension's `Results` request → Payload/Preview tabs); the technical design document includes step-by-step verification instructions.

## 3. Data stored on the device

All storage is local to the user's browser and consists of:

| Item | Contents | Lifetime |
|---|---|---|
| Last snapshot | Chrome session storage (memory-backed) — ticket IDs → "status \| modified-date" strings for the active queue | Replaced at each successful complete check (retained across failed or over-limit checks; a truncated page is never stored); cleared on Stop Watching, closing the watched tab, closing the browser, or uninstall |
| Settings | Chrome local storage (device) — polling interval, selected group IDs, alarm sound, volume | Until the user changes them; deleted on uninstall |
| Status fields | Chrome session storage (memory-backed) — timestamps/counters for the popup display (last check time, ticket counts, alarm and failure state) | Overwritten continuously; cleared on Stop Watching, browser close, or uninstall |

Ticket data is held only in Chrome's session storage, which is memory-backed and cleared when the browser closes — it is not written to the extension's disk-backed storage or to Chrome sync. Ticket snapshots are not transmitted to the developer, analytics providers, or third parties; the extension's requests go to your organization's TeamDynamix service and, like all traffic to it, may be logged by TeamDynamix, organizational network infrastructure, endpoint-security tools, or other systems governed by organizational policy. The extension does not intentionally persist the raw server response: it is held in memory while parsed, and the request asks the browser not to cache it. (User settings, which contain no ticket data, are the only values the extension keeps in disk-backed profile storage; updating from a pre-1.2.0 version deletes the operational keys those versions wrote there.)

## 4. Credentials and authentication

This version does not call the Cookies API, read `document.cookie`, or inspect authentication tokens, and it never stores or transmits credentials. Its data request is same-origin from the user's own logged-in TDX tab; the browser attaches the existing session automatically, exactly as it does for the TDX page's own requests. If the session expires, the extension's checks simply fail (shown as a failed check in its popup) until the user logs into TDX again — it has no ability to authenticate on its own.

## 5. Network behavior

- Each check makes **one direct HTTPS GET** to `your-tdx-host.example.edu`, sent with `cache: "no-store"`, which instructs Chrome not to use or populate its HTTP cache for the request. The extension does not interact with the TDX page (the cosmetic dashboard-refresh click was removed in v1.2.4), so it originates no other requests; the watched TDX page may still issue its own traffic — for example its widgets' built-in auto-refresh — likewise to `your-tdx-host.example.edu` only.
- Redirects are refused (`redirect: "error"`), so the request chain cannot leave that host even if the server attempts to redirect (e.g., to a sign-on page after session expiry).
- The manifest declares privileged host access only for `https://your-tdx-host.example.edu/*`, and this version's code contains no network destination outside that host.
- There is no other network activity in the extension's code — no analytics, telemetry, or third-party destinations.

## 6. Permissions

| Permission | Why it is needed |
|---|---|
| `alarms` | Schedule the periodic check (survives the service worker's normal sleep cycle) |
| `storage` | Persist user settings and the latest snapshot locally |
| `scripting` | Run the data check inside the user's own TDX tab, so the request is first-party |
| `offscreen` | Play the alarm sound from a background context (Chrome service workers cannot play audio) |
| Host: `your-tdx-host.example.edu` only | The single site the extension operates on; it cannot function on, or access, any other |

Notably absent: the broad `tabs` permission, notifications, downloads, cookies, history, and all other browser-data permissions. The extension still uses the Tabs API to identify the active tab and re-validate the watched tab — Chrome permits this without the `tabs` permission — but sensitive tab properties (URL, title) are visible to it only for the declared TDX host.

## 7. Logging

Diagnostic messages appear only in the extension's own service-worker console (visible solely to the user via `chrome://extensions`) and are metadata-only: HTTP status codes, content types, byte counts, error names (e.g. `AbortError`), and fixed reason codes. Response-body content is never logged. If the watched tab navigates away, only the destination *hostname* is logged, never full URLs. Nothing is logged off-device.

## 8. User control and data deletion

- **Stop Watching** (in the popup) immediately clears the snapshot and all monitoring state.
- **Closing the browser** clears the snapshot and all monitoring state automatically (session storage does not survive a restart; the watcher starts idle and must be started again).
- **Uninstalling the extension** deletes everything, including settings — Chrome removes an extension's storage on uninstall.
- The extension transmits nothing off the device, so there is nothing of its creation to delete elsewhere. (Ordinary device- or profile-level backups configured outside the extension are, like all local software, outside its control.)

## 9. Third parties

None. No third-party services, libraries with network behavior, fonts, CDNs, analytics, or advertising. The extension's code is fully self-contained and human-readable (plain JavaScript, no build step), and the complete source is available for inspection in the repository.

## 10. Changes to this policy

Material changes to what the extension accesses or stores will be reflected in this document and in the extension's version notes before release.

## Contact

Garrett Riley · via the repository's GitHub Issues page.
