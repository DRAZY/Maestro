/**
 * CUE-HISTORY-02 task #1 - `getCueHistoryEntries()` in `cue-stats-query.ts`.
 *
 * These run against a REAL SQLite database (`node:sqlite`, via the shim in
 * `src/__tests__/helpers/nodeSqlite.ts`) rather than a mocked statement
 * recorder, because the thing under test IS the SQL: the predicate
 * `output_excerpt IS NOT NULL OR status != 'completed'` decides which Cue runs
 * reach the History panel at all. A mock that records the query string would
 * assert that we typed it, not that it selects the right rows.
 *
 * The three cases that matter, straight from `CUE_EVENT_WORTH_SHOWING_SQL`:
 *   - a chatty run appears (there is something to read)
 *   - a silent successful run does NOT (a heartbeat with nothing to say -
 *     thousands per week of those are what buried real entries)
 *   - a silent FAILED run DOES (valuable precisely because it printed nothing)
 *
 * Timestamps are driven with fake `Date` so `created_at` / `completed_at`,
 * which the DB module stamps itself, stay deterministic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import { canLoadNodeSqlite, nodeSqliteBetterSqlite3Mock } from '../../helpers/nodeSqlite';

vi.mock('better-sqlite3', () => nodeSqliteBetterSqlite3Mock());

vi.mock('electron', () => ({
	app: { getPath: vi.fn(() => os.tmpdir()) },
}));

// The aggregation half of cue-stats-query reaches into per-agent session
// storage on import; stub it so this suite only pulls in the SQL path.
vi.mock('../../../main/cue/stats/cue-token-accessor', () => ({
	getSessionTokenSummaries: vi.fn(async () => new Map()),
	getAgentTypesForSessions: vi.fn(() => new Map()),
}));

import {
	initCueDb,
	closeCueDb,
	recordCueEvent,
	updateCueEventStatus,
	getCueEventsForHistory,
} from '../../../main/cue/cue-db';
import { getCueHistoryEntries } from '../../../main/cue/stats/cue-stats-query';
import type { HistoryEntry } from '../../../shared/types';

const AGENT_ID = 'agent-rc';
const OTHER_AGENT_ID = 'agent-main';
const BASE_MS = 1_700_000_000_000;

interface SeedOptions {
	id: string;
	sessionId?: string;
	type?: string;
	triggerName?: string;
	subscriptionName?: string;
	/** Terminal status. Omit to leave the run in flight (`running`). */
	status?: 'completed' | 'failed' | 'timeout' | 'stopped';
	outputExcerpt?: string | null;
	fullOutput?: string | null;
	/** Raw payload column value; pass a non-JSON string to test tolerance. */
	payload?: string;
	/** `created_at` for the row. Defaults to {@link BASE_MS}. */
	createdAt?: number;
	/** `completed_at`. Defaults to `createdAt`, i.e. a zero-duration run. */
	completedAt?: number;
}

/**
 * Insert a run the way the engine does - a `running` row at dispatch, then a
 * status flip carrying the completion columns - so the test exercises the same
 * two-write path production uses instead of hand-crafting a final row.
 */
function seedRun(opts: SeedOptions): void {
	const createdAt = opts.createdAt ?? BASE_MS;
	vi.setSystemTime(createdAt);
	recordCueEvent({
		id: opts.id,
		type: opts.type ?? 'time.heartbeat',
		triggerName: opts.triggerName ?? 'Pedsidian-Command-Bus',
		sessionId: opts.sessionId ?? AGENT_ID,
		subscriptionName: opts.subscriptionName ?? 'Pedsidian-Command-Bus',
		status: 'running',
		payload: opts.payload,
	});

	if (!opts.status) return;

	vi.setSystemTime(opts.completedAt ?? createdAt);
	updateCueEventStatus(opts.id, opts.status, undefined, {
		outputExcerpt: opts.outputExcerpt ?? null,
		fullOutput: opts.fullOutput ?? null,
	});
}

const idsOf = (entries: HistoryEntry[]): string[] => entries.map((entry) => entry.id);

describe.skipIf(!canLoadNodeSqlite())('getCueHistoryEntries (real SQLite)', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(BASE_MS);
		closeCueDb();
		initCueDb(undefined, ':memory:');
	});

	afterEach(() => {
		closeCueDb();
		vi.useRealTimers();
	});

	it('returns a chatty run, hides a silent success, keeps a silent failure', () => {
		seedRun({ id: 'chatty', status: 'completed', outputExcerpt: 'Synced 4 notes.' });
		seedRun({ id: 'silent-ok', status: 'completed', outputExcerpt: null });
		seedRun({ id: 'silent-fail', status: 'failed', outputExcerpt: null });

		const ids = idsOf(getCueHistoryEntries({ sessionId: AGENT_ID }));

		expect(ids).toContain('chatty');
		expect(ids).toContain('silent-fail');
		expect(ids).not.toContain('silent-ok');
	});

	it('maps every HistoryEntry field off the row', () => {
		seedRun({
			id: 'mapped',
			type: 'agent.completed',
			subscriptionName: 'PR Triage Main',
			status: 'completed',
			outputExcerpt: 'Triaged PR #891.',
			fullOutput: 'Triaged PR #891.\nNo action needed.',
			payload: JSON.stringify({ sourceSession: 'builder' }),
			createdAt: BASE_MS,
			completedAt: BASE_MS + 12_500,
		});

		const [entry] = getCueHistoryEntries({
			sessionId: AGENT_ID,
			sessionName: 'rc',
			projectPath: '/Users/pedram/Projects/Maestro',
		});

		expect(entry).toMatchObject({
			id: 'mapped',
			type: 'CUE',
			timestamp: BASE_MS,
			summary: 'Triaged PR #891.',
			fullResponse: 'Triaged PR #891.\nNo action needed.',
			projectPath: '/Users/pedram/Projects/Maestro',
			sessionId: AGENT_ID,
			sessionName: 'rc',
			success: true,
			elapsedTimeMs: 12_500,
			cueTriggerName: 'PR Triage Main',
			cueEventType: 'agent.completed',
			cueSourceSession: 'builder',
		});
	});

	it('falls back to the trigger-label summary for a silent failure', () => {
		seedRun({
			id: 'quiet-timeout',
			subscriptionName: 'Nightly Sync',
			status: 'timeout',
			outputExcerpt: null,
		});

		const [entry] = getCueHistoryEntries({ sessionId: AGENT_ID, sessionName: 'rc' });

		expect(entry.summary).toBe('"Nightly Sync" · rc');
		expect(entry.success).toBe(false);
		expect(entry.fullResponse).toBeUndefined();
	});

	it('treats an in-flight run as unsuccessful and leaves its duration unset', () => {
		seedRun({ id: 'in-flight', subscriptionName: 'Nightly Sync' });

		const [entry] = getCueHistoryEntries({ sessionId: AGENT_ID, sessionName: 'rc' });

		expect(entry.id).toBe('in-flight');
		expect(entry.success).toBe(false);
		expect(entry.elapsedTimeMs).toBeUndefined();
	});

	it('scopes to one agent and sorts newest first', () => {
		seedRun({ id: 'older', status: 'completed', outputExcerpt: 'a', createdAt: BASE_MS });
		seedRun({ id: 'newer', status: 'completed', outputExcerpt: 'b', createdAt: BASE_MS + 5_000 });
		seedRun({
			id: 'other-agent',
			sessionId: OTHER_AGENT_ID,
			status: 'completed',
			outputExcerpt: 'c',
			createdAt: BASE_MS + 9_000,
		});

		expect(idsOf(getCueHistoryEntries({ sessionId: AGENT_ID }))).toEqual(['newer', 'older']);
	});

	it('honors the since / until window and the row cap', () => {
		seedRun({ id: 'r1', status: 'completed', outputExcerpt: 'a', createdAt: BASE_MS + 1_000 });
		seedRun({ id: 'r2', status: 'completed', outputExcerpt: 'b', createdAt: BASE_MS + 2_000 });
		seedRun({ id: 'r3', status: 'completed', outputExcerpt: 'c', createdAt: BASE_MS + 3_000 });

		const windowed = getCueHistoryEntries({
			sessionId: AGENT_ID,
			since: BASE_MS + 2_000,
			until: BASE_MS + 3_000,
		});
		expect(idsOf(windowed)).toEqual(['r2']);

		const capped = getCueEventsForHistory({ sessionId: AGENT_ID, limit: 2 });
		expect(capped.map((event) => event.id)).toEqual(['r3', 'r2']);
	});

	it('survives a corrupt payload instead of throwing', () => {
		seedRun({ id: 'corrupt', status: 'failed', outputExcerpt: null, payload: '{not json' });

		const [entry] = getCueHistoryEntries({ sessionId: AGENT_ID, sessionName: 'rc' });

		expect(entry.id).toBe('corrupt');
		expect(entry.cueSourceSession).toBeUndefined();
	});

	it('returns nothing once the database is closed rather than throwing', () => {
		seedRun({ id: 'chatty', status: 'completed', outputExcerpt: 'Synced.' });
		closeCueDb();

		expect(getCueHistoryEntries({ sessionId: AGENT_ID })).toEqual([]);
	});
});
