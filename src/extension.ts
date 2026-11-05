import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { HistoryStore, createMemoryHistoryStore, openHistoryStore } from './history';
import {
    PACE_ICONS,
    PanelModel,
    escapeHtml,
    formatCredits,
    formatDays,
    getPanelState,
    renderCharts,
    renderPanelShell,
    renderSummary
} from './panel';
import {
    DailyBudget,
    Plan,
    calculateUsagePercentage,
    defaultPlan,
    estimateUsedAtDayStart,
    fromDayKey,
    buildSchedule,
    getDailyBudget,
    getMonthBounds,
    getPlanProgress,
    periodKey,
    resetPlanToNow
} from './usage';

let statusBarItem: vscode.StatusBarItem;
let detailsPanel: vscode.WebviewPanel | undefined;
let outputChannel: vscode.OutputChannel;
let store: HistoryStore = createMemoryHistoryStore();
let extensionUri: vscode.Uri;

const GITHUB_API_TIMEOUT_MS = 15000;
// Every window ticks this often, but only reads the shared store unless a fetch is due.
const TICK_MS = 1000 * 60;
// Floor between any two GitHub calls across all windows, even for manual refreshes.
const MIN_FETCH_GAP_MS = 1000 * 15;
// After a failed fetch, the next attempt (by any window) waits this long.
const RETRY_AFTER_FAILURE_MS = 1000 * 60;
// Same scope VS Code's own Copilot features already hold, so no extra consent prompt.
const GITHUB_SCOPES = ['read:user'];
const MAX_LOGGED_QUOTA_BODY_LENGTH = 2000;
const MAX_LOGGED_BODY_LENGTH = 500;

type FetchStatus = 'success' | 'not_logged_in' | 'api_error';
type RefreshTrigger = 'startup' | 'timer' | 'manual';

// The latest known quota (from this window or another one, via the store).
let cachedTotalUsed = 0;
let cachedLimit = 7000;
let hasQuota = false;
// This window's own last fetch outcome and when it happened.
let lastFetchStatus: FetchStatus | undefined;
let lastFetchAt = 0;
let lastRefreshSummary = 'Not refreshed yet.';
let refreshInFlight: Promise<void> | undefined;

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

function refreshIntervalMs(): number {
    const minutes = vscode.workspace.getConfiguration('copilotTrackerEnt').get<number>('refreshIntervalMinutes') ?? 5;
    return Math.max(minutes, 1) * 60 * 1000;
}

export async function activate(context: vscode.ExtensionContext) {
    extensionUri = context.extensionUri;
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
        await refresh('manual');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('copilot-tracker-ent.reauthenticate', async () => {
        await reauthenticate();
    }));

    statusBarItem.command = showPanelCommandId;

    // globalStorageUri is shared by every window of this profile, so they all see one history.
    store = await openHistoryStore(context.globalStorageUri.fsPath, log);
    context.subscriptions.push({ dispose: () => store.close() });

    void refresh('startup');

    const intervalHandle = setInterval(() => {
        void refresh('timer');
    }, TICK_MS);

    context.subscriptions.push({
        dispose: () => clearInterval(intervalHandle)
    });
}

function refresh(trigger: RefreshTrigger): Promise<void> {
    // Serialise refreshes in this window; a second request while one is running just waits for it.
    refreshInFlight ??= runRefresh(trigger).finally(() => {
        refreshInFlight = undefined;
    });
    return refreshInFlight;
}

async function runRefresh(trigger: RefreshTrigger): Promise<void> {
    try {
        const now = Date.now();
        const gap = trigger === 'manual' ? MIN_FETCH_GAP_MS : refreshIntervalMs();
        let claimed: boolean;
        let previousFetchAt: number | undefined;
        try {
            const claim = store.tryClaimFetch(gap, now);
            claimed = claim.claimed;
            previousFetchAt = claim.lastFetchAt;
        } catch (error) {
            // The store is busy or broken: only a manual refresh goes to GitHub regardless.
            log('Could not check the shared refresh throttle.', error);
            claimed = trigger === 'manual';
        }

        if (claimed) {
            log(`Refreshing from GitHub (${trigger}).`);
            const status = await fetchCopilotData();
            lastFetchStatus = status;
            lastFetchAt = Date.now();
            lastRefreshSummary = `${new Date(lastFetchAt).toLocaleTimeString()}: ${describeStatus(status)}`;
            log(`Refresh result: ${status}.`);
            if (status !== 'success') {
                safeStore(() => store.deferRetry(refreshIntervalMs(), RETRY_AFTER_FAILURE_MS, Date.now()));
            }
        } else if (trigger !== 'timer') {
            const ago = previousFetchAt === undefined ? 0 : Math.round((now - previousFetchAt) / 1000);
            log(`Skipped GitHub call (${trigger}): another refresh ran ${ago}s ago; using the shared history.`);
        }

        loadLatestFromStore();
        updateStatusBar();
    } catch (error) {
        lastRefreshSummary = `${new Date().toLocaleTimeString()}: unexpected error (see Logs).`;
        log('Failed to refresh.', error);
    }

    if (detailsPanel) {
        renderDetailsPanel(detailsPanel);
    }
}

function safeStore<T>(work: () => T): T | undefined {
    try {
        return work();
    } catch (error) {
        log('History store operation failed.', error);
        return undefined;
    }
}

// Picks up the newest quota, which another window may have fetched.
function loadLatestFromStore(): void {
    const latest = safeStore(() => store.getLatestSample());
    if (!latest) {
        return;
    }

    cachedTotalUsed = latest.used;
    cachedLimit = latest.limit > 0 ? latest.limit : determinePlanLimit();
    hasQuota = true;

    const lastSuccessAt = safeStore(() => store.getLastSuccessAt());
    if (lastSuccessAt !== undefined && lastSuccessAt > lastFetchAt) {
        lastRefreshSummary = `${new Date(lastSuccessAt).toLocaleTimeString()}: usage loaded (shared with other windows).`;
    }
}

// What this window should show: its own failure wins only if no window has succeeded since.
function effectiveStatus(): FetchStatus {
    if (!hasQuota) {
        return lastFetchStatus ?? 'success';
    }
    if (lastFetchStatus && lastFetchStatus !== 'success') {
        const lastSuccessAt = safeStore(() => store.getLastSuccessAt()) ?? 0;
        return lastSuccessAt > lastFetchAt ? 'success' : lastFetchStatus;
    }
    return 'success';
}

type PlanContext = {
    plan: Plan;
    planIsDefault: boolean;
    weights: Record<string, number>;
    schedule: ReturnType<typeof buildSchedule>;
    progress: ReturnType<typeof getPlanProgress>;
    budget: DailyBudget;
    planUsed: number;
};

function getPlanContext(now: Date): PlanContext {
    const stored = safeStore(() => store.getPlan());
    // A plan from an earlier quota month no longer applies.
    const plan = stored && stored.period === periodKey(now) ? stored : defaultPlan(now, cachedLimit);
    const weights = safeStore(() => store.getDayWeights()) ?? {};
    const schedule = buildSchedule(plan, weights);
    const progress = getPlanProgress(schedule, now);
    const planUsed = cachedTotalUsed - plan.baseline;
    return { plan, planIsDefault: plan !== stored, weights, schedule, progress, budget: getDailyBudget(planUsed, progress), planUsed };
}

function updateStatusBar(): void {
    const status = effectiveStatus();

    if (status === 'not_logged_in') {
        statusBarItem.text = '$(github) GHCP: Auth Required';
        statusBarItem.tooltip = 'Click to open the panel, then use Re-authenticate.';
        statusBarItem.color = '#ffcc00';
    } else if (status === 'api_error') {
        statusBarItem.text = '$(error) GHCP: API Error';
        statusBarItem.tooltip = 'GitHub request failed. Click to open the panel and use Logs.';
        statusBarItem.color = '#ff4d4d';
    } else if (!hasQuota) {
        statusBarItem.text = '$(sync~spin) GHCP';
        statusBarItem.tooltip = 'Loading Copilot usage...';
        statusBarItem.color = undefined;
    } else {
        const { plan, progress, budget, planUsed } = getPlanContext(new Date());
        const usagePercentage = calculateUsagePercentage(cachedTotalUsed, cachedLimit);
        const { badge, message } = describeBudget(budget);
        const planLine = plan.budget !== cachedLimit || plan.baseline > 0
            ? `\nPlan: ${formatCredits(planUsed)} of ${formatCredits(plan.budget)} credits since ${plan.from}.`
            : '';

        statusBarItem.text = `${PACE_ICONS[budget.status]} ${usagePercentage.toFixed(0)}% (${badge})`;
        statusBarItem.tooltip = `${message}; ${formatCredits(budget.perDay)} credits allowed today
${formatCredits(cachedTotalUsed)} of ${formatCredits(cachedLimit)} credits used (${usagePercentage.toFixed(1)}%), workday ${formatDays(progress.elapsed)} of ${formatDays(progress.total)}.${planLine} Click for details.`;
        statusBarItem.color = undefined;
    }

    statusBarItem.show();
}

function describeStatus(status: FetchStatus): string {
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
            renderDetailsPanel(detailsPanel);
        }
        return;
    }

    await refresh('manual');
}

async function fetchCopilotData(): Promise<FetchStatus> {
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

    const quota = await fetchCopilotQuota(session.accessToken);
    if (!quota) {
        return 'api_error';
    }

    const limit = quota.limit > 0 ? quota.limit : determinePlanLimit();
    log(`Quota: used ${quota.used} of ${quota.limit || 'unknown'} (source: ${quota.source}).`);

    const recorded = safeStore(() => store.recordSample(Date.now(), quota.used, limit));
    if (recorded?.changed) {
        log(`Recorded sample: delta ${recorded.sample.delta === null ? 'n/a (first sample)' : formatCredits(recorded.sample.delta)}.`);
    }

    cachedTotalUsed = quota.used;
    cachedLimit = limit;
    hasQuota = true;
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

        const data = await response.json() as {
            copilot_plan?: string;
            access_type_sku?: string;
            quota_reset_date?: string;
            quota_snapshots?: Record<string, QuotaSnapshot>;
        };

        // Only the quota fields are logged; the full response also carries account identifiers.
        log(`copilot_internal/user: ${JSON.stringify({
            copilot_plan: data.copilot_plan,
            access_type_sku: data.access_type_sku,
            quota_reset_date: data.quota_reset_date,
            quota_snapshots: data.quota_snapshots
        }).slice(0, MAX_LOGGED_QUOTA_BODY_LENGTH)}`);

        const quota = parseCopilotQuota(data);
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
        renderDetailsPanel(detailsPanel);
        return;
    }

    const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media');
    detailsPanel = vscode.window.createWebviewPanel(
        'copilotUsageDetails',
        'Copilot Credit Breakdown',
        vscode.ViewColumn.One,
        { enableScripts: true, localResourceRoots: [mediaRoot] }
    );

    detailsPanel.onDidDispose(() => {
        detailsPanel = undefined;
    });

    const panel = detailsPanel;
    panel.webview.onDidReceiveMessage(async (message: PanelMessage) => {
        if (message.command !== 'ready') {
            log(`Panel action: ${message.command ?? 'unknown'}.`);
        }
        await handlePanelMessage(panel, message);
    });

    const webview = panel.webview;
    webview.html = renderPanelShell({
        cspSource: webview.cspSource,
        nonce: crypto.randomBytes(16).toString('base64'),
        scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'panel.js')).toString(),
        styleUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'panel.css')).toString()
    });
}

type PanelMessage = {
    command?: string;
    from?: string;
    to?: string;
    budget?: number;
    days?: string[];
    weight?: number | null;
};

async function handlePanelMessage(panel: vscode.WebviewPanel, message: PanelMessage): Promise<void> {
    switch (message.command) {
        case 'ready':
            renderDetailsPanel(panel);
            return;
        case 'refreshUsage':
            await refresh('manual');
            return;
        case 'reauthenticate':
            await reauthenticate();
            return;
        case 'showLog':
            outputChannel.show(true);
            return;
        case 'setPlan': {
            const error = applyPlan(message.from, message.to, message.budget);
            if (error) {
                void panel.webview.postMessage({ type: 'planError', message: error });
            }
            break;
        }
        case 'resetToToday': {
            const now = new Date();
            const { plan } = getPlanContext(now);
            safeStore(() => store.setPlan(resetPlanToNow(plan, cachedTotalUsed, cachedLimit, now)));
            log(`Plan reset to today with ${formatCredits(Math.max(cachedLimit - cachedTotalUsed, 0))} credits remaining.`);
            break;
        }
        case 'resetToMonth':
            safeStore(() => store.setPlan(undefined));
            log('Plan reset to the month defaults.');
            break;
        case 'setDayWeights': {
            const days = (message.days ?? []).filter((day) => typeof day === 'string' && fromDayKey(day) !== undefined);
            const weight = typeof message.weight === 'number' && Number.isFinite(message.weight) ? message.weight : null;
            safeStore(() => store.setDayWeights(days, weight));
            log(`Planned workload ${weight === null ? 'default' : `${Math.round(weight * 100)}%`} for ${days.length} day(s).`);
            break;
        }
        default:
            return;
    }

    // Plan changes affect the status bar too.
    updateStatusBar();
    renderDetailsPanel(panel);
}

// Validates and stores a plan edited in the panel; returns an error message when it is rejected.
function applyPlan(from: string | undefined, to: string | undefined, budget: number | undefined): string | undefined {
    const now = new Date();
    const month = getMonthBounds(now);
    if (!from || !to || !fromDayKey(from) || !fromDayKey(to)) {
        return 'Pick both dates.';
    }
    if (from < month.first || to > month.last) {
        return `Dates must be within this quota month (${month.first} to ${month.last}).`;
    }
    if (from > to) {
        return '"From" must be on or before "To".';
    }
    if (budget === undefined || !Number.isFinite(budget) || budget < 0) {
        return 'Budget must be zero or more.';
    }

    const { plan: current } = getPlanContext(now);
    let { baseline, startedAt } = current;
    if (from !== current.from) {
        // Count only usage from the start of the new first day, estimated from the history.
        const periodStart = fromDayKey(month.first)!.getTime();
        const samples = safeStore(() => store.getSamplesSince(periodStart)) ?? [];
        baseline = estimateUsedAtDayStart(samples, from, periodStart) ?? cachedTotalUsed;
        startedAt = fromDayKey(from)!.getTime();
    }

    safeStore(() => store.setPlan({ period: periodKey(now), from, to, budget, baseline, startedAt }));
    log(`Plan set: ${from} to ${to}, budget ${formatCredits(budget)}, baseline ${formatCredits(baseline)}.`);
    return undefined;
}

function renderDetailsPanel(panel: vscode.WebviewPanel): void {
    const now = new Date();
    const context = getPlanContext(now);
    const month = getMonthBounds(now);
    const samples = safeStore(() => store.getSamplesSince(fromDayKey(month.first)!.getTime())) ?? [];

    const model: PanelModel = {
        now,
        used: cachedTotalUsed,
        limit: cachedLimit,
        plan: context.plan,
        planIsDefault: context.planIsDefault,
        schedule: context.schedule,
        progress: context.progress,
        budget: context.budget,
        weights: context.weights,
        samples,
        month,
        refreshSummary: lastRefreshSummary,
        historyNote: store.persistent ? '' : 'history is kept in memory only (SQLite unavailable)'
    };

    void panel.webview.postMessage({
        type: 'render',
        summary: renderSummary(model),
        charts: hasQuota ? renderCharts(model) : `<p class="toolbar-status">${escapeHtml('No usage loaded yet.')}</p>`,
        state: getPanelState(model)
    });
}

export function deactivate() {}
