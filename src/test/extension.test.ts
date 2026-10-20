import * as assert from 'assert';

import {
    calculateUsagePercentage,
    getDailyBudget,
    getDayTimeline,
    getMonthTimeline,
    getWorkdayProgress
} from '../usage';

suite('Usage helpers', () => {
	test('usage percentage is safe', () => {
		assert.strictEqual(calculateUsagePercentage(12.5, 100), 12.5);
		assert.strictEqual(calculateUsagePercentage(10, 0), 0);
	});

	test('getWorkdayProgress counts only Monday to Friday', () => {
		// October 2026 has 22 weekdays; Tuesday the 20th is the 14th of them.
		assert.deepStrictEqual(getWorkdayProgress(new Date(2026, 9, 20)), { elapsed: 14, total: 22 });
	});

	test('getWorkdayProgress does not advance on weekends', () => {
		const friday = getWorkdayProgress(new Date(2026, 9, 23));
		const sunday = getWorkdayProgress(new Date(2026, 9, 25));
		assert.strictEqual(sunday.elapsed, friday.elapsed);
	});

	test('getWorkdayProgress is zero when the month starts on a weekend', () => {
		// 1 August 2026 is a Saturday.
		assert.deepStrictEqual(getWorkdayProgress(new Date(2026, 7, 1)), { elapsed: 0, total: 21 });
	});

	test('getDailyBudget compares usage with the current day slice of the allowance', () => {
		// 8000 credits over 20 workdays is 400 a day; on day 10, today's slice is 3600 to 4000.
		const progress = { elapsed: 10, total: 20 };
		assert.deepStrictEqual(getDailyBudget(2316, 8000, progress), { status: 'under', perDay: 400, amount: 1284 });
		assert.deepStrictEqual(getDailyBudget(3725, 8000, progress), { status: 'on_pace', perDay: 400, amount: 125 });
		assert.deepStrictEqual(getDailyBudget(6848, 8000, progress), { status: 'over', perDay: 400, amount: 2848 });
	});

	test('getDailyBudget on the first workday has no credits ahead', () => {
		const budget = getDailyBudget(100, 8000, { elapsed: 1, total: 20 });
		assert.deepStrictEqual(budget, { status: 'on_pace', perDay: 400, amount: 100 });
	});

	test('getMonthTimeline places the arrow on a 0 to limit bar with today marker', () => {
		const timeline = getMonthTimeline(2500, 10000, { elapsed: 10, total: 20 });
		assert.deepStrictEqual(timeline.arrow, { position: 0.25, overflow: 'none', delta: 0 });
		assert.strictEqual(timeline.marker, 0.5);
	});

	test('getMonthTimeline pins the arrow to the right edge past the limit', () => {
		const timeline = getMonthTimeline(10500, 10000, { elapsed: 20, total: 20 });
		assert.deepStrictEqual(timeline.arrow, { position: 1, overflow: 'right', delta: 500 });
	});

	test('getDayTimeline is zoomed on the slice and reports side arrows', () => {
		// 400 a day on day 10: slice is 3600 to 4000.
		const progress = { elapsed: 10, total: 20 };
		const noon = new Date(2026, 9, 20, 12, 0);
		assert.deepStrictEqual(getDayTimeline(3800, 8000, progress, noon).arrow, { position: 0.5, overflow: 'none', delta: 0 });
		assert.deepStrictEqual(getDayTimeline(2316, 8000, progress, noon).arrow, { position: 0, overflow: 'left', delta: 1284 });
		assert.deepStrictEqual(getDayTimeline(6848, 8000, progress, noon).arrow, { position: 1, overflow: 'right', delta: 2848 });
		assert.strictEqual(getDayTimeline(3800, 8000, progress, noon).marker, 0.5);
	});

	test('getDayTimeline marker is full on weekends', () => {
		const saturday = new Date(2026, 9, 24, 8, 0);
		assert.strictEqual(getDayTimeline(100, 8000, { elapsed: 10, total: 20 }, saturday).marker, 1);
	});
});
