import * as fs from 'fs';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { Plan, Sample, clampWeight, computeDelta } from './usage';

// Samples older than this are dropped when the store opens.
const RETENTION_MS = 1000 * 60 * 60 * 24 * 400;

export type FetchClaim = {
    claimed: boolean;
    // When the previous fetch (by any window) was started, if ever.
    lastFetchAt?: number;
};

export type RecordResult = { sample: Sample; changed: boolean };

// Shared state for every VS Code window: quota samples, planned day weights, the plan, and a fetch throttle.
export interface HistoryStore {
    readonly persistent: boolean;
    readonly location: string;
    // Atomically claims the right to call GitHub if nobody did in the last `minGapMs`.
    tryClaimFetch(minGapMs: number, now: number): FetchClaim;
    // After a failed fetch, lets the next claim with gap `intervalMs` succeed after `retryMs`.
    deferRetry(intervalMs: number, retryMs: number, now: number): void;
    // Stores a sample only when the value changed; always stamps the last successful refresh.
    recordSample(ts: number, used: number, limit: number): RecordResult;
    getLastSuccessAt(): number | undefined;
    getLatestSample(): Sample | undefined;
    getSamplesSince(ts: number): Sample[];
    getDayWeights(): Record<string, number>;
    // A null weight removes the override, returning those days to the weekday default.
    setDayWeights(days: string[], weight: number | null): void;
    getPlan(): Plan | undefined;
    setPlan(plan: Plan | undefined): void;
    close(): void;
}

type SampleRow = { ts: number; used: number; quota_limit: number; delta: number | null };

function toSample(row: SampleRow): Sample {
    return { ts: Number(row.ts), used: Number(row.used), limit: Number(row.quota_limit), delta: row.delta === null ? null : Number(row.delta) };
}

class SqliteHistoryStore implements HistoryStore {
    readonly persistent = true;

    constructor(private readonly db: DatabaseSync, readonly location: string) {
        db.exec(`
            PRAGMA busy_timeout = 3000;
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS samples (
                id INTEGER PRIMARY KEY,
                ts INTEGER NOT NULL,
                used REAL NOT NULL,
                quota_limit REAL NOT NULL,
                delta REAL
            );
            CREATE INDEX IF NOT EXISTS samples_ts ON samples (ts);
            CREATE TABLE IF NOT EXISTS day_weights (day TEXT PRIMARY KEY, weight REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        `);
        db.prepare('DELETE FROM samples WHERE ts < ?').run(Date.now() - RETENTION_MS);
    }

    private transaction<T>(work: () => T): T {
        // IMMEDIATE takes the write lock up front, so two windows cannot both pass a check-then-write.
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = work();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    private getMeta(key: string): string | undefined {
        const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
        return row?.value;
    }

    private setMeta(key: string, value: string | undefined): void {
        if (value === undefined) {
            this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
        } else {
            this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
        }
    }

    tryClaimFetch(minGapMs: number, now: number): FetchClaim {
        return this.transaction(() => {
            const raw = this.getMeta('last_fetch_at');
            const lastFetchAt = raw === undefined ? undefined : Number(raw);
            if (lastFetchAt !== undefined && now - lastFetchAt < minGapMs && lastFetchAt <= now) {
                return { claimed: false, lastFetchAt };
            }
            this.setMeta('last_fetch_at', String(now));
            return { claimed: true, lastFetchAt };
        });
    }

    deferRetry(intervalMs: number, retryMs: number, now: number): void {
        this.transaction(() => this.setMeta('last_fetch_at', String(now - intervalMs + retryMs)));
    }

    recordSample(ts: number, used: number, limit: number): RecordResult {
        return this.transaction(() => {
            this.setMeta('last_success_at', String(ts));
            const latest = this.getLatestSample();
            if (latest && latest.used === used && latest.limit === limit) {
                return { sample: latest, changed: false };
            }

            const sample: Sample = { ts, used, limit, delta: computeDelta(latest?.used, used) };
            this.db.prepare('INSERT INTO samples (ts, used, quota_limit, delta) VALUES (?, ?, ?, ?)').run(ts, used, limit, sample.delta);
            return { sample, changed: true };
        });
    }

    getLastSuccessAt(): number | undefined {
        const raw = this.getMeta('last_success_at');
        return raw === undefined ? undefined : Number(raw);
    }

    getLatestSample(): Sample | undefined {
        const row = this.db.prepare('SELECT ts, used, quota_limit, delta FROM samples ORDER BY ts DESC, id DESC LIMIT 1').get() as SampleRow | undefined;
        return row ? toSample(row) : undefined;
    }

    getSamplesSince(ts: number): Sample[] {
        const rows = this.db.prepare('SELECT ts, used, quota_limit, delta FROM samples WHERE ts >= ? ORDER BY ts, id').all(ts) as SampleRow[];
        return rows.map(toSample);
    }

    getDayWeights(): Record<string, number> {
        const rows = this.db.prepare('SELECT day, weight FROM day_weights').all() as { day: string; weight: number }[];
        return Object.fromEntries(rows.map((row) => [row.day, Number(row.weight)]));
    }

    setDayWeights(days: string[], weight: number | null): void {
        this.transaction(() => {
            const statement = weight === null
                ? this.db.prepare('DELETE FROM day_weights WHERE day = ?')
                : this.db.prepare('INSERT INTO day_weights (day, weight) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET weight = excluded.weight');
            for (const day of days) {
                if (weight === null) {
                    statement.run(day);
                } else {
                    statement.run(day, clampWeight(weight));
                }
            }
        });
    }

    getPlan(): Plan | undefined {
        const raw = this.getMeta('plan');
        if (!raw) {
            return undefined;
        }
        try {
            return JSON.parse(raw) as Plan;
        } catch {
            return undefined;
        }
    }

    setPlan(plan: Plan | undefined): void {
        this.transaction(() => this.setMeta('plan', plan === undefined ? undefined : JSON.stringify(plan)));
    }

    close(): void {
        this.db.close();
    }
}

// Used when node:sqlite is unavailable: same behaviour, but per window and lost on reload.
class MemoryHistoryStore implements HistoryStore {
    readonly persistent = false;
    readonly location = 'memory';
    private samples: Sample[] = [];
    private weights: Record<string, number> = {};
    private plan: Plan | undefined;
    private lastFetchAt: number | undefined;
    private lastSuccessAt: number | undefined;

    tryClaimFetch(minGapMs: number, now: number): FetchClaim {
        const lastFetchAt = this.lastFetchAt;
        if (lastFetchAt !== undefined && now - lastFetchAt < minGapMs && lastFetchAt <= now) {
            return { claimed: false, lastFetchAt };
        }
        this.lastFetchAt = now;
        return { claimed: true, lastFetchAt };
    }

    deferRetry(intervalMs: number, retryMs: number, now: number): void {
        this.lastFetchAt = now - intervalMs + retryMs;
    }

    recordSample(ts: number, used: number, limit: number): RecordResult {
        this.lastSuccessAt = ts;
        const latest = this.getLatestSample();
        if (latest && latest.used === used && latest.limit === limit) {
            return { sample: latest, changed: false };
        }
        const sample: Sample = { ts, used, limit, delta: computeDelta(latest?.used, used) };
        this.samples.push(sample);
        return { sample, changed: true };
    }

    getLastSuccessAt(): number | undefined {
        return this.lastSuccessAt;
    }

    getLatestSample(): Sample | undefined {
        return this.samples[this.samples.length - 1];
    }

    getSamplesSince(ts: number): Sample[] {
        return this.samples.filter((sample) => sample.ts >= ts);
    }

    getDayWeights(): Record<string, number> {
        return { ...this.weights };
    }

    setDayWeights(days: string[], weight: number | null): void {
        for (const day of days) {
            if (weight === null) {
                delete this.weights[day];
            } else {
                this.weights[day] = clampWeight(weight);
            }
        }
    }

    getPlan(): Plan | undefined {
        return this.plan;
    }

    setPlan(plan: Plan | undefined): void {
        this.plan = plan;
    }

    close(): void {}
}

export function createMemoryHistoryStore(): HistoryStore {
    return new MemoryHistoryStore();
}

// Opens (or creates) the SQLite store in `directory`; falls back to memory when SQLite is unavailable.
export async function openHistoryStore(directory: string, log: (message: string, error?: unknown) => void): Promise<HistoryStore> {
    const file = path.join(directory, 'history.sqlite');
    try {
        fs.mkdirSync(directory, { recursive: true });
        const sqlite = await import('node:sqlite');
        const store = new SqliteHistoryStore(new sqlite.DatabaseSync(file), file);
        log(`History store: ${file}.`);
        return store;
    } catch (error) {
        log('SQLite history store unavailable; keeping history in memory for this window only.', error);
        return new MemoryHistoryStore();
    }
}
