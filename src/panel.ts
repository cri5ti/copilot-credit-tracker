import {
    DailyBudget,
    PaceStatus,
    Plan,
    PlanProgress,
    Sample,
    ScheduleDay,
    Timeline,
    TrendPoint,
    calculateUsagePercentage,
    fromDayKey,
    getBucketedConsumption,
    getDailyConsumption,
    getDayEndMs,
    getDayStartMs,
    getDayTimeline,
    getIdealRemaining,
    getMonthTimeline,
    getRemainingTrend,
    listDays,
    toDayKey,
    defaultDayWeight,
    clampWeight
} from './usage';

export type PanelModel = {
    now: Date;
    // Credits used this quota month, and the monthly limit.
    used: number;
    limit: number;
    plan: Plan;
    planIsDefault: boolean;
    schedule: ScheduleDay[];
    progress: PlanProgress;
    budget: DailyBudget;
    weights: Record<string, number>;
    // Samples from the start of the quota month.
    samples: Sample[];
    month: { first: string; last: string };
    refreshSummary: string;
    historyNote: string;
};

// Plan form values the webview needs; the form itself stays put across re-renders.
export type PanelState = {
    plan: { from: string; to: string; budget: number; isDefault: boolean };
    month: { first: string; last: string };
    remaining: number;
};

export const STATUS_COLORS: Record<PaceStatus, string> = { under: '#4caf50', on_pace: '#e0a800', over: '#f44336' };
export const PACE_ICONS: Record<PaceStatus, string> = { under: '🟢', on_pace: '🟡', over: '🔴' };

export function formatCredits(value: number): string {
    return Math.round(value).toLocaleString('en-US');
}

export function formatDays(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatWeight(weight: number): string {
    return weight <= 0 ? 'off' : `${Math.round(weight * 100)}%`;
}

function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function formatDay(day: string): string {
    return fromDayKey(day)!.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

export function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
        .replaceAll('\n', '&#10;');
}

// Rounds up to a clean multiple of a power of ten, for axis maxima and steps.
function niceCeil(value: number): number {
    if (value <= 0) {
        return 1;
    }
    const power = Math.pow(10, Math.floor(Math.log10(value)));
    for (const step of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
        if (value <= step * power) {
            return step * power;
        }
    }
    return 10 * power;
}

function niceFloor(value: number): number {
    return value >= 0 ? 0 : -niceCeil(-value);
}

function axisLabel(value: number): string {
    return Math.abs(value) >= 10000 ? `${Math.round(value / 1000)}K` : formatCredits(value);
}

export function getPanelState(model: PanelModel): PanelState {
    return {
        plan: { from: model.plan.from, to: model.plan.to, budget: Math.round(model.plan.budget), isDefault: model.planIsDefault },
        month: model.month,
        remaining: Math.max(model.limit - model.used, 0)
    };
}

export function renderSummary(model: PanelModel): string {
    const { used, limit, plan, progress, budget } = model;
    const planUsed = used - plan.baseline;
    const remaining = plan.budget - planUsed;
    const usage = calculateUsagePercentage(used, limit);

    return `<div class="toolbar-status">${escapeHtml(model.refreshSummary)}${model.historyNote ? ` · ${escapeHtml(model.historyNote)}` : ''}</div>
        <div class="summary-card">
            <div class="metric">
                <h3>Workdays</h3>
                <p>${formatDays(progress.elapsed)} <span>/ ${formatDays(progress.total)}</span></p>
            </div>
            <div class="metric">
                <h3>Credits used</h3>
                <p>${formatCredits(used)} <span>/ ${formatCredits(limit)}</span></p>
            </div>
            <div class="metric">
                <h3>Plan remaining</h3>
                <p class="${remaining < 0 ? 'warning' : ''}">${formatCredits(remaining)} <span>/ ${formatCredits(plan.budget)}</span></p>
            </div>
            <div class="metric">
                <h3>Usage</h3>
                <p class="${budget.status === 'over' ? 'warning' : ''}">${PACE_ICONS[budget.status]} ${usage.toFixed(1)}%</p>
            </div>
        </div>`;
}

export function renderCharts(model: PanelModel): string {
    return `<h2>Month <span class="subtitle">${escapeHtml(formatDay(model.plan.from))} to ${escapeHtml(formatDay(model.plan.to))}</span></h2>
        ${buildMonthTimelineHtml(model)}
        <h3 class="chart-title">Credits per day <span class="subtitle">click or drag across days to plan time off</span></h3>
        ${buildMonthSpikesSvg(model)}
        <h3 class="chart-title">Remaining budget</h3>
        ${buildMonthTrendSvg(model)}

        <h2>Today <span class="subtitle">${escapeHtml(formatDay(toDayKey(model.now)))}</span></h2>
        ${buildDayTimelineHtml(model)}
        <h3 class="chart-title">Credits per 15 minutes</h3>
        ${buildDaySpikesSvg(model)}
        <h3 class="chart-title">Remaining budget today</h3>
        ${buildDayTrendSvg(model)}`;
}

// ---------------------------------------------------------------------------
// Bar timelines (credits axis with the "used" arrow).

type LegendItem = { marker: 'arrow' | 'line' | 'fill'; label: string; value: string };

function buildTimelineHtml(timeline: Timeline, used: number, status: PaceStatus, ticks: number[], overLabel: string, underLabel: string, legend: LegendItem[], markerTitle: string): string {
    const color = STATUS_COLORS[status];
    const { arrow } = timeline;
    const percent = (fraction: number): string => (fraction * 100).toFixed(2);

    let arrowHtml: string;
    if (arrow.overflow === 'left') {
        arrowHtml = `<div class="arrow-side left" style="color: ${color};">&#9664; ${formatCredits(arrow.delta)} ${underLabel}</div>`;
    } else if (arrow.overflow === 'right') {
        arrowHtml = `<div class="arrow-side right" style="color: ${color};">${formatCredits(arrow.delta)} ${overLabel} &#9654;</div>`;
    } else {
        arrowHtml = `<div class="arrow" style="left: ${percent(arrow.position)}%; color: ${color};"><span>${formatCredits(used)}</span><span>&#9660;</span></div>`;
    }

    const fillWidth = arrow.overflow === 'left' ? 0 : arrow.overflow === 'right' ? 1 : arrow.position;
    const tickHtml = ticks.map((tick) => `<div class="bar-tick" style="left: ${percent(tick)}%;"></div>`).join('');

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

function buildMonthTimelineHtml(model: PanelModel): string {
    const { plan, progress, budget, schedule } = model;
    const planUsed = model.used - plan.baseline;
    const timeline = getMonthTimeline(planUsed, plan.budget, progress);
    const standing = budget.status === 'over'
        ? `${formatCredits(budget.amount)} over`
        : budget.status === 'under' ? `${formatCredits(budget.amount)} ahead` : 'on pace';
    const ticks = plan.budget > 0
        ? schedule.slice(0, -1).filter((day) => day.weight > 0).map((day) => day.end / plan.budget)
        : [];

    return buildTimelineHtml(timeline, planUsed, budget.status, ticks, 'over budget', 'ahead', [
        { marker: 'arrow', label: 'Used in plan', value: `${formatCredits(planUsed)} of ${formatCredits(plan.budget)} (${calculateUsagePercentage(planUsed, plan.budget).toFixed(1)}%)` },
        { marker: 'line', label: `Today (workday ${formatDays(progress.elapsed)} of ${formatDays(progress.total)})`, value: `${formatCredits(progress.sliceEnd)} allowed so far` },
        { marker: 'fill', label: 'Today\'s allowance', value: formatCredits(budget.perDay) },
        { marker: 'fill', label: 'Standing', value: standing }
    ], 'Allowance through today');
}

function buildDayTimelineHtml(model: PanelModel): string {
    const { plan, progress, budget } = model;
    const planUsed = model.used - plan.baseline;
    const timeline = getDayTimeline(planUsed, progress, model.now);
    const intoSlice = Math.min(Math.max(planUsed - timeline.start, 0), budget.perDay);

    return buildTimelineHtml(timeline, planUsed, budget.status, [0.25, 0.5, 0.75], 'over', 'ahead', [
        { marker: 'arrow', label: 'Used in plan', value: formatCredits(planUsed) },
        { marker: 'line', label: 'Now', value: formatTime(model.now.getTime()) },
        { marker: 'fill', label: 'Allowance for today', value: `${formatCredits(timeline.start)} to ${formatCredits(timeline.end)}` },
        { marker: 'fill', label: 'Spent of today', value: `${formatCredits(intoSlice)} / ${formatCredits(budget.perDay)}` }
    ], 'Time of day (days off show the full day)');
}

// ---------------------------------------------------------------------------
// SVG charts. All four share the same width and left gutter, so month and day charts line up.

const WIDTH = 760;
const PAD_LEFT = 48;
const PAD_RIGHT = 12;
const PLOT_WIDTH = WIDTH - PAD_LEFT - PAD_RIGHT;

type YScale = { min: number; max: number; top: number; bottom: number; y: (value: number) => number };

function makeYScale(min: number, max: number, top: number, bottom: number): YScale {
    const span = max - min || 1;
    return { min, max, top, bottom, y: (value) => bottom - ((value - min) / span) * (bottom - top) };
}

function gridHtml(scale: YScale, values: number[]): string {
    return values.map((value) => {
        const y = scale.y(value).toFixed(1);
        return `<line class="grid${value === 0 ? ' zero' : ''}" x1="${PAD_LEFT}" x2="${WIDTH - PAD_RIGHT}" y1="${y}" y2="${y}"/>
            <text class="axis-label" x="${PAD_LEFT - 6}" y="${y}" text-anchor="end" dominant-baseline="middle">${axisLabel(value)}</text>`;
    }).join('');
}

// A column growing up from the baseline with a 4px rounded top (less when the column is thin or short).
function columnPath(x: number, width: number, baseline: number, top: number): string {
    const height = baseline - top;
    if (height <= 0) {
        return '';
    }
    const radius = Math.min(4, width / 2, height);
    return `M${x.toFixed(1)},${baseline.toFixed(1)}V${(top + radius).toFixed(1)}Q${x.toFixed(1)},${top.toFixed(1)} ${(x + radius).toFixed(1)},${top.toFixed(1)}`
        + `H${(x + width - radius).toFixed(1)}Q${(x + width).toFixed(1)},${top.toFixed(1)} ${(x + width).toFixed(1)},${(top + radius).toFixed(1)}V${baseline.toFixed(1)}Z`;
}

function linePath(points: { x: number; y: number }[]): string {
    return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join('');
}

function svgOpen(height: number, label: string, extraClass = ''): string {
    return `<svg class="chart ${extraClass}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${escapeHtml(label)}">
        <defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line class="hatch-line" x1="0" y1="0" x2="0" y2="6"/></pattern></defs>`;
}

function monthFrame(model: PanelModel): { days: string[]; slot: number; startMs: number; endMs: number; x: (ts: number) => number } {
    const days = listDays(model.month.first, model.month.last);
    const startMs = fromDayKey(model.month.first)!.getTime();
    const endMs = getDayEndMs(fromDayKey(model.month.last)!);
    return {
        days,
        slot: PLOT_WIDTH / days.length,
        startMs,
        endMs,
        x: (ts) => PAD_LEFT + ((ts - startMs) / (endMs - startMs)) * PLOT_WIDTH
    };
}

function dayAxisHtml(days: string[], slot: number, y: number, today: string, weights: Record<string, number>): string {
    return days.map((day, index) => {
        const date = fromDayKey(day)!;
        const x = PAD_LEFT + slot * (index + 0.5);
        const classes = ['axis-label', 'day-number', isWeekendDay(date) ? 'weekend' : '', day === today ? 'today' : ''].filter(Boolean).join(' ');
        const planned = weights[day] !== undefined ? `<circle class="planned-dot" cx="${x.toFixed(1)}" cy="${y + 10}" r="2"/>` : '';
        return `<text class="${classes}" x="${x.toFixed(1)}" y="${y}" text-anchor="middle">${date.getDate()}</text>${planned}`;
    }).join('');
}

function isWeekendDay(date: Date): boolean {
    return defaultDayWeight(date) === 0;
}

function buildMonthSpikesSvg(model: PanelModel): string {
    const height = 170;
    const top = 12;
    const bottom = 128;
    const { days, slot } = monthFrame(model);
    const consumption = getDailyConsumption(model.samples);
    const scheduleByDay = new Map(model.schedule.map((day) => [day.day, day]));
    const today = toDayKey(model.now);

    const maxValue = Math.max(...days.map((day) => Math.max(consumption.get(day) ?? 0, scheduleByDay.get(day)?.allowance ?? 0)), 1);
    const scale = makeYScale(0, niceCeil(maxValue * 1.05), top, bottom);
    const barWidth = Math.min(slot - 6, 16);

    const shading: string[] = [];
    const marks: string[] = [];
    const hits: string[] = [];

    days.forEach((day, index) => {
        const x0 = PAD_LEFT + slot * index;
        const entry = scheduleByDay.get(day);
        const weight = entry?.weight ?? clampWeight(model.weights[day] ?? defaultDayWeight(fromDayKey(day)!));
        const spent = consumption.get(day) ?? 0;

        if (!entry) {
            shading.push(`<rect class="outside-plan" x="${(x0 + 1).toFixed(1)}" y="${top}" width="${(slot - 2).toFixed(1)}" height="${bottom - top}"/>`);
        } else if (weight < 1) {
            shading.push(`<rect class="off-day" style="opacity: ${(0.25 + 0.6 * (1 - weight)).toFixed(2)}" x="${(x0 + 1).toFixed(1)}" y="${top}" width="${(slot - 2).toFixed(1)}" height="${bottom - top}"/>`);
        }
        if (day === today) {
            shading.push(`<rect class="today-column" x="${(x0 + 1).toFixed(1)}" y="${top}" width="${(slot - 2).toFixed(1)}" height="${bottom - top}"/>`);
        }

        if (entry && entry.allowance > 0) {
            const y = scale.y(entry.allowance).toFixed(1);
            marks.push(`<line class="allowance" x1="${(x0 + 2).toFixed(1)}" x2="${(x0 + slot - 2).toFixed(1)}" y1="${y}" y2="${y}"/>`);
        }
        if (spent > 0) {
            const over = entry ? spent > entry.allowance + 0.5 : false;
            marks.push(`<path class="spike${over ? ' over' : ''}" d="${columnPath(x0 + (slot - barWidth) / 2, barWidth, bottom, scale.y(spent))}"/>`);
        }

        const tip = [
            formatDay(day),
            `Used: ${formatCredits(spent)}`,
            entry ? `Allowance: ${formatCredits(entry.allowance)}` : 'Outside the plan',
            `Workload: ${formatWeight(weight)}${model.weights[day] !== undefined ? ' (planned)' : ''}`
        ].join('\n');
        hits.push(`<rect class="day-hit" data-day="${day}" data-weight="${weight}" data-tip="${escapeHtml(tip)}" x="${x0.toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${height}"/>`);
    });

    return `<div class="chart-wrap">${svgOpen(height, 'Credits used per day this month', 'month-days')}
        ${shading.join('')}
        ${gridHtml(scale, [0, scale.max / 2, scale.max])}
        ${marks.join('')}
        ${dayAxisHtml(days, slot, bottom + 16, today, model.weights)}
        ${hits.join('')}
    </svg>
    <div class="legend">
        <div class="legend-item"><span class="legend-swatch spike-swatch"></span><span>Used that day</span></div>
        <div class="legend-item"><span class="legend-swatch over-swatch"></span><span>Over that day's allowance</span></div>
        <div class="legend-item"><span class="legend-dash"></span><span>Day's allowance</span></div>
        <div class="legend-item"><span class="legend-swatch off-swatch"></span><span>Off or part day</span></div>
        <div class="legend-item"><span class="legend-dot"></span><span>Planned by you</span></div>
    </div></div>`;
}

function trendAt(points: TrendPoint[], ts: number): number | undefined {
    let value: number | undefined;
    for (const point of points) {
        if (point.ts > ts) {
            break;
        }
        value = point.remaining;
    }
    return value;
}

function buildTrendSvg(options: {
    label: string;
    startMs: number;
    endMs: number;
    nowMs: number;
    actual: TrendPoint[];
    ideal: TrendPoint[];
    floorAtZero: boolean;
    xTicks: { ts: number; label: string }[];
    hits: { from: number; to: number; tip: string }[];
}): string {
    const height = 180;
    const top = 12;
    const bottom = 148;
    const x = (ts: number): number => PAD_LEFT + ((ts - options.startMs) / (options.endMs - options.startMs)) * PLOT_WIDTH;

    const values = [...options.actual, ...options.ideal].map((point) => point.remaining);
    if (values.length === 0) {
        values.push(0);
    }
    let min = Math.min(...values);
    let max = Math.max(...values);
    let gridValues: number[];
    if (options.floorAtZero) {
        min = niceFloor(min);
        max = niceCeil(max);
        gridValues = Array.from(new Set([min, 0, max / 2, max]));
    } else {
        // Zoomed in on the data: snap both ends to a clean step so the ticks read as round numbers.
        const step = niceCeil(Math.max(max - min, 20) / 2);
        min = Math.floor(min / step) * step;
        max = Math.ceil(max / step) * step;
        gridValues = [];
        for (let value = min; value <= max + step / 2; value += step) {
            gridValues.push(value);
        }
    }
    const scale = makeYScale(min, max, top, bottom);

    const toPoints = (points: TrendPoint[]) => points.map((point) => ({ x: x(point.ts), y: scale.y(point.remaining) }));
    const nowX = x(options.nowMs);
    const last = options.actual[options.actual.length - 1];

    const xTicks = options.xTicks.map((tick) =>
        `<text class="axis-label" x="${x(tick.ts).toFixed(1)}" y="${bottom + 16}" text-anchor="middle">${escapeHtml(tick.label)}</text>`).join('');
    const hits = options.hits.map((hit) =>
        `<rect class="hover-hit" data-tip="${escapeHtml(hit.tip)}" x="${x(hit.from).toFixed(1)}" y="0" width="${Math.max(x(hit.to) - x(hit.from), 1).toFixed(1)}" height="${height}"/>`).join('');

    return `${svgOpen(height, options.label)}
        ${gridHtml(scale, gridValues)}
        ${nowX >= PAD_LEFT && nowX <= WIDTH - PAD_RIGHT ? `<line class="now-line" x1="${nowX.toFixed(1)}" x2="${nowX.toFixed(1)}" y1="${top}" y2="${bottom}"/>` : ''}
        ${options.ideal.length > 1 ? `<path class="ideal" d="${linePath(toPoints(options.ideal))}"/>` : ''}
        ${options.actual.length > 1 ? `<path class="actual" d="${linePath(toPoints(options.actual))}"/>` : ''}
        ${last ? `<circle class="actual-dot" cx="${x(last.ts).toFixed(1)}" cy="${scale.y(last.remaining).toFixed(1)}" r="4"/>` : ''}
        ${xTicks}
        ${hits}
    </svg>`;
}

function trendLegend(actual: number | undefined, ideal: number | undefined): string {
    const standing = actual !== undefined && ideal !== undefined
        ? actual >= ideal ? `${formatCredits(actual - ideal)} ahead of ideal` : `${formatCredits(ideal - actual)} behind ideal`
        : '';
    return `<div class="legend">
        <div class="legend-item"><span class="legend-key actual-key"></span><span>Remaining${actual !== undefined ? `: <strong>${formatCredits(actual)}</strong>` : ''}</span></div>
        <div class="legend-item"><span class="legend-key ideal-key"></span><span>Ideal${ideal !== undefined ? `: <strong>${formatCredits(ideal)}</strong>` : ''}</span></div>
        ${standing ? `<div class="legend-item"><span>${escapeHtml(standing)}</span></div>` : ''}
    </div>`;
}

function buildMonthTrendSvg(model: PanelModel): string {
    const { plan, schedule } = model;
    const { days, startMs, endMs } = monthFrame(model);
    const nowMs = model.now.getTime();
    const actual = getRemainingTrend(model.samples, plan, startMs, nowMs, model.used);

    const ideal: TrendPoint[] = schedule.flatMap((day) => {
        const date = fromDayKey(day.day)!;
        return [
            { ts: date.getTime(), remaining: plan.budget - day.start },
            { ts: getDayEndMs(date), remaining: plan.budget - day.end }
        ];
    });

    const xTicks = days
        .map((day, index) => ({ day, index }))
        .filter(({ index }) => index === 0 || (index + 1) % 5 === 0 || index === days.length - 1)
        .map(({ day }) => {
            const date = fromDayKey(day)!;
            return { ts: date.getTime() + (getDayEndMs(date) - date.getTime()) / 2, label: String(date.getDate()) };
        });

    const hits = days.map((day) => {
        const date = fromDayKey(day)!;
        const dayEnd = getDayEndMs(date);
        const inPlan = day >= plan.from && day <= plan.to;
        const lines = [formatDay(day)];
        const remaining = date.getTime() <= nowMs ? trendAt(actual, Math.min(dayEnd, nowMs)) : undefined;
        if (remaining !== undefined) {
            lines.push(`Remaining${dayEnd > nowMs ? ' now' : ' at end of day'}: ${formatCredits(remaining)}`);
        }
        if (inPlan) {
            lines.push(`Ideal at end of day: ${formatCredits(getIdealRemaining(schedule, plan.budget, dayEnd - 1))}`);
        } else {
            lines.push('Outside the plan');
        }
        return { from: date.getTime(), to: dayEnd, tip: lines.join('\n') };
    });

    const currentActual = actual.length > 0 ? actual[actual.length - 1].remaining : undefined;
    const currentIdeal = schedule.length > 0 && nowMs >= plan.startedAt ? getIdealRemaining(schedule, plan.budget, nowMs) : undefined;

    return `<div class="chart-wrap">${buildTrendSvg({
        label: 'Remaining plan budget this month against the ideal',
        startMs, endMs, nowMs, actual, ideal, floorAtZero: true, xTicks, hits
    })}${trendLegend(currentActual, currentIdeal)}</div>`;
}

function hourTicks(dayStart: number): { ts: number; label: string }[] {
    const start = new Date(dayStart);
    return [0, 3, 6, 9, 12, 15, 18, 21, 24].map((hour) => {
        const ts = new Date(start.getFullYear(), start.getMonth(), start.getDate(), hour).getTime();
        return { ts, label: `${String(hour).padStart(2, '0')}:00` };
    });
}

function buildDaySpikesSvg(model: PanelModel): string {
    const height = 150;
    const top = 12;
    const bottom = 118;
    const buckets = 96;
    const dayStart = getDayStartMs(model.now);
    const dayEnd = getDayEndMs(model.now);
    const nowMs = model.now.getTime();
    const values = getBucketedConsumption(model.samples, dayStart, dayEnd, buckets);
    const slot = PLOT_WIDTH / buckets;
    const bucketMs = (dayEnd - dayStart) / buckets;
    const scale = makeYScale(0, niceCeil(Math.max(...values, 1) * 1.05), top, bottom);
    const x = (ts: number): number => PAD_LEFT + ((ts - dayStart) / (dayEnd - dayStart)) * PLOT_WIDTH;
    const barWidth = Math.max(slot - 2, 1);
    const usedToday = values.reduce((sum, value) => sum + value, 0);

    const marks = values.map((value, index) => value > 0
        ? `<path class="spike" d="${columnPath(PAD_LEFT + slot * index + 1, barWidth, bottom, scale.y(value))}"/>`
        : '').join('');
    const hits = values.map((value, index) => {
        const from = dayStart + bucketMs * index;
        const tip = `${formatTime(from)} to ${formatTime(from + bucketMs)}\n${formatCredits(value)} credits`;
        return `<rect class="hover-hit" data-tip="${escapeHtml(tip)}" x="${(PAD_LEFT + slot * index).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${height}"/>`;
    }).join('');
    const ticks = hourTicks(dayStart).map((tick) =>
        `<text class="axis-label" x="${x(tick.ts).toFixed(1)}" y="${bottom + 16}" text-anchor="middle">${tick.label}</text>`).join('');
    const nowX = x(nowMs).toFixed(1);

    return `<div class="chart-wrap">${svgOpen(height, 'Credits used per 15 minutes today')}
        ${gridHtml(scale, [0, scale.max / 2, scale.max])}
        <line class="now-line" x1="${nowX}" x2="${nowX}" y1="${top}" y2="${bottom}"/>
        ${marks}
        ${ticks}
        ${hits}
    </svg>
    <div class="legend">
        <div class="legend-item"><span>Used today: <strong>${formatCredits(usedToday)}</strong> of <strong>${formatCredits(model.progress.perDay)}</strong> allowed</span></div>
        <div class="legend-item"><span class="legend-line"></span><span>Now</span></div>
    </div></div>`;
}

function buildDayTrendSvg(model: PanelModel): string {
    const { plan, progress } = model;
    const dayStart = getDayStartMs(model.now);
    const dayEnd = getDayEndMs(model.now);
    const nowMs = model.now.getTime();
    const actual = getRemainingTrend(model.samples, plan, dayStart, nowMs, model.used);
    const ideal: TrendPoint[] = [
        { ts: dayStart, remaining: plan.budget - progress.sliceStart },
        { ts: dayEnd, remaining: plan.budget - progress.sliceEnd }
    ];
    const idealAt = (ts: number): number => plan.budget - (progress.sliceStart + (progress.sliceEnd - progress.sliceStart) * ((ts - dayStart) / (dayEnd - dayStart)));

    const hourMs = (dayEnd - dayStart) / 24;
    const hits = Array.from({ length: 24 }, (_, hour) => {
        const from = dayStart + hourMs * hour;
        const to = from + hourMs;
        const lines = [`${formatTime(from)} to ${formatTime(to)}`];
        const remaining = from <= nowMs ? trendAt(actual, Math.min(to, nowMs)) : undefined;
        if (remaining !== undefined) {
            lines.push(`Remaining: ${formatCredits(remaining)}`);
        }
        lines.push(`Ideal: ${formatCredits(idealAt(Math.min(to, dayEnd)))}`);
        return { from, to, tip: lines.join('\n') };
    });

    const currentActual = actual.length > 0 ? actual[actual.length - 1].remaining : undefined;

    return `<div class="chart-wrap">${buildTrendSvg({
        label: 'Remaining plan budget today against the ideal',
        startMs: dayStart, endMs: dayEnd, nowMs, actual, ideal, floorAtZero: false, xTicks: hourTicks(dayStart), hits
    })}${trendLegend(currentActual, idealAt(nowMs))}</div>`;
}

// ---------------------------------------------------------------------------
// The page shell. Content arrives by postMessage so the plan form and day selection survive refreshes.

export function renderPanelShell(options: { cspSource: string; nonce: string; scriptUri: string; styleUri: string }): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${options.cspSource} 'unsafe-inline'; script-src 'nonce-${options.nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Copilot Usage Details</title>
    <link rel="stylesheet" href="${options.styleUri}">
</head>
<body>
    <div class="menu">
        <button id="menu-button" class="icon-button" aria-label="More actions" aria-haspopup="menu" aria-expanded="false" title="More actions">&#8942;</button>
        <div id="menu-list" class="menu-list" role="menu" hidden>
            <button role="menuitem" data-command="refreshUsage">Refresh</button>
            <button role="menuitem" data-command="reauthenticate">Re-authenticate</button>
            <button role="menuitem" data-command="showLog">Logs</button>
        </div>
    </div>

    <div id="summary"><p class="toolbar-status">Loading...</p></div>

    <div id="charts"></div>

    <form id="plan-form" class="plan-card" autocomplete="off">
        <label>From <input type="date" name="from" required></label>
        <label>To <input type="date" name="to" required></label>
        <label>Budget <input type="number" name="budget" min="0" step="1" required></label>
        <button type="submit">Apply</button>
        <span class="plan-break"></span>
        <button type="button" data-plan="resetToToday" title="Start from today with the credits remaining this month">Reset to today</button>
        <button type="button" data-plan="resetToMonth" title="Whole month with the full monthly limit">Month defaults</button>
        <span class="plan-note" id="plan-note"></span>
    </form>

    <div id="day-popup" class="popup" hidden>
        <div class="popup-title" id="day-popup-title"></div>
        <label class="popup-row"><input type="checkbox" id="day-popup-on"> Working</label>
        <label class="popup-row">Workload <input type="range" id="day-popup-weight" min="0" max="100" step="5"> <span id="day-popup-value"></span></label>
        <div class="popup-row">
            <button type="button" id="day-popup-default">Weekday default</button>
            <button type="button" id="day-popup-close">Done</button>
        </div>
    </div>
    <div id="tooltip" class="tooltip" hidden></div>

    <script nonce="${options.nonce}" src="${options.scriptUri}"></script>
</body>
</html>`;
}
