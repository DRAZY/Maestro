/**
 * Shared history utilities for per-session storage
 *
 * This module provides common constants and types used by both the main process
 * (HistoryManager) and CLI (storage.ts) for per-session history storage.
 *
 * STORAGE FORMAT: per-session JSONL (`<sessionId>.jsonl`), one entry per line,
 * in append order (oldest first). The legacy format was a single JSON object
 * with an `entries` array, newest-first; `parseHistoryFileData` still reads it
 * so old files keep working until they are migrated on first touch.
 *
 * JSONL is not a cosmetic change. The old envelope closed with `]}`, so every
 * new entry meant re-serializing the WHOLE file - 56 MB per entry at a 50,000
 * cap, which is how a heartbeat-heavy agent produced gigabytes of writes a day.
 * Worse, a torn write destroyed the entire file, and the recovery paths then
 * silently discarded thousands of accumulated entries. With JSONL an append is
 * ~1 KB, and a torn write costs exactly ONE line, which the reader skips.
 */

import type { HistoryEntry } from './types';

/**
 * Current history file format version. Increment when making breaking changes
 * to HistoryFileData structure.
 */
export const HISTORY_VERSION = 1;

/**
 * Default maximum number of history entries stored per session.
 * Used as fallback when maxLogBuffer setting is not available.
 * The actual limit is controlled by the maxLogBuffer user setting.
 */
export const MAX_ENTRIES_PER_SESSION = 5000;

/**
 * Session ID used for history entries that don't have an associated session.
 * These entries are stored in a special "_orphaned.json" file.
 */
export const ORPHANED_SESSION_ID = '_orphaned';

/**
 * Resolve the per-session entry cap from a raw `maxLogBuffer` setting value.
 *
 * Every writer (main process, Cue, CLI) MUST run the setting through this so a
 * single writer can't quietly trim a file the others are allowed to grow: the
 * trim is destructive, so the smallest cap in play wins on disk. A busy Auto
 * Run agent hit exactly this - its Cue writes used the 5,000 fallback and
 * truncated a history the user had raised to 25,000, leaving only the last
 * few days visible.
 *
 * @param value - Raw setting value (may be undefined, a string, or garbage)
 * @returns A positive integer cap, or MAX_ENTRIES_PER_SESSION when unusable
 */
export function resolveHistoryEntryLimit(value: unknown): number {
	const parsed = typeof value === 'string' ? Number(value) : value;
	if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 1) {
		return MAX_ENTRIES_PER_SESSION;
	}
	return Math.floor(parsed);
}

/**
 * Per-session history file format
 */
export interface HistoryFileData {
	version: number;
	sessionId: string;
	projectPath: string;
	entries: HistoryEntry[];
}

/**
 * Migration marker file format
 */
export interface MigrationMarker {
	migratedAt: number;
	version: number;
	legacyEntryCount: number;
	sessionsMigrated: number;
}

/**
 * Pagination options for history queries
 */
export interface PaginationOptions {
	/** Number of entries to return (default: 100) */
	limit?: number;
	/** Number of entries to skip (default: 0) */
	offset?: number;
}

/**
 * Paginated result wrapper
 */
export interface PaginatedResult<T> {
	entries: T[];
	total: number;
	limit: number;
	offset: number;
	hasMore: boolean;
}

/**
 * Default pagination values.
 * @internal Used internally by paginateEntries; consumers should pass
 * their own PaginationOptions if different values are needed.
 */
const DEFAULT_PAGINATION: Required<PaginationOptions> = {
	limit: 100,
	offset: 0,
};

/**
 * Sanitize a session ID for safe filesystem usage.
 * Replaces any characters that are not alphanumeric, underscore, or hyphen with underscore.
 * @param sessionId - The raw session ID to sanitize
 * @returns A filesystem-safe session ID
 */
export function sanitizeSessionId(sessionId: string): string {
	return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Apply pagination to an array of entries.
 * @param entries - The full array of entries to paginate
 * @param options - Optional pagination parameters (limit, offset)
 * @returns A PaginatedResult containing the sliced entries and metadata
 */
export function paginateEntries<T>(entries: T[], options?: PaginationOptions): PaginatedResult<T> {
	const limit = options?.limit ?? DEFAULT_PAGINATION.limit;
	const offset = options?.offset ?? DEFAULT_PAGINATION.offset;

	const paginatedEntries = entries.slice(offset, offset + limit);

	return {
		entries: paginatedEntries,
		total: entries.length,
		limit,
		offset,
		hasMore: offset + limit < entries.length,
	};
}

/**
 * Sort entries by timestamp (most recent first).
 * Returns a new array, does not mutate the original.
 * @param entries - The entries to sort
 * @returns A new array with entries sorted by descending timestamp
 */
export function sortEntriesByTimestamp(entries: HistoryEntry[]): HistoryEntry[] {
	return [...entries].sort((a, b) => b.timestamp - a.timestamp);
}

// ─── JSONL storage format ───────────────────────────────────────────────────

/** Extension for the current (append-only) per-session history format. */
export const HISTORY_JSONL_EXT = '.jsonl';

/** Extension for the legacy single-object-per-session format. */
export const HISTORY_LEGACY_JSON_EXT = '.json';

/**
 * Serialize one entry as a single JSONL line (trailing newline included).
 *
 * Newlines inside string values are escaped by `JSON.stringify`, so one entry
 * is always exactly one physical line. That invariant is what lets the reader
 * recover from a torn write by dropping a single line.
 */
export function serializeHistoryEntryLine(entry: HistoryEntry): string {
	return `${JSON.stringify(entry)}\n`;
}

/** Result of parsing a JSONL history file. */
export interface ParsedHistoryJsonl {
	/** Entries in file order (oldest first). */
	entries: HistoryEntry[];
	/**
	 * Count of lines that were non-empty but unparseable. Expected to be 0 or 1
	 * (a torn final line from an interrupted append). A larger number means real
	 * corruption and is worth reporting.
	 */
	malformedLines: number;
}

/**
 * Parse a JSONL history file, skipping unparseable lines rather than failing
 * the whole read.
 *
 * This is the core durability property of the format: under the old
 * single-object format, one bad byte made `JSON.parse` throw and the caller
 * discarded EVERY entry in the file. Here a bad line costs one entry.
 */
export function parseHistoryJsonl(raw: string): ParsedHistoryJsonl {
	const entries: HistoryEntry[] = [];
	let malformedLines = 0;

	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as HistoryEntry;
			// A line that parses but isn't an entry-shaped object is corruption
			// too - counting it keeps the malformed tally honest.
			if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') {
				entries.push(parsed);
			} else {
				malformedLines++;
			}
		} catch {
			malformedLines++;
		}
	}

	return { entries, malformedLines };
}

/**
 * Keep only the newest `limit` entries from a file-order (oldest-first) array.
 * Used by rotation; returns the input untouched when it already fits.
 */
export function trimHistoryEntriesToLimit(entries: HistoryEntry[], limit: number): HistoryEntry[] {
	if (limit < 1 || entries.length <= limit) return entries;
	return entries.slice(entries.length - limit);
}
