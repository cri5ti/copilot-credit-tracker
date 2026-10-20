# Changelog

All notable changes to "Copilot Tracker Ent" are documented here, following [Keep a Changelog](https://keepachangelog.com/).

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
