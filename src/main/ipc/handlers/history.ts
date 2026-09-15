/**
 * History IPC Handlers
 *
 * These handlers provide history persistence operations using the per-session
 * HistoryManager for improved scalability and session isolation.
 *
 * Features:
 * - 5,000 entries per session (up from 1,000 global)
 * - Per-session file storage in history/ directory
 * - Cross-session queries for global views
 * - Pagination support for large datasets
 * - Context integration for AI agents via history:getFilePath
 */

import { ipcMain } from 'electron';
import { logger } from '../../utils/logger';
import { HistoryEntry, HistoryEntryType, SshRemoteConfig } from '../../../shared/types';
import {
	PaginationOptions,
	ORPHANED_SESSION_ID,
	sortEntriesByTimestamp,
	paginateEntries,
} from '../../../shared/history';
import { getHistoryManager } from '../../history-manager';
import {
	writeEntryRemote,
	writeEntryLocal,
	readRemoteEntriesSsh,
	readRemoteEntriesLocal,
	hasLocalSharedHistory,
} from '../../shared-history-manager';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';
import type { SafeSendFn } from '../../utils/safe-send';
import { captureException } from '../../utils/sentry';
import {
	getHistoryBucketCache,
	fileFingerprint,
	HISTORY_BUCKET_CACHE_VERSION,
	type CachedGraphBucket,
} from '../../utils/history-bucket-cache';
import { buildBucketAggregate, LOCAL_HOST_AGG_KEY } from '../../utils/history-bucket-builder';
import type { CueHistoryQuery } from '../../cue/stats/cue-stats-query';

const LOG_CONTEXT = '[History]';

/** Context passed from the renderer for shared history operations */
export interface SharedHistoryContext {
	sshRemoteId: string;
	remoteCwd: string;
}

/**
 * Aggregated graph data returned by `history:getGraphData` and
 * `director-notes:getGraphData`. Buckets are computed over the full source
 * history (not the renderer's lookback window) so the graph view stays
 * "all-encompassing" while the entry list paginates beneath it.
 */
export interface HistoryGraphData {
	buckets: CachedGraphBucket[];
	bucketCount: number;
	earliestTimestamp: number;
	latestTimestamp: number;
	totalCount: number;
	autoCount: number;
	userCount: number;
	cueCount: number;
	/**
	 * Per-host entry counts in the same window the buckets cover. Key is
	 * the entry's `hostname`, or `"__local__"` for entries with no
	 * hostname. Lookback-aware via the same `lookbackMs` that bucketing
	 * uses, so flipping the renderer's lookback selector updates these
	 * numbers too.
	 */
	hostCounts: Record<string, number>;
	/** True when served from the disk cache (diagnostics only). */
	cached: boolean;
}

/** Internal: shape returned by `buildBucketAggregate`. */
interface BucketAggregateLike {
	buckets: CachedGraphBucket[];
	earliestTimestamp: number;
	latestTimestamp: number;
	totalCount: number;
	autoCount: number;
	userCount: number;
	cueCount: number;
	hostCounts: Record<string, number>;
}

function aggregateToGraphData(
	agg: BucketAggregateLike,
	bucketCount: number,
	cached: boolean
): HistoryGraphData {
	return {
		buckets: agg.buckets,
		bucketCount,
		earliestTimestamp: agg.earliestTimestamp,
		latestTimestamp: agg.latestTimestamp,
		totalCount: agg.totalCount,
		autoCount: agg.autoCount,
		userCount: agg.userCount,
		cueCount: agg.cueCount,
		hostCounts: agg.hostCounts,
		cached,
	};
}

function cachedToGraphData(
	cached: {
		buckets: CachedGraphBucket[];
		bucketCount: number;
		earliestTimestamp: number;
		latestTimestamp: number;
		totalCount: number;
		autoCount: number;
		userCount: number;
		cueCount: number;
		hostCounts: Record<string, number>;
	},
	fromCache: boolean
): HistoryGraphData {
	return {
		buckets: cached.buckets,
		bucketCount: cached.bucketCount,
		earliestTimestamp: cached.earliestTimestamp,
		latestTimestamp: cached.latestTimestamp,
		totalCount: cached.totalCount,
		autoCount: cached.autoCount,
		userCount: cached.userCount,
		cueCount: cached.cueCount,
		hostCounts: cached.hostCounts,
		cached: fromCache,
	};
}

export interface HistoryHandlerDependencies {
	safeSend: SafeSendFn;
	/** Returns the user's maxLogBuffer setting (used as max entries per session) */
	getMaxEntries?: () => number;
	/** Resolve an SSH remote config by ID */
	getSshRemoteById?: (id: string) => SshRemoteConfig | undefined;
	/**
	 * Resolve a session record by id. Used to check the per-session
	 * `shareHistoryToProjectDir` flag when deciding whether to mirror an entry
	 * into `<project>/.maestro/history/history-<hostname>.jsonl` on the local
	 * filesystem so other Maestro instances reading the same project directory
	 * (typically via SSH) can see it.
	 */
	getSessionById?: (id: string) => Record<string, unknown> | undefined;
	/**
	 * Every session record, used only to resolve which agents a project-wide or
	 * global read covers. `cue_events` rows know their agent but not its
	 * directory, so the sessions store is the only place that mapping exists.
	 */
	getAllSessions?: () => Array<Record<string, unknown>>;
	/**
	 * Cue runs for one agent, already shaped as {@link HistoryEntry} - see
	 * `getCueHistoryEntries()` in `src/main/cue/stats/cue-stats-query.ts`.
	 *
	 * Injected rather than imported so this module keeps no static edge to the
	 * Cue SQLite layer (`better-sqlite3` is a native binding built for
	 * Electron's ABI, and History is exercised well outside that runtime).
	 * Omitted means History serves JSONL entries only.
	 */
	getCueHistoryEntries?: (query: CueHistoryQuery) => HistoryEntry[];
}

/** The agent metadata a Cue history query needs, resolved from the store. */
interface CueScopeAgent {
	id: string;
	name?: string;
	projectPath?: string;
}

/** Read a string field off a loosely-typed session record. */
function sessionField(
	record: Record<string, unknown> | undefined,
	key: string
): string | undefined {
	const value = record?.[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Which agents' Cue runs belong in a given read.
 *
 * The single-session scope is the one the History panel uses; the project and
 * global scopes walk the sessions store because an agent's directory lives
 * there, not on the `cue_events` row.
 */
function cueScopeAgents(
	deps: HistoryHandlerDependencies,
	sessionId?: string,
	projectPath?: string
): CueScopeAgent[] {
	if (!deps.getCueHistoryEntries) return [];

	if (sessionId) {
		const record = deps.getSessionById?.(sessionId);
		return [
			{
				id: sessionId,
				name: sessionField(record, 'name'),
				projectPath:
					sessionField(record, 'projectRoot') ?? sessionField(record, 'cwd') ?? projectPath,
			},
		];
	}

	const agents: CueScopeAgent[] = [];
	for (const record of deps.getAllSessions?.() ?? []) {
		const id = sessionField(record, 'id');
		if (!id) continue;
		const dir = sessionField(record, 'projectRoot') ?? sessionField(record, 'cwd');
		if (projectPath && dir !== projectPath) continue;
		agents.push({ id, name: sessionField(record, 'name'), projectPath: dir });
	}
	return agents;
}

/**
 * Cue runs for the agents in scope, as history rows.
 *
 * A DB failure here degrades to "no Cue rows" rather than failing the whole
 * read: the JSONL half of a user's history must stay readable even when the
 * Cue database is missing, locked, or was never initialized.
 */
function readCueEntries(
	deps: HistoryHandlerDependencies,
	agents: CueScopeAgent[],
	options: { since?: number } = {}
): HistoryEntry[] {
	const query = deps.getCueHistoryEntries;
	if (!query || agents.length === 0) return [];

	const limit = deps.getMaxEntries?.();
	const entries: HistoryEntry[] = [];
	for (const agent of agents) {
		try {
			entries.push(
				...query({
					sessionId: agent.id,
					sessionName: agent.name,
					projectPath: agent.projectPath,
					since: options.since,
					limit,
				})
			);
		} catch (error) {
			void captureException(error);
			logger.warn(`Failed to read Cue history for session ${agent.id}: ${error}`, LOG_CONTEXT);
		}
	}
	return entries;
}

/**
 * Widest plausible gap between when a Cue run was dispatched (the DB row's
 * `created_at`) plus its measured duration, and when the JSONL writer stamped
 * the completed run. Duration is sleep-aware while the two clocks are not, so
 * the tolerance is generous; it only has to be tighter than the interval
 * between two runs of the same trigger producing identical output.
 */
const CUE_DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

/**
 * A Cue run's identity as far as two writers of the same run agree on it. The
 * JSONL entry and the DB row carry byte-identical summaries - both come from
 * `buildCuePersistedOutput()` - but different ids and different timestamps, so
 * id dedupe cannot see the overlap.
 */
function cueDuplicateKey(entry: HistoryEntry): string {
	return [
		entry.sessionId,
		entry.cueTriggerName ?? '',
		entry.cueEventType ?? '',
		entry.summary,
	].join(' ');
}

/**
 * Drop DB-sourced Cue rows that the JSONL file already carries.
 *
 * Needed for the window where both writers are live, and afterwards for the
 * runs already written to JSONL before the Cue writes were removed: those
 * entries stay on disk (they are the only record once a run ages past the Cue
 * retention window) and would otherwise render twice.
 *
 * Each JSONL entry suppresses at most ONE database row, matched to the nearest
 * completion time. That matters for a trigger that says the same thing every
 * few minutes - N identical JSONL entries must hide N rows, not collapse the
 * whole series into one.
 */
function dropCueRowsAlreadyInJsonl(
	jsonlEntries: HistoryEntry[],
	cueRows: HistoryEntry[]
): HistoryEntry[] {
	if (cueRows.length === 0) return cueRows;

	const jsonlTimestamps = new Map<string, number[]>();
	for (const entry of jsonlEntries) {
		if (entry.type !== 'CUE') continue;
		const key = cueDuplicateKey(entry);
		const bucket = jsonlTimestamps.get(key);
		if (bucket) bucket.push(entry.timestamp);
		else jsonlTimestamps.set(key, [entry.timestamp]);
	}
	if (jsonlTimestamps.size === 0) return cueRows;

	return cueRows.filter((row) => {
		const bucket = jsonlTimestamps.get(cueDuplicateKey(row));
		if (!bucket || bucket.length === 0) return true;

		// The DB row is stamped at dispatch; the JSONL entry was stamped when
		// the run finished, so compare against the row's completion time.
		const finishedAt = row.timestamp + (row.elapsedTimeMs ?? 0);
		let matchIndex = -1;
		let smallestDelta = CUE_DUPLICATE_WINDOW_MS;
		for (let i = 0; i < bucket.length; i++) {
			const delta = Math.abs(bucket[i] - finishedAt);
			if (delta <= smallestDelta) {
				smallestDelta = delta;
				matchIndex = i;
			}
		}
		if (matchIndex === -1) return true;
		bucket.splice(matchIndex, 1);
		return false;
	});
}

/**
 * Append `incoming` to `base`, skipping ids already present, and sort
 * newest-first. The same merge the shared-history overlay uses, shared so the
 * Cue rows join the list exactly the way foreign-host entries do.
 */
function mergeEntriesById(base: HistoryEntry[], incoming: HistoryEntry[]): HistoryEntry[] {
	if (incoming.length === 0) return base;

	const seenIds = new Set(base.map((entry) => entry.id));
	const merged = [...base];
	for (const entry of incoming) {
		if (seenIds.has(entry.id)) continue;
		seenIds.add(entry.id);
		merged.push(entry);
	}
	return sortEntriesByTimestamp(merged);
}

// Helper to create handler options with consistent context
const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * Register all History-related IPC handlers.
 *
 * These handlers provide history persistence operations:
 * - Get all history entries (with optional project/session filtering and pagination)
 * - Add new history entry
 * - Clear history (all, by project, or by session)
 * - Delete individual history entry
 * - Update history entry (e.g., setting validated flag)
 * - Get history file path (for AI context integration)
 * - List sessions with history
 */
export function registerHistoryHandlers(deps: HistoryHandlerDependencies): void {
	const historyManager = getHistoryManager();

	// Get all history entries, optionally filtered by project and/or session
	// Legacy handler - returns all entries (use history:getAllPaginated for large datasets)
	ipcMain.handle(
		'history:getAll',
		withIpcErrorLogging(
			handlerOpts('getAll'),
			async (projectPath?: string, sessionId?: string, sharedContext?: SharedHistoryContext) => {
				const maxEntries = deps.getMaxEntries?.();
				let localEntries: HistoryEntry[];

				if (sessionId) {
					// Get entries for specific session only - don't include orphaned entries
					// to prevent history bleeding across different agent sessions in the same directory
					localEntries = await historyManager.getEntries(sessionId);
					localEntries.sort((a, b) => b.timestamp - a.timestamp);
				} else if (projectPath) {
					localEntries = await historyManager.getEntriesByProjectPath(projectPath);
				} else {
					localEntries = await historyManager.getAllEntries();
				}

				// Merge shared history entries from other hosts
				let sharedEntries: HistoryEntry[] = [];
				try {
					if (sharedContext?.sshRemoteId && sharedContext?.remoteCwd) {
						// SSH session with syncHistory enabled: read shared files from remote host
						const sshRemote = deps.getSshRemoteById?.(sharedContext.sshRemoteId);
						if (sshRemote) {
							sharedEntries = await readRemoteEntriesSsh(
								sharedContext.remoteCwd,
								sshRemote,
								maxEntries
							);
						}
					} else if (projectPath) {
						// Local session: read .maestro/history/ from project dir
						// to see entries written by remote SSH operators
						sharedEntries = readRemoteEntriesLocal(projectPath, maxEntries);
					}
				} catch (error) {
					void captureException(error);
					logger.warn(`Failed to read shared history: ${error}`, LOG_CONTEXT);
				}

				// Merge and deduplicate by entry ID, then sort
				const jsonlEntries = mergeEntriesById(localEntries, sharedEntries);

				// Cue runs live in `cue_events`, not in the JSONL file, so they
				// are merged in here rather than read off disk.
				const cueEntries = dropCueRowsAlreadyInJsonl(
					jsonlEntries,
					readCueEntries(deps, cueScopeAgents(deps, sessionId, projectPath))
				);

				return mergeEntriesById(jsonlEntries, cueEntries);
			}
		)
	);

	// Get history entries with pagination support.
	//
	// Accepts an optional `lookbackHours` to filter entries to the last N
	// hours before pagination - keeps page boundaries meaningful when the
	// renderer's lookback is tighter than the on-disk window. Also accepts
	// `sharedContext` so SSH-shared history is merged in before paging,
	// matching `history:getAll`'s behavior.
	ipcMain.handle(
		'history:getAllPaginated',
		withIpcErrorLogging(
			handlerOpts('getAllPaginated'),
			async (options?: {
				projectPath?: string;
				sessionId?: string;
				pagination?: PaginationOptions;
				lookbackHours?: number | null;
				sharedContext?: SharedHistoryContext;
				types?: HistoryEntryType[];
				hostKey?: string | null;
			}) => {
				const { projectPath, sessionId, pagination, lookbackHours, sharedContext, types, hostKey } =
					options || {};
				const cutoffTime =
					lookbackHours !== null && lookbackHours !== undefined && lookbackHours > 0
						? Date.now() - lookbackHours * 60 * 60 * 1000
						: 0;

				// Type filter runs server-side (before pagination) so the loaded
				// window holds the newest N entries OF THE SELECTED TYPES rather
				// than the newest N of all types. Without this, a Cue-heavy agent
				// (heartbeats + agent.completed firing constantly) fills the whole
				// window with CUE entries and toggling CUE off shows nothing even
				// though USER/AUTO history exists further back. `undefined` means
				// "no type filter" (backward compatible); an empty array correctly
				// yields no entries.
				const typeSet = types ? new Set(types) : null;
				// Host filter also runs server-side (mirroring the type filter)
				// so the loaded window holds the newest N entries OF THE SELECTED
				// HOST. Without it the host filter was applied client-side over
				// only the loaded page, so picking a host whose entries fell
				// outside that page showed nothing despite the picker count
				// (which comes from the full-source graph aggregate). The key
				// must match the aggregate / renderer: `hostname` or the
				// synthetic `LOCAL_HOST_AGG_KEY` for entries with no hostname.
				const applyFilters = (entries: HistoryEntry[]): HistoryEntry[] => {
					let out = cutoffTime > 0 ? entries.filter((e) => e.timestamp >= cutoffTime) : entries;
					if (typeSet) out = out.filter((e) => typeSet.has(e.type));
					if (hostKey) {
						out = out.filter((e) => (e.hostname ?? LOCAL_HOST_AGG_KEY) === hostKey);
					}
					return out;
				};

				// Cue runs come from `cue_events`, so they are merged in before
				// the filters and pagination run - a page must hold the newest N
				// entries of BOTH sources, not the newest N of the JSONL file
				// with Cue rows sprinkled on afterwards.
				//
				// The query is skipped when the request has already filtered Cue
				// rows out: the CUE pill being off, or a host filter naming a
				// foreign host (Cue rows carry no hostname, so they only ever
				// belong to the local bucket).
				const wantsCue =
					(!typeSet || typeSet.has('CUE')) && (!hostKey || hostKey === LOCAL_HOST_AGG_KEY);
				const mergeCueEntries = (jsonlEntries: HistoryEntry[]): HistoryEntry[] => {
					if (!wantsCue) return jsonlEntries;
					const cueEntries = dropCueRowsAlreadyInJsonl(
						jsonlEntries,
						readCueEntries(deps, cueScopeAgents(deps, sessionId, projectPath), {
							since: cutoffTime > 0 ? cutoffTime : undefined,
						})
					);
					return mergeEntriesById(jsonlEntries, cueEntries);
				};

				// Single-session path: optionally merge shared (SSH or local
				// project-mirrored) entries before applying lookback + pagination.
				if (sessionId) {
					let local = await historyManager.getEntries(sessionId);
					local = sortEntriesByTimestamp(local);

					const hasShared = Boolean(sharedContext?.sshRemoteId && sharedContext?.remoteCwd);
					if (hasShared || projectPath) {
						const maxEntries = deps.getMaxEntries?.();
						let sharedEntries: HistoryEntry[] = [];
						try {
							if (hasShared) {
								const sshRemote = deps.getSshRemoteById?.(sharedContext!.sshRemoteId);
								if (sshRemote) {
									sharedEntries = await readRemoteEntriesSsh(
										sharedContext!.remoteCwd,
										sshRemote,
										maxEntries
									);
								}
							} else if (projectPath) {
								sharedEntries = readRemoteEntriesLocal(projectPath, maxEntries);
							}
						} catch (error) {
							void captureException(error);
							logger.warn(`Failed to read shared history (paginated): ${error}`, LOG_CONTEXT);
						}

						local = mergeEntriesById(local, sharedEntries);
					}

					return paginateEntries(applyFilters(mergeCueEntries(local)), pagination);
				}

				if (projectPath) {
					const result = await historyManager.getEntriesByProjectPathPaginated(
						projectPath,
						undefined
					);
					return paginateEntries(applyFilters(mergeCueEntries(result.entries)), pagination);
				}

				const result = await historyManager.getAllEntriesPaginated(undefined);
				return paginateEntries(applyFilters(mergeCueEntries(result.entries)), pagination);
			}
		)
	);

	// Get graph data (buckets + counts) for a single session.
	// Cached on disk keyed by (sessionId, bucketCount, lookbackHours,
	// file mtime+size). The lookback is part of the cache key so each
	// window the user picks gets its own cached aggregate; mtime
	// invalidates them all at once when the file changes.
	ipcMain.handle(
		'history:getGraphData',
		withIpcErrorLogging(
			handlerOpts('getGraphData'),
			async (
				sessionId: string,
				bucketCount: number,
				lookbackHours: number | null,
				sharedContext?: SharedHistoryContext,
				projectPath?: string
			): Promise<HistoryGraphData> => {
				const safeBucketCount = Math.max(1, bucketCount | 0);
				const lookbackMs =
					lookbackHours !== null && lookbackHours > 0 ? lookbackHours * 60 * 60 * 1000 : null;
				const filePath = await historyManager.getHistoryFilePath(sessionId);
				const hasShared = Boolean(sharedContext?.sshRemoteId && sharedContext?.remoteCwd);
				// Local-shared overlay: a non-SSH session whose project dir
				// has foreign-host JSONL files in `.maestro/history/`.
				// Typical of an agent running directly on the remote machine
				// with `shareHistoryToProjectDir` on so a paired Maestro
				// (SSH'd in from elsewhere) can observe its work.
				const hasLocalShared = Boolean(
					!hasShared && projectPath && hasLocalSharedHistory(projectPath)
				);

				// Cache only when there is no shared-history overlay (SSH or
				// local-mirror). Shared entries come from arbitrary files we
				// don't fingerprint, so the simple cached path can't see them.
				if (filePath && !hasShared && !hasLocalShared) {
					const cache = getHistoryBucketCache();
					const lookbackKey = lookbackHours === null ? 'all' : String(lookbackHours);
					const cacheKey = `single:${sessionId}:bc=${safeBucketCount}:lb=${lookbackKey}`;
					const fp = fileFingerprint(filePath);
					const hit = await cache.get(cacheKey, fp);
					if (hit) {
						return cachedToGraphData(hit, true);
					}

					const entries = await historyManager.getEntries(sessionId);
					const agg = buildBucketAggregate(entries, safeBucketCount, { lookbackMs });
					// Fire-and-forget the disk write - the renderer doesn't need to
					// wait for it; the in-memory cache layer was already updated.
					void cache.set({
						version: HISTORY_BUCKET_CACHE_VERSION,
						cacheKey,
						sourceFingerprint: fp,
						bucketCount: safeBucketCount,
						buckets: agg.buckets,
						earliestTimestamp: agg.earliestTimestamp,
						latestTimestamp: agg.latestTimestamp,
						totalCount: agg.totalCount,
						autoCount: agg.autoCount,
						userCount: agg.userCount,
						cueCount: agg.cueCount,
						hostCounts: agg.hostCounts,
						computedAt: Date.now(),
					});
					return aggregateToGraphData(agg, safeBucketCount, false);
				}

				// Shared-history or missing-file path: compute inline, no cache.
				const entries: HistoryEntry[] = filePath ? await historyManager.getEntries(sessionId) : [];
				const maxEntries = deps.getMaxEntries?.();
				if (hasShared) {
					try {
						const sshRemote = deps.getSshRemoteById?.(sharedContext!.sshRemoteId);
						if (sshRemote) {
							const sharedEntries = await readRemoteEntriesSsh(
								sharedContext!.remoteCwd,
								sshRemote,
								maxEntries
							);
							const seen = new Set(entries.map((e) => e.id));
							for (const e of sharedEntries) {
								if (!seen.has(e.id)) {
									entries.push(e);
									seen.add(e.id);
								}
							}
						}
					} catch (err) {
						logger.warn(`Failed to read shared history for graph: ${err}`, LOG_CONTEXT);
					}
				} else if (hasLocalShared) {
					try {
						const sharedEntries = readRemoteEntriesLocal(projectPath!, maxEntries);
						const seen = new Set(entries.map((e) => e.id));
						for (const e of sharedEntries) {
							if (!seen.has(e.id)) {
								entries.push(e);
								seen.add(e.id);
							}
						}
					} catch (err) {
						logger.warn(`Failed to read local shared history for graph: ${err}`, LOG_CONTEXT);
					}
				}
				const agg = buildBucketAggregate(entries, safeBucketCount, { lookbackMs });
				return aggregateToGraphData(agg, safeBucketCount, false);
			}
		)
	);

	// Find the offset of the first entry whose timestamp is <= the given
	// timestamp, in the newest-first sorted order (with the same lookback
	// filter the paginated list uses, so the offset lines up with the
	// rendered indices). Used by the activity-graph click handler to jump
	// the paginated list to a specific bucket.
	ipcMain.handle(
		'history:getOffsetForTimestamp',
		withIpcErrorLogging(
			handlerOpts('getOffsetForTimestamp'),
			async (
				sessionId: string,
				timestamp: number,
				lookbackHours?: number | null,
				types?: HistoryEntryType[]
			): Promise<number> => {
				const cutoffTime =
					lookbackHours !== null && lookbackHours !== undefined && lookbackHours > 0
						? Date.now() - lookbackHours * 60 * 60 * 1000
						: 0;
				let entries = await historyManager.getEntries(sessionId);
				// Cue rows are part of the rendered list but not of the JSONL
				// file, so they have to be merged here too or every offset past
				// the first Cue run lands on the wrong entry.
				entries = mergeEntriesById(
					entries,
					dropCueRowsAlreadyInJsonl(
						entries,
						readCueEntries(deps, cueScopeAgents(deps, sessionId), {
							since: cutoffTime > 0 ? cutoffTime : undefined,
						})
					)
				);
				if (cutoffTime > 0) entries = entries.filter((e) => e.timestamp >= cutoffTime);
				// Mirror the paginated list's type filter so the resolved offset
				// lines up with the rendered (type-filtered) indices.
				if (types) {
					const typeSet = new Set(types);
					entries = entries.filter((e) => typeSet.has(e.type));
				}
				if (entries.length === 0) return 0;
				const sorted = sortEntriesByTimestamp(entries);
				let offset = 0;
				for (const entry of sorted) {
					if (entry.timestamp <= timestamp) return offset;
					offset++;
				}
				return Math.max(0, sorted.length - 1);
			}
		)
	);

	// Force reload history from disk (no-op for new format since we read fresh each time)
	// Kept for API compatibility
	ipcMain.handle(
		'history:reload',
		withIpcErrorLogging(handlerOpts('reload'), async () => {
			logger.debug('history:reload called (no-op for per-session storage)', LOG_CONTEXT);
			return true;
		})
	);

	// Add a new history entry
	ipcMain.handle(
		'history:add',
		withIpcErrorLogging(
			handlerOpts('add'),
			async (entry: HistoryEntry, sharedContext?: SharedHistoryContext) => {
				const sessionId = entry.sessionId || ORPHANED_SESSION_ID;
				const maxEntries = deps.getMaxEntries?.();
				await historyManager.addEntry(sessionId, entry.projectPath, entry, maxEntries);
				logger.info(`Added history entry: ${entry.type}`, LOG_CONTEXT, {
					summary: entry.summary,
				});

				// Shared history: write to remote .maestro/history/ (only for SSH sessions with syncHistory enabled)
				if (sharedContext?.sshRemoteId && sharedContext?.remoteCwd) {
					const sshRemote = deps.getSshRemoteById?.(sharedContext.sshRemoteId);
					if (sshRemote) {
						writeEntryRemote(sharedContext.remoteCwd, entry, sshRemote).catch((err) =>
							logger.warn(`Shared history remote write failed: ${err}`, LOG_CONTEXT)
						);
					}
				}

				// Shared history: also mirror to the local project's .maestro/history/
				// when the source agent is flagged as "remote-controlled" - i.e. its
				// `sessionSshRemoteConfig.shareHistoryToProjectDir` is on. This is the
				// signal that another Maestro instance (typically SSH'd into this
				// machine) wants visibility into entries generated by *this* local
				// instance.
				const targetSession = deps.getSessionById?.(sessionId);
				const sshCfg =
					targetSession &&
					(targetSession as { sessionSshRemoteConfig?: { shareHistoryToProjectDir?: boolean } })
						.sessionSshRemoteConfig;
				if (sshCfg?.shareHistoryToProjectDir && entry.projectPath) {
					writeEntryLocal(entry.projectPath, entry, maxEntries);
				}

				// Broadcast to renderer for real-time Director's Notes streaming
				deps.safeSend('history:entryAdded', entry, sessionId);

				return true;
			}
		)
	);

	// Clear history entries (all, by project, or by session)
	ipcMain.handle(
		'history:clear',
		withIpcErrorLogging(handlerOpts('clear'), async (projectPath?: string, sessionId?: string) => {
			if (sessionId) {
				await historyManager.clearSession(sessionId);
				logger.info(`Cleared history for session: ${sessionId}`, LOG_CONTEXT);
				return true;
			}

			if (projectPath) {
				// Clear all sessions for this project
				await historyManager.clearByProjectPath(projectPath);
				logger.info(`Cleared history for project: ${projectPath}`, LOG_CONTEXT);
				return true;
			}

			// Clear all history
			await historyManager.clearAll();
			return true;
		})
	);

	// Delete a single history entry by ID
	// If sessionId is provided, search only that session; otherwise search all sessions
	ipcMain.handle(
		'history:delete',
		withIpcErrorLogging(handlerOpts('delete'), async (entryId: string, sessionId?: string) => {
			if (sessionId) {
				const deleted = await historyManager.deleteEntry(sessionId, entryId);
				if (deleted) {
					logger.info(`Deleted history entry: ${entryId} from session ${sessionId}`, LOG_CONTEXT);
				} else {
					logger.warn(`History entry not found: ${entryId} in session ${sessionId}`, LOG_CONTEXT);
				}
				return deleted;
			}

			// Search all sessions for the entry (slower, but works for legacy calls without sessionId)
			const sessions = await historyManager.listSessionsWithHistory();
			for (const sid of sessions) {
				if (await historyManager.deleteEntry(sid, entryId)) {
					logger.info(`Deleted history entry: ${entryId} from session ${sid}`, LOG_CONTEXT);
					return true;
				}
			}

			logger.warn(`History entry not found: ${entryId}`, LOG_CONTEXT);
			return false;
		})
	);

	// Update a history entry (for setting validated flag, etc.)
	// If sessionId is provided, search only that session; otherwise search all sessions
	ipcMain.handle(
		'history:update',
		withIpcErrorLogging(
			handlerOpts('update'),
			async (entryId: string, updates: Partial<HistoryEntry>, sessionId?: string) => {
				if (sessionId) {
					const updated = await historyManager.updateEntry(sessionId, entryId, updates);
					if (updated) {
						logger.info(`Updated history entry: ${entryId} in session ${sessionId}`, LOG_CONTEXT, {
							updates,
						});
					} else {
						logger.warn(
							`History entry not found for update: ${entryId} in session ${sessionId}`,
							LOG_CONTEXT
						);
					}
					return updated;
				}

				// Search all sessions for the entry
				const sessions = await historyManager.listSessionsWithHistory();
				for (const sid of sessions) {
					if (await historyManager.updateEntry(sid, entryId, updates)) {
						logger.info(`Updated history entry: ${entryId} in session ${sid}`, LOG_CONTEXT, {
							updates,
						});
						return true;
					}
				}

				logger.warn(`History entry not found for update: ${entryId}`, LOG_CONTEXT);
				return false;
			}
		)
	);

	// Update sessionName for all entries matching a agentSessionId (used when renaming tabs)
	ipcMain.handle(
		'history:updateSessionName',
		withIpcErrorLogging(
			handlerOpts('updateSessionName'),
			async (agentSessionId: string, sessionName: string) => {
				const count = await historyManager.updateSessionNameByClaudeSessionId(
					agentSessionId,
					sessionName
				);
				logger.info(
					`Updated sessionName for ${count} history entries with agentSessionId ${agentSessionId}`,
					LOG_CONTEXT
				);
				return count;
			}
		)
	);

	// NEW: Get history file path for AI context integration
	ipcMain.handle(
		'history:getFilePath',
		withIpcErrorLogging(handlerOpts('getFilePath'), async (sessionId: string) => {
			return historyManager.getHistoryFilePath(sessionId);
		})
	);

	// NEW: List sessions with history
	ipcMain.handle(
		'history:listSessions',
		withIpcErrorLogging(handlerOpts('listSessions'), async () => {
			return historyManager.listSessionsWithHistory();
		})
	);
}
