import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { openHistoryStore } from '../history';
import {
    Plan,
    Sample,
    buildSchedule,
    calculateUsagePercentage,
    computeDelta,
    defaultPlan,
    estimateUsedAtDayStart,
    getBucketedConsumption,
    getDailyBudget,
    getDailyConsumption,
    getDayTimeline,
    getIdealRemaining,
    getMonthTimeline,
    getPlanProgress,
    getRemainingTrend,
    resetPlanToNow
} from '../usage';

// October 2026: 22 weekdays; Tuesday the 20th is the 14th of them.
const OCTOBER = defaultPlan(new Date(2026, 9, 15), 22000);

function progressOn(date: Date, plan: Plan = OCTOBER, weights: Record<string, number> = {}) {
    return getPlanProgress(buildSchedule(plan, weights), date);
}

suite('Usage helpers', () => {
	test('usage percentage is safe', () => {
		assert.strictEqual(calculateUsagePercentage(12.5, 100), 12.5);
		assert.strictEqual(calculateUsagePercentage(10, 0), 0);
	});

	test('the default plan spans the whole month with the full limit', () => {
		assert.deepStrictEqual(
			{ from: OCTOBER.from, to: OCTOBER.to, budget: OCTOBER.budget, baseline: OCTOBER.baseline, period: OCTOBER.period },
			{ from: '2026-10-01', to: '2026-10-31', budget: 22000, baseline: 0, period: '2026-10' });
	});

	test('plan progress counts Monday to Friday by default', () => {
		const progress = progressOn(new Date(2026, 9, 20, 12));
		assert.strictEqual(progress.elapsed, 14);
		assert.strictEqual(progress.total, 22);
		assert.strictEqual(progress.perDay, 1000);
		assert.strictEqual(progress.sliceStart, 13000);
		assert.strictEqual(progress.sliceEnd, 14000);
	});

	test('plan progress does not advance on weekends', () => {
		const friday = progressOn(new Date(2026, 9, 23));
		const sunday = progressOn(new Date(2026, 9, 25));
		assert.strictEqual(sunday.elapsed, friday.elapsed);
		assert.strictEqual(sunday.perDay, 0);
		assert.strictEqual(sunday.workingToday, false);
	});

	test('planned days off spread the budget over the remaining workdays', () => {
		// Two days off and one half day leave 19.5 workdays.
		const weights = { '2026-10-05': 0, '2026-10-06': 0, '2026-10-07': 0.5 };
		const schedule = buildSchedule(OCTOBER, weights);
		const total = schedule.reduce((sum, day) => sum + day.weight, 0);
		assert.strictEqual(total, 19.5);
		assert.ok(Math.abs(schedule[schedule.length - 1].end - 22000) < 1e-6);
		assert.strictEqual(schedule.find((day) => day.day === '2026-10-05')?.allowance, 0);
		assert.ok(schedule.find((day) => day.day === '2026-10-07')?.custom);

		const progress = progressOn(new Date(2026, 9, 6), OCTOBER, weights);
		assert.strictEqual(progress.perDay, 0);
		assert.strictEqual(progress.workingToday, false);
	});

	test('a weekend day can be planned as a workday', () => {
		const schedule = buildSchedule(OCTOBER, { '2026-10-03': 1 });
		assert.strictEqual(schedule.reduce((sum, day) => sum + day.weight, 0), 23);
	});

	test('getDailyBudget compares plan usage with today\'s slice', () => {
		// 1000 a day on workday 14: today's slice is 13000 to 14000.
		const progress = progressOn(new Date(2026, 9, 20, 12));
		assert.deepStrictEqual(getDailyBudget(9000, progress), { status: 'under', perDay: 1000, amount: 4000 });
		assert.deepStrictEqual(getDailyBudget(13250, progress), { status: 'on_pace', perDay: 1000, amount: 250 });
		assert.deepStrictEqual(getDailyBudget(15000, progress), { status: 'over', perDay: 1000, amount: 1000 });
	});

	test('resetting to today starts a fresh plan with what is left', () => {
		const now = new Date(2026, 9, 20, 10, 30);
		const plan = resetPlanToNow(OCTOBER, 16000, 22000, now);
		assert.strictEqual(plan.from, '2026-10-20');
		assert.strictEqual(plan.to, '2026-10-31');
		assert.strictEqual(plan.budget, 6000);
		assert.strictEqual(plan.baseline, 16000);
		assert.strictEqual(plan.startedAt, now.getTime());

		// 6000 over the 9 weekdays from the 20th to the 30th; nothing used since the reset.
		const progress = progressOn(now, plan);
		assert.strictEqual(progress.total, 9);
		assert.deepStrictEqual(getDailyBudget(16000 - plan.baseline, progress), { status: 'on_pace', perDay: 6000 / 9, amount: 0 });
	});

	test('getMonthTimeline places the arrow on a 0 to budget bar with today marker', () => {
		const progress = progressOn(new Date(2026, 9, 20, 12));
		const timeline = getMonthTimeline(5500, 22000, progress);
		assert.deepStrictEqual(timeline.arrow, { position: 0.25, overflow: 'none', delta: 0 });
		assert.strictEqual(timeline.marker, 14000 / 22000);
		assert.deepStrictEqual(getMonthTimeline(23000, 22000, progress).arrow, { position: 1, overflow: 'right', delta: 1000 });
	});

	test('getDayTimeline is zoomed on the slice and reports side arrows', () => {
		const noon = new Date(2026, 9, 20, 12, 0);
		const progress = progressOn(noon);
		assert.deepStrictEqual(getDayTimeline(13500, progress, noon).arrow, { position: 0.5, overflow: 'none', delta: 0 });
		assert.deepStrictEqual(getDayTimeline(12000, progress, noon).arrow, { position: 0, overflow: 'left', delta: 1000 });
		assert.deepStrictEqual(getDayTimeline(14500, progress, noon).arrow, { position: 1, overflow: 'right', delta: 500 });
		assert.strictEqual(getDayTimeline(13500, progress, noon).marker, 0.5);
	});

	test('getDayTimeline marker is full on days off', () => {
		const saturday = new Date(2026, 9, 24, 8, 0);
		assert.strictEqual(getDayTimeline(100, progressOn(saturday), saturday).marker, 1);
	});
});

suite('History helpers', () => {
	const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
	const samples: Sample[] = [
		{ ts: at(19, 9), used: 1000, limit: 22000, delta: null },
		{ ts: at(19, 17), used: 1400, limit: 22000, delta: 400 },
		{ ts: at(20, 9, 5), used: 1500, limit: 22000, delta: 100 },
		{ ts: at(20, 9, 20), used: 1800, limit: 22000, delta: 300 }
	];

	test('computeDelta handles the first sample and quota resets', () => {
		assert.strictEqual(computeDelta(undefined, 10), null);
		assert.strictEqual(computeDelta(10, 25), 15);
		assert.strictEqual(computeDelta(5000, 30), 30);
	});

	test('consumption is grouped per day and per bucket', () => {
		const daily = getDailyConsumption(samples);
		assert.strictEqual(daily.get('2026-10-19'), 400);
		assert.strictEqual(daily.get('2026-10-20'), 400);

		const buckets = getBucketedConsumption(samples, at(20, 0), at(21, 0), 96);
		assert.strictEqual(buckets[36], 100);
		assert.strictEqual(buckets[37], 300);
		assert.strictEqual(buckets.reduce((sum, value) => sum + value, 0), 400);
	});

	test('estimateUsedAtDayStart uses the last sample before the day', () => {
		const periodStart = at(1, 0);
		assert.strictEqual(estimateUsedAtDayStart(samples, '2026-10-20', periodStart), 1400);
		assert.strictEqual(estimateUsedAtDayStart(samples, '2026-10-01', periodStart), 0);
		// No sample before the 19th: the value just before the first sample is unknown, so it is that sample's value.
		assert.strictEqual(estimateUsedAtDayStart(samples, '2026-10-19', periodStart), 1000);
		assert.strictEqual(estimateUsedAtDayStart([], '2026-10-19', periodStart), undefined);
	});

	test('getRemainingTrend follows the samples from the plan start', () => {
		const trend = getRemainingTrend(samples, OCTOBER, at(20, 0), at(20, 12), 1800);
		assert.deepStrictEqual(trend.map((point) => point.remaining), [20600, 20500, 20200, 20200]);
		assert.strictEqual(trend[0].ts, at(20, 0));
	});

	test('getIdealRemaining spends each day evenly', () => {
		const schedule = buildSchedule(OCTOBER, {});
		assert.strictEqual(getIdealRemaining(schedule, 22000, at(20, 0)), 22000 - 13000);
		assert.strictEqual(getIdealRemaining(schedule, 22000, at(20, 12)), 22000 - 13500);
		assert.strictEqual(getIdealRemaining(schedule, 22000, at(24, 12)), 22000 - 17000);
	});
});

suite('History store', () => {
	let directory: string;

	setup(() => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-tracker-'));
	});

	teardown(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('records only changed samples with deltas', async () => {
		const store = await openHistoryStore(directory, () => undefined);
		try {
			assert.strictEqual(store.persistent, true);
			assert.strictEqual(store.recordSample(1000, 10, 100).sample.delta, null);
			assert.strictEqual(store.recordSample(2000, 10, 100).changed, false);
			assert.strictEqual(store.recordSample(3000, 25, 100).sample.delta, 15);
			assert.deepStrictEqual(store.getSamplesSince(0).map((sample) => sample.used), [10, 25]);
			assert.strictEqual(store.getLastSuccessAt(), 3000);
		} finally {
			store.close();
		}
	});

	test('the fetch claim is shared between connections', async () => {
		const first = await openHistoryStore(directory, () => undefined);
		const second = await openHistoryStore(directory, () => undefined);
		try {
			assert.strictEqual(first.tryClaimFetch(15000, 100000).claimed, true);
			assert.strictEqual(second.tryClaimFetch(15000, 105000).claimed, false);
			assert.strictEqual(second.tryClaimFetch(15000, 116000).claimed, true);

			// After a failure the next claim with the full interval is allowed after the retry delay.
			second.deferRetry(300000, 60000, 116000);
			assert.strictEqual(first.tryClaimFetch(300000, 170000).claimed, false);
			assert.strictEqual(first.tryClaimFetch(300000, 177000).claimed, true);
		} finally {
			first.close();
			second.close();
		}
	});

	test('stores day weights and the plan', async () => {
		const store = await openHistoryStore(directory, () => undefined);
		try {
			store.setDayWeights(['2026-10-05', '2026-10-06'], 0);
			store.setDayWeights(['2026-10-06'], null);
			store.setDayWeights(['2026-10-07'], 1.7);
			assert.deepStrictEqual(store.getDayWeights(), { '2026-10-05': 0, '2026-10-07': 1 });

			store.setPlan(OCTOBER);
			assert.deepStrictEqual(store.getPlan(), OCTOBER);
			store.setPlan(undefined);
			assert.strictEqual(store.getPlan(), undefined);
		} finally {
			store.close();
		}
	});
});
