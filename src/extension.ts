import * as vscode from 'vscode';
import {
    DailyBudget,
    PaceStatus,
    Timeline,
    WorkdayProgress,
    calculateUsagePercentage,
    getDailyBudget,
    getDayTimeline,
    getMonthTimeline,
    getWorkdayProgress
} from './usage';

let statusBarItem: vscode.StatusBarItem;
let detailsPanel: vscode.WebviewPanel | undefined;
let outputChannel: vscode.OutputChannel;

const GITHUB_API_TIMEOUT_MS = 15000;
const REFRESH_INTERVAL_MS = 1000 * 60 * 15;
// Same scope VS Code's own Copilot features already hold, so no extra consent prompt.
const GITHUB_SCOPES = ['read:user'];
const MAX_LOGGED_QUOTA_BODY_LENGTH = 2000;
const MAX_LOGGED_BODY_LENGTH = 500;

// Cache these values globally so the Webview panel can read them instantly.
let cachedWorkdays: WorkdayProgress = { elapsed: 0, total: 0 };
let cachedTotalUsed: number = 0;
let cachedLimit: number = 7000;
let lastRefreshSummary = 'Not refreshed yet.';

const STATUS_COLORS: Record<PaceStatus, string> = { under: '#4caf50', on_pace: '#e0a800', over: '#f44336' };
const PACE_ICONS: Record<PaceStatus, string> = { under: '🟢', on_pace: '🟡', over: '🔴' };

function formatCredits(value: number): string {
    return Math.round(value).toLocaleString('en-US');
}

function describeBudget(budget: DailyBudget): { badge: string; message: string } {
    switch (budget.status) {
        case 'over':
            return { badge: `-${formatCredits(budget.amount)} [${formatCredits(budget.perDay)}]`, message: `${formatCredits(budget.amount)} credits over` };
        case 'under':
            return { badge: `+${formatCredits(budget.amount)} [${formatCredits(budget.perDay)}]`, message: `${formatCredits(budget.amount)} credits ahead` };
        case 'on_pace':
            return { badge: `${formatCredits(budget.amount)} / ${formatCredits(budget.perDay)}`, message: `${formatCredits(budget.amount)} credits today` };
    }
}

function log(message: string, error?: unknown): void {
    const timestamp = new Date().toISOString();
    const detail = error === undefined
        ? ''
        : ` | ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
    outputChannel?.appendLine(`[${timestamp}] ${message}${detail}`);
}

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Copilot Tracker Ent');
    context.subscriptions.push(outputChannel);
    log(`Activated (extension version ${context.extension.packageJSON.version}).`);
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    context.subscriptions.push(statusBarItem);

    const showPanelCommandId = 'copilot-tracker-ent.showPanel';

    context.subscriptions.push(vscode.commands.registerCommand(showPanelCommandId, async () => {
        await showDetailsPanel();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('copilot-tracker-ent.showLog', () => {
        outputChannel.show(true);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('copilot-tracker-ent.refresh', async () => {
        await updateStatusBar();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('copilot-tracker-ent.reauthenticate', async () => {
        await reauthenticate();
    }));

    statusBarItem.command = showPanelCommandId;
    void updateStatusBar();

    const intervalHandle = setInterval(() => {
        void updateStatusBar();
    }, REFRESH_INTERVAL_MS);

    context.subscriptions.push({
        dispose: () => clearInterval(intervalHandle)
    });
}

async function updateStatusBar(): Promise<void> {
    try {
        log('Refreshing status bar.');
        cachedWorkdays = getWorkdayProgress();
        const status = await fetchCopilotData();
        lastRefreshSummary = `${new Date().toLocaleTimeString()}: ${describeStatus(status)}`;
        log(`Refresh result: ${status}.`);

        if (status === 'not_logged_in') {
            statusBarItem.text = '$(github) GHCP: Auth Required';
            statusBarItem.tooltip = 'Click to open the panel, then use Re-authenticate.';
            statusBarItem.color = '#ffcc00';
        } else if (status === 'api_error') {
            statusBarItem.text = '$(error) GHCP: API Error';
            statusBarItem.tooltip = 'GitHub request failed. Click to open the panel and use Logs.';
            statusBarItem.color = '#ff4d4d';
        } else {
            const usagePercentage = calculateUsagePercentage(cachedTotalUsed, cachedLimit);
            const budget = getDailyBudget(cachedTotalUsed, cachedLimit, cachedWorkdays);
            const { badge, message } = describeBudget(budget);

            statusBarItem.text = `${PACE_ICONS[budget.status]} ${usagePercentage.toFixed(0)}% (${badge})`;
            statusBarItem.tooltip = `${message}; ${formatCredits(budget.perDay)} credits per day
${formatCredits(cachedTotalUsed)} of ${formatCredits(cachedLimit)} credits used (${usagePercentage.toFixed(1)}%), workday ${cachedWorkdays.elapsed} of ${cachedWorkdays.total}. Click for details.`;
            statusBarItem.color = undefined;
        }

        statusBarItem.show();
    } catch (error) {
        lastRefreshSummary = `${new Date().toLocaleTimeString()}: unexpected error (see Logs).`;
        log('Failed to update status bar.', error);
    }

    if (detailsPanel) {
        await renderDetailsPanel(detailsPanel);
    }
}

function describeStatus(status: 'success' | 'not_logged_in' | 'api_error'): string {
    switch (status) {
        case 'success':
            return 'usage loaded.';
        case 'not_logged_in':
            return 'not signed in to GitHub.';
        case 'api_error':
            return 'GitHub request failed (see Logs).';
    }
}

async function reauthenticate(): Promise<void> {
    log('Re-authentication requested.');
    try {
        const session = await vscode.authentication.getSession('github', GITHUB_SCOPES, {
            forceNewSession: { detail: 'Sign in again to refresh the GitHub token used by Copilot Tracker Ent.' }
        });
        log(`Re-authentication finished for "${session.account.label}" with scopes [${session.scopes.join(', ')}].`);
    } catch (error) {
        log('Re-authentication cancelled or failed.', error);
        lastRefreshSummary = `${new Date().toLocaleTimeString()}: re-authentication cancelled or failed.`;
        if (detailsPanel) {
            await renderDetailsPanel(detailsPanel);
        }
        return;
    }

    await updateStatusBar();
}

async function fetchCopilotData(): Promise<'success' | 'not_logged_in' | 'api_error'> {
    const session = await vscode.authentication.getSession('github', GITHUB_SCOPES, { createIfNone: false });

    if (!session) {
        log('No GitHub session found; sign-in required.');
        vscode.window.showInformationMessage('Please sign in to GitHub to track Copilot credits.', 'Sign In').then(selection => {
            if (selection === 'Sign In') {
                void vscode.authentication.getSession('github', GITHUB_SCOPES, { createIfNone: true });
            }
        });
        return 'not_logged_in';
    }

    log(`GitHub session found for "${session.account.label}" with scopes [${session.scopes.join(', ')}].`);

    cachedLimit = determinePlanLimit();

    const quota = await fetchCopilotQuota(session.accessToken);
    if (!quota) {
        return 'api_error';
    }

    cachedTotalUsed = quota.used;
    if (quota.limit > 0) {
        cachedLimit = quota.limit;
    }
    log(`Quota: used ${quota.used} of ${quota.limit || 'unknown'} (source: ${quota.source}).`);

    return 'success';
}

type CopilotQuota = { used: number; limit: number; source: string };

// The API sends these as numbers or numeric strings; an entitlement of -1 means unlimited.
type QuotaSnapshot = {
    credits_used?: number | string;
    entitlement?: number | string;
    remaining?: number | string;
    percent_remaining?: number | string;
    unlimited?: boolean;
};

async function fetchCopilotQuota(accessToken: string): Promise<CopilotQuota | null> {
    try {
        const response = await fetchWithTimeout('https://api.github.com/copilot_internal/user', {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/json'
            }
        });

        if (!response.ok) {
            await logHttpFailure('GET copilot_internal/user', response);
            return null;
        }

        const bodyText = await response.text();
        log(`copilot_internal/user body: ${bodyText.slice(0, MAX_LOGGED_QUOTA_BODY_LENGTH)}`);

        const quota = parseCopilotQuota(JSON.parse(bodyText) as { quota_snapshots?: Record<string, QuotaSnapshot> });
        if (!quota) {
            log('Could not find a usable quota in copilot_internal/user response.');
        }
        return quota;
    } catch (error) {
        log('GET copilot_internal/user threw.', error);
        return null;
    }
}

function toNumber(value: number | string | undefined): number | undefined {
    if (value === undefined || value === '') {
        return undefined;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCopilotQuota(data: { quota_snapshots?: Record<string, QuotaSnapshot> }): CopilotQuota | null {
    const snapshots = Object.entries(data.quota_snapshots ?? {})
        .filter(([, snapshot]) => snapshot && !snapshot.unlimited && (toNumber(snapshot.entitlement) ?? 0) > 0);

    // Prefer an entry that is explicitly about credits, then premium requests, then whatever is left.
    const preferred = snapshots.find(([name]) => /credit/i.test(name))
        ?? snapshots.find(([name]) => /premium/i.test(name))
        ?? snapshots[0];

    if (!preferred) {
        return null;
    }

    const [name, snapshot] = preferred;
    const limit = toNumber(snapshot.entitlement) ?? 0;
    const creditsUsed = toNumber(snapshot.credits_used);
    const remaining = toNumber(snapshot.remaining);
    const percentRemaining = toNumber(snapshot.percent_remaining);

    if (creditsUsed !== undefined) {
        return { used: creditsUsed, limit, source: name };
    }
    if (remaining !== undefined) {
        return { used: Math.max(limit - remaining, 0), limit, source: name };
    }
    if (percentRemaining !== undefined) {
        return { used: Math.max(limit * (1 - percentRemaining / 100), 0), limit, source: name };
    }
    return null;
}

async function logHttpFailure(label: string, response: Response): Promise<void> {
    let body = '';
    try {
        body = (await response.text()).slice(0, MAX_LOGGED_BODY_LENGTH);
    } catch {
        // Body is only for diagnostics.
    }

    const acceptedScopes = response.headers.get('x-accepted-oauth-scopes');
    const grantedScopes = response.headers.get('x-oauth-scopes');
    log(`${label} failed: HTTP ${response.status} ${response.statusText}; token scopes [${grantedScopes ?? 'n/a'}]; accepted scopes [${acceptedScopes ?? 'n/a'}]; body: ${body}`);
}

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
    const startedAt = Date.now();

    const headers = Object.entries((init.headers ?? {}) as Record<string, string>)
        .map(([name, value]) => `${name}: ${name.toLowerCase() === 'authorization' ? 'Bearer ***' : value}`)
        .join('; ');
    log(`-> ${init.method ?? 'GET'} ${input} [${headers}]`);

    try {
        const response = await fetch(input, {
            ...init,
            signal: controller.signal
        });
        log(`<- HTTP ${response.status} in ${Date.now() - startedAt}ms (request id: ${response.headers.get('x-github-request-id') ?? 'n/a'})`);
        return response;
    } finally {
        clearTimeout(timeoutHandle);
    }
}

function determinePlanLimit(): number {
    const configLimit = vscode.workspace.getConfiguration('copilotTrackerEnt').get<number>('monthlyLimit');
    if (configLimit && configLimit > 0) {
        return configLimit;
    }

    return 7000;
}

async function showDetailsPanel(): Promise<void> {
    if (detailsPanel) {
        detailsPanel.reveal(vscode.ViewColumn.One);
        await renderDetailsPanel(detailsPanel);
        return;
    }

    detailsPanel = vscode.window.createWebviewPanel(
        'copilotUsageDetails',
        'Copilot Credit Breakdown',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

    detailsPanel.onDidDispose(() => {
        detailsPanel = undefined;
    });

    detailsPanel.webview.onDidReceiveMessage(async (message: { command?: string }) => {
        log(`Panel action: ${message.command ?? 'unknown'}.`);
        if (message.command === 'refreshUsage') {
            await updateStatusBar();
            return;
        }

        if (message.command === 'reauthenticate') {
            await reauthenticate();
            return;
        }

        if (message.command === 'showLog') {
            outputChannel.show(true);
            return;
        }
    });

    await renderDetailsPanel(detailsPanel);
}

async function renderDetailsPanel(panel: vscode.WebviewPanel): Promise<void> {
    const usagePercentage = calculateUsagePercentage(cachedTotalUsed, cachedLimit).toFixed(1);
    const budget = getDailyBudget(cachedTotalUsed, cachedLimit, cachedWorkdays);
    const pace = budget.status;
    const isWarning = pace === 'over';
    const monthTimelineHtml = buildMonthTimelineHtml(budget);
    const dayTimelineHtml = buildDayTimelineHtml(budget);

    const htmlContent = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Copilot Usage Details</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    padding: 30px;
                    color: var(--vscode-editor-foreground);
                    background-color: var(--vscode-editor-background);
                }
                h1, h2 { color: var(--vscode-editor-foreground); }
                .summary-card {
                    margin-bottom: 30px;
                    padding: 20px;
                    background: var(--vscode-editorWidget-background);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 8px;
                    display: flex;
                    justify-content: space-between;
                }
                .metric { text-align: center; width: 33%; }
                .metric h3 { margin: 0; font-size: 14px; color: var(--vscode-descriptionForeground); font-weight: 600; text-transform: uppercase; }
                .metric p { margin: 12px 0 0 0; font-size: 28px; font-weight: bold; color: var(--vscode-textLink-foreground); }
                .metric p span { font-size: 16px; color: var(--vscode-descriptionForeground); font-weight: normal; }
                .warning { color: var(--vscode-errorForeground) !important; }
                .timeline { margin: 0 24px 28px; max-width: 760px; }
                .arrow-row { position: relative; height: 38px; }
                .arrow {
                    position: absolute;
                    bottom: 0;
                    transform: translateX(-50%);
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    font-size: 13px;
                    font-weight: 600;
                    line-height: 1.1;
                    white-space: nowrap;
                }
                .arrow-side { position: absolute; bottom: 0; font-size: 13px; font-weight: 600; white-space: nowrap; }
                .arrow-side.left { left: -20px; }
                .arrow-side.right { right: -20px; }
                .bar {
                    position: relative;
                    height: 16px;
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 4px;
                    background: var(--vscode-editorWidget-background);
                }
                .bar-fill { position: absolute; top: 0; bottom: 0; left: 0; border-radius: 3px 0 0 3px; opacity: 0.45; }
                .bar-tick { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--vscode-panel-border); }
                .bar-marker {
                    position: absolute;
                    top: -5px;
                    bottom: -5px;
                    width: 2px;
                    margin-left: -1px;
                    background: var(--vscode-editor-foreground);
                }
                .bar-axis { display: flex; justify-content: space-between; margin-top: 6px; font-size: 12px; color: var(--vscode-descriptionForeground); }
                .legend { display: flex; flex-wrap: wrap; gap: 6px 22px; margin-top: 12px; font-size: 12px; }
                .legend-item { display: flex; align-items: center; gap: 6px; }
                .legend-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
                .legend-line { display: inline-block; width: 2px; height: 12px; background: var(--vscode-editor-foreground); }
                .toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 20px; }
                .toolbar-status { font-size: 12px; color: var(--vscode-descriptionForeground); margin-left: 6px; }
            </style>
        </head>
        <body>
            <div class="toolbar">
                <button class="refresh-button" data-command="refreshUsage">Refresh</button>
                <button class="refresh-button" data-command="reauthenticate">Re-authenticate</button>
                <button class="refresh-button" data-command="showLog">Logs</button>
                <span class="toolbar-status">${escapeHtml(lastRefreshSummary)}</span>
            </div>

            <h1>GitHub Copilot Credits</h1>

            <div class="summary-card">
                <div class="metric">
                    <h3>Workdays Elapsed</h3>
                    <p>${cachedWorkdays.elapsed} <span>/ ${cachedWorkdays.total}</span></p>
                </div>
                <div class="metric">
                    <h3>Total Credits Used</h3>
                    <p>${cachedTotalUsed.toFixed(2)} <span>/ ${cachedLimit}</span></p>
                </div>
                <div class="metric">
                    <h3>Usage</h3>
                    <p class="${isWarning ? 'warning' : ''}">${PACE_ICONS[pace]} ${usagePercentage}%</p>
                </div>
            </div>

            <h2>Month</h2>
            ${monthTimelineHtml}

            <h2>Today</h2>
            ${dayTimelineHtml}

            <script>
                const vscodeApi = acquireVsCodeApi();
                document.querySelectorAll('.toolbar button').forEach((button) => {
                    button.addEventListener('click', () => {
                        const command = button.dataset.command;
                        if (command !== 'showLog') {
                            button.disabled = true;
                            button.textContent = 'Working...';
                        }
                        vscodeApi.postMessage({ command });
                    });
                });
            </script>
        </body>
        </html>
    `;

    panel.webview.html = htmlContent;
}

type LegendItem = { marker: 'arrow' | 'line' | 'fill'; label: string; value: string };

function buildTimelineHtml(timeline: Timeline, status: PaceStatus, ticks: number, overLabel: string, underLabel: string, legend: LegendItem[], markerTitle: string): string {
    const color = STATUS_COLORS[status];
    const { arrow } = timeline;
    const percent = (fraction: number): string => (fraction * 100).toFixed(2);

    let arrowHtml: string;
    if (arrow.overflow === 'left') {
        arrowHtml = `<div class="arrow-side left" style="color: ${color};">&#9664; ${formatCredits(arrow.delta)} ${underLabel}</div>`;
    } else if (arrow.overflow === 'right') {
        arrowHtml = `<div class="arrow-side right" style="color: ${color};">${formatCredits(arrow.delta)} ${overLabel} &#9654;</div>`;
    } else {
        arrowHtml = `<div class="arrow" style="left: ${percent(arrow.position)}%; color: ${color};"><span>${formatCredits(cachedTotalUsed)}</span><span>&#9660;</span></div>`;
    }

    const fillWidth = arrow.overflow === 'left' ? 0 : arrow.overflow === 'right' ? 1 : arrow.position;
    const tickHtml = Array.from({ length: Math.max(ticks - 1, 0) }, (_, index) =>
        `<div class="bar-tick" style="left: ${percent((index + 1) / ticks)}%;"></div>`).join('');

    const legendHtml = legend.map((item) => {
        const swatch = item.marker === 'line'
            ? '<span class="legend-line"></span>'
            : `<span class="legend-swatch" style="background: ${item.marker === 'arrow' ? color : color + '73'};"></span>`;
        return `<div class="legend-item">${swatch}<span>${escapeHtml(item.label)}: <strong>${escapeHtml(item.value)}</strong></span></div>`;
    }).join('');

    return `<div class="timeline">
        <div class="arrow-row">${arrowHtml}</div>
        <div class="bar">
            <div class="bar-fill" style="width: ${percent(fillWidth)}%; background: ${color};"></div>
            ${tickHtml}
            <div class="bar-marker" style="left: ${percent(timeline.marker)}%;" title="${escapeHtml(markerTitle)}"></div>
        </div>
        <div class="bar-axis"><span>${formatCredits(timeline.start)}</span><span>${formatCredits(timeline.end)}</span></div>
        <div class="legend">${legendHtml}</div>
    </div>`;
}

function buildMonthTimelineHtml(budget: DailyBudget): string {
    const timeline = getMonthTimeline(cachedTotalUsed, cachedLimit, cachedWorkdays);
    const allowanceToday = budget.perDay * cachedWorkdays.elapsed;
    const standing = budget.status === 'over'
        ? `${formatCredits(budget.amount)} over`
        : budget.status === 'under' ? `${formatCredits(budget.amount)} ahead` : 'on pace';

    return buildTimelineHtml(timeline, budget.status, cachedWorkdays.total, 'over limit', 'ahead', [
        { marker: 'arrow', label: 'Used', value: `${formatCredits(cachedTotalUsed)} of ${formatCredits(cachedLimit)} (${calculateUsagePercentage(cachedTotalUsed, cachedLimit).toFixed(1)}%)` },
        { marker: 'line', label: `Today (workday ${cachedWorkdays.elapsed} of ${cachedWorkdays.total})`, value: `${formatCredits(allowanceToday)} allowed so far` },
        { marker: 'fill', label: 'Per workday', value: formatCredits(budget.perDay) },
        { marker: 'fill', label: 'Standing', value: standing }
    ], 'Allowance through today');
}

function buildDayTimelineHtml(budget: DailyBudget): string {
    const timeline = getDayTimeline(cachedTotalUsed, cachedLimit, cachedWorkdays);
    const now = new Date();
    const intoSlice = Math.min(Math.max(cachedTotalUsed - timeline.start, 0), budget.perDay);

    return buildTimelineHtml(timeline, budget.status, 4, 'over', 'ahead', [
        { marker: 'arrow', label: 'Used', value: formatCredits(cachedTotalUsed) },
        { marker: 'line', label: 'Now', value: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) },
        { marker: 'fill', label: 'Allowance for today', value: `${formatCredits(timeline.start)} to ${formatCredits(timeline.end)}` },
        { marker: 'fill', label: 'Spent of today', value: `${formatCredits(intoSlice)} / ${formatCredits(budget.perDay)}` }
    ], 'Time of day (weekends show the full day)');
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

export function deactivate() {}