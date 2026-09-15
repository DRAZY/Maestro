/**
 * Tests for the Cue history retention resolver.
 *
 * The prune this feeds is destructive and irreversible, so the resolver's only
 * job is to make sure a garbage stored value can never turn into a garbage
 * cutoff. `0` in particular must not reach `pruneCueEvents()` - it would mean
 * "delete every row".
 */

import { describe, it, expect } from 'vitest';
import {
	DEFAULT_CUE_HISTORY_RETENTION_DAYS,
	DEFAULT_CUE_HISTORY_RETENTION_MS,
	resolveCueHistoryRetentionDays,
	resolveCueHistoryRetentionMs,
} from '../../../shared/cue/retention';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('shared/cue/retention', () => {
	describe('constants', () => {
		it('defaults to 14 days', () => {
			expect(DEFAULT_CUE_HISTORY_RETENTION_DAYS).toBe(14);
		});

		it('derives the default window from the default day count', () => {
			expect(DEFAULT_CUE_HISTORY_RETENTION_MS).toBe(
				DEFAULT_CUE_HISTORY_RETENTION_DAYS * MS_PER_DAY
			);
		});
	});

	describe('resolveCueHistoryRetentionDays', () => {
		it('returns the configured window when it is a positive number', () => {
			expect(resolveCueHistoryRetentionDays(30)).toBe(30);
			expect(resolveCueHistoryRetentionDays(1)).toBe(1);
		});

		it('parses a numeric string (settings files hand-edited as text)', () => {
			expect(resolveCueHistoryRetentionDays('30')).toBe(30);
		});

		it('floors a fractional day count so the cutoff is a whole number of days', () => {
			expect(resolveCueHistoryRetentionDays(7.9)).toBe(7);
		});

		it.each([
			['undefined (setting never written)', undefined],
			['null', null],
			['0 - would mean delete everything', 0],
			['a negative day count', -5],
			['NaN', NaN],
			['Infinity', Infinity],
			['a non-numeric string', 'abc'],
			['an object', {}],
			['an array', []],
		])('falls back to the default for %s', (_label, value) => {
			expect(resolveCueHistoryRetentionDays(value)).toBe(DEFAULT_CUE_HISTORY_RETENTION_DAYS);
		});
	});

	describe('resolveCueHistoryRetentionMs', () => {
		it('converts the resolved day count to a prune age', () => {
			expect(resolveCueHistoryRetentionMs(30)).toBe(30 * MS_PER_DAY);
			expect(resolveCueHistoryRetentionMs('7')).toBe(7 * MS_PER_DAY);
		});

		it('never returns zero or NaN for garbage', () => {
			for (const value of [undefined, null, 0, -5, NaN, 'abc']) {
				expect(resolveCueHistoryRetentionMs(value)).toBe(DEFAULT_CUE_HISTORY_RETENTION_MS);
			}
		});
	});
});
