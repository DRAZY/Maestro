import { describe, expect, it } from 'vitest';
import type { QuickAction } from '../../../../../renderer/components/QuickActionsModal/types';
import {
	alphabetizeKey,
	filterAndSortQuickActions,
	shouldShowAgentBucketHeaders,
} from '../../../../../renderer/components/QuickActionsModal/utils/quickActionSorting';

const action = (
	overrides: Partial<QuickAction> & Pick<QuickAction, 'id' | 'label'>
): QuickAction => ({
	action: () => {},
	...overrides,
});

describe('quickActionSorting', () => {
	it('filters case-insensitively and hides debug commands until searching debug', () => {
		const actions = [
			action({ id: 'settings', label: 'Settings' }),
			action({ id: 'debugReset', label: 'Debug: Reset Busy State' }),
		];

		expect(filterAndSortQuickActions(actions, 'set', 'main').map((a) => a.id)).toEqual([
			'settings',
		]);
		expect(filterAndSortQuickActions(actions, 'debug', 'main').map((a) => a.id)).toEqual([
			'debugReset',
		]);
	});

	it('prefers bookmarked jump actions when two entries share the same agent sort key', () => {
		const sorted = filterAndSortQuickActions(
			[
				action({ id: 'child', label: 'Jump to Maestro subagent: rc', agentSortKey: 'rc' }),
				action({ id: 'root', label: 'Jump to: rc', agentSortKey: 'rc', bookmarked: true }),
			],
			'',
			'main'
		);

		expect(sorted[0].id).toBe('root');
	});

	it('sorts agents by live bucket, then alphabetically with leading emoji skipped', () => {
		const sorted = filterAndSortQuickActions(
			[
				action({ id: 'idle-z', label: 'Zulu', isRunningAgent: false }),
				action({ id: 'live-b', label: 'Bravo', isRunningAgent: true }),
				action({ id: 'live-a', label: '🚀 Atlas', isRunningAgent: true }),
			],
			'',
			'agents'
		);

		expect(sorted.map((a) => a.id)).toEqual(['live-a', 'live-b', 'idle-z']);
		expect(alphabetizeKey('🚀 Atlas')).toBe('atlas');
	});

	it('only shows agent bucket headers when both live and idle buckets exist', () => {
		expect(
			shouldShowAgentBucketHeaders(
				[
					action({ id: 'live', label: 'Live', isRunningAgent: true }),
					action({ id: 'idle', label: 'Idle', isRunningAgent: false }),
				],
				'agents'
			)
		).toBe(true);
		expect(shouldShowAgentBucketHeaders([action({ id: 'live', label: 'Live' })], 'main')).toBe(
			false
		);
	});

	it('orders the media bucket between live and idle', () => {
		const sorted = filterAndSortQuickActions(
			[
				action({ id: 'idle-z', label: 'Zulu', isRunningAgent: false }),
				action({ id: 'media-b', label: 'brief.mp3', playingMediaKind: 'audio' }),
				action({ id: 'live-a', label: 'Atlas', isRunningAgent: true }),
				action({ id: 'media-a', label: 'artist.mp4', playingMediaKind: 'video' }),
				action({ id: 'idle-a', label: 'Alpha', isRunningAgent: false }),
			],
			'',
			'agents'
		);

		expect(sorted.map((a) => a.id)).toEqual(['live-a', 'media-a', 'media-b', 'idle-a', 'idle-z']);
	});

	it('buckets a playing media row under media even though it is not a running agent', () => {
		const sorted = filterAndSortQuickActions(
			[
				action({ id: 'idle', label: 'Agent', isRunningAgent: false }),
				action({ id: 'media', label: 'pod.mp3', playingMediaKind: 'audio' }),
			],
			'',
			'agents'
		);
		expect(sorted.map((a) => a.id)).toEqual(['media', 'idle']);
	});

	it('shows headers when only media and idle are present', () => {
		expect(
			shouldShowAgentBucketHeaders(
				[
					action({ id: 'media', label: 'pod.mp3', playingMediaKind: 'audio' }),
					action({ id: 'idle', label: 'Idle', isRunningAgent: false }),
				],
				'agents'
			)
		).toBe(true);
	});

	it('hides headers when every row is in the same bucket', () => {
		expect(
			shouldShowAgentBucketHeaders(
				[
					action({ id: 'a', label: 'A', isRunningAgent: false }),
					action({ id: 'b', label: 'B', isRunningAgent: false }),
				],
				'agents'
			)
		).toBe(false);
	});

	it('filters media rows by the search query like any other row', () => {
		const sorted = filterAndSortQuickActions(
			[
				action({ id: 'media-a', label: 'podcast.mp3', playingMediaKind: 'audio' }),
				action({ id: 'media-b', label: 'lecture.mp4', playingMediaKind: 'video' }),
			],
			'podcast',
			'agents'
		);
		expect(sorted.map((a) => a.id)).toEqual(['media-a']);
	});
});
