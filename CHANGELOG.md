# Changelog

All notable changes to "Copilot Tracker Ent" are documented here, following [Keep a Changelog](https://keepachangelog.com/).

## [1.0.0] - 2026-11-05

### Added

- Local usage history in SQLite (`node:sqlite`), shared by all VS Code windows. A row is stored only when usage changes, with the delta since the previous one.
- Credits-per-day and credits-per-15-minutes spike charts under the Month and Today timelines.
- Remaining-budget trend charts for the month and for today, with the ideal line.
- Planning days off: click or drag across days in the month chart to switch them on or off or set a part-day workload. The budget is redistributed accordingly.
- Plan controls: From and To dates and a Budget, defaulting to the whole month and the full limit, with **Reset to today** for a fresh start with the remaining credits.
- `copilotTrackerEnt.refreshIntervalMinutes` setting (default 5).

### Changed

- Refreshes are coordinated across windows: only one window calls GitHub per interval, and never more than once every 15 seconds, including manual refreshes.
- The daily allowance follows the plan and its weighted workdays instead of the month's Monday-to-Friday count.
- The panel keeps its state (plan form, selected days) across refreshes.
- Panel layout: the plan form (From, To, Budget, with the reset buttons on a second line) moved to the bottom, the title is gone, and Refresh, Re-authenticate and Logs are in a menu at the top right.

## [0.2.1] - 2026-10-20

### Changed

- New extension icon and display name ("Copilot Tracker (Enterprise)").
- The log now records only the plan and quota fields from `copilot_internal/user`, not the full response (which includes account identifiers).

## [0.2.0] - 2026-10-20

First release of Copilot Tracker Ent, an enterprise-only departure from the fork it started as.

### Added

- Status bar item with a coloured circle, the share of monthly credits used and how you stand against the daily allowance: `🟢 59% (+34 [455])`.
- Details panel with a Month timeline and a Today timeline, each with an arrow at credits used, a line for today and a legend.
- Panel toolbar with Refresh, Re-authenticate and Logs buttons, and matching commands.
- "Copilot Tracker Ent" output channel that logs each GitHub request (status, duration, request id; tokens are never logged).

### Changed

- Usage now comes from the Copilot quota endpoint VS Code itself uses (`copilot_internal/user`), so it works for enterprise-managed accounts.
- Only the `read:user` scope is requested, which VS Code already holds.
- Month progress counts workdays (Monday to Friday) instead of calendar days.
- Refreshes every 15 minutes.

### Removed

- The billing API calls, the 12-month history and the per-model breakdown from the original, which enterprise-managed accounts cannot access.
