import { describe, expect, it, vi } from 'vitest';
import { buildMediaJumpCommands } from '../../../../../renderer/components/QuickActionsModal/commands/mediaJumpCommands';
import type { FilePreviewTab, Session } from '../../../../../renderer/types';

const STREAM = 'maestro-media://stream/deadbeef/616263';

function fileTab(overrides: Partial<FilePreviewTab> = {}): FilePreviewTab {
	return {
		id: 'tab-1',
		path: '/tmp/song.mp3',
		name: 'song',
		extension: '.mp3',
		content: STREAM,
		scrollTop: 0,
		searchQuery: '',
		editMode: false,
		editContent: undefined,
		createdAt: 1000,
		lastModified: 1000,
		...overrides,
	};
}

function session(overrides: Partial<Session> = {}): Session {
	return {
		id: 'sess-1',
		name: 'Agent One',
		filePreviewTabs: [fileTab()],
		activeFileTabId: null,
		activeTerminalTabId: 'term-9',
		activeBrowserTabId: 'browse-9',
		inputMode: 'terminal',
		...overrides,
	} as unknown as Session;
}

function harness(sessions: Session[], playing: string[]) {
	const setSessions = vi.fn();
	const setActiveSessionId = vi.fn();
	const revealJumpTarget = vi.fn();
	const actions = buildMediaJumpCommands({
		sessions,
		playingTabIds: new Set(playing),
		setSessions,
		setActiveSessionId,
		revealJumpTarget,
	});
	return { actions, setSessions, setActiveSessionId, revealJumpTarget };
}

describe('buildMediaJumpCommands', () => {
	it('returns nothing when no media is playing', () => {
		expect(harness([session()], []).actions).toEqual([]);
	});

	it('lists only the tabs that are actually playing', () => {
		const sessions = [
			session({
				filePreviewTabs: [
					fileTab({ id: 'playing' }),
					fileTab({ id: 'paused', path: '/tmp/other.mp3', name: 'other' }),
				],
			}),
		];
		const { actions } = harness(sessions, ['playing']);
		expect(actions.map((a) => a.id)).toEqual(['jump-media-playing']);
	});

	it('labels the row with the filename and subtexts the owning agent', () => {
		const { actions } = harness([session({ name: 'Podcast Agent' })], ['tab-1']);
		expect(actions[0].label).toBe('song.mp3');
		expect(actions[0].subtext).toBe('Podcast Agent');
	});

	it('tags the row with the media kind so the list can pick an icon', () => {
		const sessions = [
			session({
				filePreviewTabs: [
					fileTab({ id: 'a' }),
					fileTab({ id: 'v', name: 'talk', extension: '.mp4', path: '/tmp/talk.mp4' }),
				],
			}),
		];
		const { actions } = harness(sessions, ['a', 'v']);
		expect(actions.find((x) => x.id === 'jump-media-a')?.playingMediaKind).toBe('audio');
		expect(actions.find((x) => x.id === 'jump-media-v')?.playingMediaKind).toBe('video');
	});

	it('focuses the owning agent and its file tab, clearing rival tab selections', () => {
		const sessions = [session({ id: 'owner' })];
		const { actions, setSessions, setActiveSessionId, revealJumpTarget } = harness(sessions, [
			'tab-1',
		]);

		actions[0].action();

		expect(setActiveSessionId).toHaveBeenCalledWith('owner');
		expect(revealJumpTarget).toHaveBeenCalledWith(sessions[0]);

		// Terminal and browser tabs outrank the file tab in render precedence, so
		// jumping has to clear both or the old view stays on screen.
		const updater = setSessions.mock.calls[0][0] as (prev: Session[]) => Session[];
		const [next] = updater(sessions);
		expect(next.activeFileTabId).toBe('tab-1');
		expect(next.activeTerminalTabId).toBeNull();
		expect(next.activeBrowserTabId).toBeNull();
		expect(next.inputMode).toBe('ai');
	});

	it('leaves other agents untouched when jumping', () => {
		const sessions = [session({ id: 'owner' }), session({ id: 'bystander' })];
		const { actions, setSessions } = harness(sessions, ['tab-1']);

		actions[0].action();
		const updater = setSessions.mock.calls[0][0] as (prev: Session[]) => Session[];
		const next = updater(sessions);
		expect(next[1]).toBe(sessions[1]);
	});

	it('spans agents, so a tab playing under an idle agent still shows', () => {
		const sessions = [
			session({ id: 's1', filePreviewTabs: [] }),
			session({ id: 's2', name: 'Other', filePreviewTabs: [fileTab({ id: 'far' })] }),
		];
		const { actions } = harness(sessions, ['far']);
		expect(actions).toHaveLength(1);
		expect(actions[0].subtext).toBe('Other');
	});
});
