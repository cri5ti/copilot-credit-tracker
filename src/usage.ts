export type PaceStatus = 'under' | 'on_pace' | 'over';

export function calculateUsagePercentage(totalUsed: number, limit: number): number {
    if (limit <= 0) {
        return 0;
    }

    return (totalUsed / limit) * 100;
}

// ---------------------------------------------------------------------------
// Calendar days. Days are keyed as local "YYYY-MM-DD" strings, which also sort chronologically.

export function toDayKey(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

// Local midnight of the day; undefined for anything that is not a real YYYY-MM-DD date.
export function fromDayKey(key: string): Date | undefined {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (!match) {
        return undefined;
    }

    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return toDayKey(date) === key ? date : undefined;
}

function startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function nextDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
}

export function isWeekday(date: Date): boolean {
    const day = date.getDay();
    return day !== 0 && day !== 6;
}

// Monday to Friday is a full workday, the weekend is off, unless the user planned otherwise.
export function defaultDayWeight(date: Date): number {
    return isWeekday(date) ? 1 : 0;
}

export function periodKey(date: Date): string {
    return toDayKey(date).slice(0, 7);
}

export function getMonthBounds(now: Date): { first: string; last: string } {
    return {
        first: toDayKey(new Date(now.getFullYear(), now.getMonth(), 1)),
        last: toDayKey(new Date(now.getFullYear(), now.getMonth() + 1, 0))
    };
}

export function listDays(from: string, to: string): string[] {
    const start = fromDayKey(from);
    const end = fromDayKey(to);
    const days: string[] = [];
    if (!start || !end) {
        return days;
    }

    for (let day = start; day <= end; day = nextDay(day)) {
        days.push(toDayKey(day));
    }
    return days;
}

// ---------------------------------------------------------------------------
// The plan: the budget to spread over a range of days within the quota month.

export type Plan = {
    // Quota month (YYYY-MM) the plan belongs to; a plan from another month is ignored.
    period: string;
    from: string;
    to: string;
    budget: number;
    // Credits already used when the plan started; the plan only counts usage above it.
    baseline: number;
    // When the baseline was taken (ms): the start of `from`, or the moment of "reset to today".
    startedAt: number;
};

export function defaultPlan(now: Date, limit: number): Plan {
    const { first, last } = getMonthBounds(now);
    return {
        period: periodKey(now),
        from: first,
        to: last,
        budget: limit,
        baseline: 0,
        startedAt: fromDayKey(first)!.getTime()
    };
}

// A fresh start: from now until the end of the plan, with whatever is left of the monthly limit.
export function resetPlanToNow(plan: Plan, used: number, limit: number, now: Date): Plan {
    const today = toDayKey(now);
    return {
        period: periodKey(now),
        from: today,
        to: plan.to >= today ? plan.to : getMonthBounds(now).last,
        budget: Math.max(limit - used, 0),
        baseline: used,
        startedAt: now.getTime()
    };
}

export type ScheduleDay = {
    day: string;
    // 0 (off) to 1 (full workday).
    weight: number;
    // True when the weight was planned by the user rather than the weekday default.
    custom: boolean;
    // This day's share of the budget, and the cumulative allowance before and after it.
    allowance: number;
    start: number;
    end: number;
};

// Spreads the budget over the plan's days in proportion to each day's weight.
export function buildSchedule(plan: Plan, overrides: Record<string, number>): ScheduleDay[] {
    const days = listDays(plan.from, plan.to).map((day) => {
        const custom = overrides[day] !== undefined;
        return { day, custom, weight: custom ? clampWeight(overrides[day]) : defaultDayWeight(fromDayKey(day)!) };
    });
    const totalWeight = days.reduce((sum, day) => sum + day.weight, 0);

    let cumulative = 0;
    return days.map((day) => {
        const allowance = totalWeight > 0 ? (plan.budget * day.weight) / totalWeight : 0;
        const start = cumulative;
        cumulative += allowance;
        return { ...day, allowance, start, end: cumulative };
    });
}

export function clampWeight(weight: number): number {
    return Number.isFinite(weight) ? Math.min(Math.max(weight, 0), 1) : 0;
}

export type PlanProgress = {
    // Weighted workdays up to and including today, and in the whole plan.
    elapsed: number;
    total: number;
    // Today's allowance and the cumulative allowance before and after today.
    perDay: number;
    sliceStart: number;
    sliceEnd: number;
    // Whether today counts as working time (weight above 0).
    workingToday: boolean;
};

export function getPlanProgress(schedule: ScheduleDay[], now: Date = new Date()): PlanProgress {
    const today = toDayKey(now);
    const total = schedule.reduce((sum, day) => sum + day.weight, 0);
    const elapsed = schedule.filter((day) => day.day <= today).reduce((sum, day) => sum + day.weight, 0);
    const budget = schedule.length > 0 ? schedule[schedule.length - 1].end : 0;
    const todayEntry = schedule.find((day) => day.day === today);

    if (todayEntry) {
        return { elapsed, total, perDay: todayEntry.allowance, sliceStart: todayEntry.start, sliceEnd: todayEntry.end, workingToday: todayEntry.weight > 0 };
    }

    // Outside the plan: before it nothing is allowed yet, after it the whole budget is.
    const after = schedule.length > 0 && today > schedule[schedule.length - 1].day;
    const edge = after ? budget : 0;
    return { elapsed, total, perDay: 0, sliceStart: edge, sliceEnd: edge, workingToday: false };
}

export type DailyBudget = {
    status: PaceStatus;
    // Credits allowed today.
    perDay: number;
    // under: credits ahead of today's slice; on_pace: credits spent inside today's slice; over: credits past it.
    amount: number;
};

// `used` counts credits since the plan started. Today's slice runs from the allowance through yesterday to the allowance through today.
export function getDailyBudget(used: number, progress: PlanProgress): DailyBudget {
    const { perDay, sliceStart, sliceEnd } = progress;

    if (used > sliceEnd) {
        return { status: 'over', perDay, amount: used - sliceEnd };
    }

    if (used < sliceStart) {
        return { status: 'under', perDay, amount: sliceStart - used };
    }

    return { status: 'on_pace', perDay, amount: used - sliceStart };
}

export type TimelineArrow = {
    // 0 to 1 along the bar; clamped to the nearest edge when the value is out of range.
    position: number;
    overflow: 'none' | 'left' | 'right';
    // Credits beyond the nearest edge when out of range, otherwise 0.
    delta: number;
};

export type Timeline = {
    start: number;
    end: number;
    arrow: TimelineArrow;
    // 0 to 1 along the bar: where "today" is.
    marker: number;
};

function placeArrow(value: number, start: number, end: number): TimelineArrow {
    if (value < start) {
        return { position: 0, overflow: 'left', delta: start - value };
    }

    if (value > end) {
        return { position: 1, overflow: 'right', delta: value - end };
    }

    const position = end > start ? (value - start) / (end - start) : 0;
    return { position, overflow: 'none', delta: 0 };
}

// The month bar spans 0 to the plan budget; the marker sits at the allowance through today.
export function getMonthTimeline(used: number, budget: number, progress: PlanProgress): Timeline {
    return {
        start: 0,
        end: budget,
        arrow: placeArrow(used, 0, budget),
        marker: budget > 0 ? Math.min(progress.sliceEnd / budget, 1) : 0
    };
}

// The day bar spans today's slice of the allowance; the marker is the time of day (full on days off).
export function getDayTimeline(used: number, progress: PlanProgress, now: Date = new Date()): Timeline {
    const timeOfDay = (now.getHours() + now.getMinutes() / 60) / 24;

    return {
        start: progress.sliceStart,
        end: progress.sliceEnd,
        arrow: placeArrow(used, progress.sliceStart, progress.sliceEnd),
        marker: progress.workingToday ? timeOfDay : 1
    };
}

// ---------------------------------------------------------------------------
// History: quota samples recorded on each refresh where the value changed.

export type Sample = {
    ts: number;
    used: number;
    limit: number;
    // Credits consumed since the previous sample; null for the very first sample.
    delta: number | null;
};

// A drop in usage means the quota was reset, so everything used since counts as new.
export function computeDelta(previousUsed: number | undefined, used: number): number | null {
    if (previousUsed === undefined) {
        return null;
    }

    return used >= previousUsed ? used - previousUsed : used;
}

// Credits consumed per day, keyed by day.
export function getDailyConsumption(samples: Sample[]): Map<string, number> {
    const totals = new Map<string, number>();
    for (const sample of samples) {
        if (sample.delta && sample.delta > 0) {
            const day = toDayKey(new Date(sample.ts));
            totals.set(day, (totals.get(day) ?? 0) + sample.delta);
        }
    }
    return totals;
}

// Credits consumed in `count` equal buckets between `startMs` and `endMs`.
export function getBucketedConsumption(samples: Sample[], startMs: number, endMs: number, count: number): number[] {
    const buckets = new Array<number>(count).fill(0);
    const width = (endMs - startMs) / count;
    for (const sample of samples) {
        if (!sample.delta || sample.delta <= 0 || sample.ts < startMs || sample.ts >= endMs) {
            continue;
        }
        buckets[Math.min(Math.floor((sample.ts - startMs) / width), count - 1)] += sample.delta;
    }
    return buckets;
}

// Best estimate of the credits used when `day` began: the last sample before it in this quota month,
// else the value just before the first sample on or after it. Undefined without any history.
export function estimateUsedAtDayStart(samples: Sample[], day: string, periodStartMs: number): number | undefined {
    const dayStart = fromDayKey(day)?.getTime();
    if (dayStart === undefined) {
        return undefined;
    }
    if (dayStart <= periodStartMs) {
        return 0;
    }

    const inPeriod = samples.filter((sample) => sample.ts >= periodStartMs);
    const before = inPeriod.filter((sample) => sample.ts < dayStart);
    if (before.length > 0) {
        return before[before.length - 1].used;
    }

    const after = inPeriod.find((sample) => sample.ts >= dayStart);
    if (after) {
        return Math.max(after.used - (after.delta ?? 0), 0);
    }
    return undefined;
}

export type TrendPoint = { ts: number; remaining: number };

// Remaining plan budget over time, from `startMs` (or the plan start, if later) up to now.
export function getRemainingTrend(samples: Sample[], plan: Plan, startMs: number, now: number, currentUsed: number): TrendPoint[] {
    const from = Math.max(startMs, plan.startedAt);
    if (from > now) {
        return [];
    }

    const remaining = (used: number): number => plan.budget - (used - plan.baseline);
    let usedAtFrom = plan.baseline;
    if (from > plan.startedAt) {
        const before = samples.filter((sample) => sample.ts <= from && sample.ts >= plan.startedAt);
        const firstAfter = samples.find((sample) => sample.ts > from);
        usedAtFrom = before.length > 0
            ? before[before.length - 1].used
            : firstAfter ? Math.max(firstAfter.used - (firstAfter.delta ?? 0), plan.baseline) : currentUsed;
    }

    const points: TrendPoint[] = [{ ts: from, remaining: remaining(usedAtFrom) }];
    for (const sample of samples) {
        if (sample.ts > from && sample.ts < now) {
            points.push({ ts: sample.ts, remaining: remaining(sample.used) });
        }
    }
    points.push({ ts: now, remaining: remaining(currentUsed) });
    return points;
}

// The ideal remaining budget at `ts`, assuming each day's allowance is spent evenly through that day.
export function getIdealRemaining(schedule: ScheduleDay[], budget: number, ts: number): number {
    for (const day of schedule) {
        const date = fromDayKey(day.day)!;
        const start = date.getTime();
        const end = nextDay(date).getTime();
        if (ts < start) {
            return budget - day.start;
        }
        if (ts < end) {
            return budget - (day.start + (day.allowance * (ts - start)) / (end - start));
        }
    }
    return schedule.length > 0 ? budget - schedule[schedule.length - 1].end : budget;
}

export function getDayStartMs(date: Date): number {
    return startOfDay(date).getTime();
}

export function getDayEndMs(date: Date): number {
    return nextDay(startOfDay(date)).getTime();
}
