export type PaceStatus = 'under' | 'on_pace' | 'over';

export type WorkdayProgress = {
    elapsed: number;
    total: number;
};

export function calculateUsagePercentage(totalUsed: number, limit: number): number {
    if (limit <= 0) {
        return 0;
    }

    return (totalUsed / limit) * 100;
}

function isWeekday(date: Date): boolean {
    const day = date.getDay();
    return day !== 0 && day !== 6;
}

// Counts Monday-Friday days in the month of `now`: `elapsed` up to and including today, `total` for the whole month.
export function getWorkdayProgress(now: Date = new Date()): WorkdayProgress {
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    let elapsed = 0;
    let total = 0;

    for (let day = 1; day <= daysInMonth; day++) {
        if (!isWeekday(new Date(now.getFullYear(), now.getMonth(), day))) {
            continue;
        }

        total++;
        if (day <= now.getDate()) {
            elapsed++;
        }
    }

    return { elapsed, total };
}

export type DailyBudget = {
    status: PaceStatus;
    // Credits allowed per workday: the limit spread evenly over the month's workdays.
    perDay: number;
    // under: credits ahead of today's slice; on_pace: credits spent inside today's slice; over: credits past it.
    amount: number;
};

// Today's slice of the budget runs from the allowance through yesterday to the allowance through today.
export function getDailyBudget(used: number, limit: number, progress: WorkdayProgress): DailyBudget {
    const perDay = progress.total > 0 ? limit / progress.total : 0;
    const budgetStart = perDay * Math.max(progress.elapsed - 1, 0);
    const budgetEnd = perDay * progress.elapsed;

    if (used > budgetEnd) {
        return { status: 'over', perDay, amount: used - budgetEnd };
    }

    if (used < budgetStart) {
        return { status: 'under', perDay, amount: budgetStart - used };
    }

    return { status: 'on_pace', perDay, amount: used - budgetStart };
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

// The month bar spans 0 to the limit; the marker sits at the allowance through today.
export function getMonthTimeline(used: number, limit: number, progress: WorkdayProgress): Timeline {
    const allowanceToday = progress.total > 0 ? (limit / progress.total) * progress.elapsed : 0;

    return {
        start: 0,
        end: limit,
        arrow: placeArrow(used, 0, limit),
        marker: limit > 0 ? Math.min(allowanceToday / limit, 1) : 0
    };
}

// The day bar spans today's slice of the allowance; the marker is the time of day (full on weekends).
export function getDayTimeline(used: number, limit: number, progress: WorkdayProgress, now: Date = new Date()): Timeline {
    const perDay = progress.total > 0 ? limit / progress.total : 0;
    const start = perDay * Math.max(progress.elapsed - 1, 0);
    const end = perDay * progress.elapsed;
    const isWeekend = now.getDay() === 0 || now.getDay() === 6;
    const timeOfDay = (now.getHours() + now.getMinutes() / 60) / 24;

    return {
        start,
        end,
        arrow: placeArrow(used, start, end),
        marker: isWeekend ? 1 : timeOfDay
    };
}
