/**
 * Tests for the operator-facing half of Auto Run steering notes.
 *
 * The store (`autoRunSteeringStore`) owns the pending queue and is tested on
 * its own. What lives here is the part the operator actually sees: the
 * transcript entry that proves a note landed, and the badge on that entry
 * moving pending -> delivered (a task picked it up) or pending -> dropped
 * (cancelled before any task saw it).
 *
 * Three behaviors are easy to break by "simplifying" and are pinned here:
 *  - the transcript entry reuses the note's OWN id, which is the only handle
 *    the delivery flip and the cancel click have for finding it again;
 *  - notes can span tabs (the operator switched tabs mid-run), so delivery
 *    must flip entries in every tab that holds one, not just the active tab;
 *  - a rejected note (empty, or past the cap) must return false so the caller
 *    falls back to its normal send path instead of swallowing what was typed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	submitSteeringNote,
	cancelSteeringNote,
	takeSteeringNotesForDispatch,
	clearSteeringNotes,
} from '../../../renderer/services/autoRunSteering';
import { useAutoRunSteeringStore } from '../../../renderer/stores/autoRunSteeringStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { MAX_PENDING_STEERING_NOTES } from '../../../shared/autorunSteering';
import { createMockSession } from '../../helpers/mockSession';
import type { AITab, LogEntry, Session } from '../../../renderer/types';

vi.mock('../../../renderer/stores/centerFlashStore', () => ({
	notifyCenterFlash: vi.fn(),
}));

const SESSION_ID = 'agent-1';

/** Minimal AI tab: the service only needs an id and a log array. */
const tab = (id: string): AITab => ({ id, name: id, logs: [] }) as unknown as AITab;

function seed(tabs: AITab[] = [tab('tab-1')]): void {
	const session = createMockSession({
		id: SESSION_ID,
		aiTabs: tabs,
		activeTabId: tabs[0]?.id,
	} as Partial<Session>);
	useSessionStore.setState({ sessions: [session], activeSessionId: SESSION_ID } as never);
}

/** Every transcript entry in one tab, as it stands in the store right now. */
function logsIn(tabId: string): LogEntry[] {
	const session = useSessionStore.getState().sessions.find((s) => s.id === SESSION_ID);
	return session?.aiTabs.find((t) => t.id === tabId)?.logs ?? [];
}

function pendingCount(): number {
	return (useAutoRunSteeringStore.getState().notes[SESSION_ID] ?? []).length;
}

beforeEach(() => {
	vi.clearAllMocks();
	useAutoRunSteeringStore.setState({ notes: {} });
	useSessionStore.setState({ sessions: [], activeSessionId: null } as never);
	seed();
});

describe('submitSteeringNote', () => {
	it('parks the note and writes a pending transcript entry carrying the note id', () => {
		const accepted = submitSteeringNote({
			sessionId: SESSION_ID,
			tabId: 'tab-1',
			text: 'Use the v3 endpoint',
		});

		expect(accepted).toBe(true);

		const stored = useAutoRunSteeringStore.getState().notes[SESSION_ID];
		expect(stored).toHaveLength(1);

		const entries = logsIn('tab-1');
		expect(entries).toHaveLength(1);
		// The entry id IS the note id. Anything else and neither the delivery
		// flip nor the operator's cancel click can find this row again.
		expect(entries[0].id).toBe(stored[0].id);
		expect(entries[0].source).toBe('user');
		expect(entries[0].text).toBe('Use the v3 endpoint');
		expect(entries[0].steeringNote).toBe('pending');
	});

	it('stores the normalized text so a padded note is not delivered with its whitespace', () => {
		submitSteeringNote({ sessionId: SESSION_ID, tabId: 'tab-1', text: '  trim me  \n' });

		expect(useAutoRunSteeringStore.getState().notes[SESSION_ID][0].text).toBe('trim me');
		expect(logsIn('tab-1')[0].text).toBe('trim me');
	});

	it('rejects an empty note without touching the transcript', () => {
		expect(submitSteeringNote({ sessionId: SESSION_ID, tabId: 'tab-1', text: '   ' })).toBe(false);

		expect(pendingCount()).toBe(0);
		expect(logsIn('tab-1')).toHaveLength(0);
	});

	it('rejects past the pending cap so the caller falls back to queueing', () => {
		for (let i = 0; i < MAX_PENDING_STEERING_NOTES; i++) {
			expect(submitSteeringNote({ sessionId: SESSION_ID, tabId: 'tab-1', text: `note ${i}` })).toBe(
				true
			);
		}

		expect(
			submitSteeringNote({ sessionId: SESSION_ID, tabId: 'tab-1', text: 'one too many' })
		).toBe(false);
		// The refused note leaves no orphan row claiming it was accepted.
		expect(pendingCount()).toBe(MAX_PENDING_STEERING_NOTES);
		expect(logsIn('tab-1')).toHaveLength(MAX_PENDING_STEERING_NOTES);
	});
});

describe('takeSteeringNotesForDispatch', () => {
	it('returns nothing and leaves the transcript alone when none are pending', () => {
		expect(takeSteeringNotesForDispatch(SESSION_ID)).toEqual([]);
		expect(logsIn('tab-1')).toHaveLength(0);
	});

	it('hands the notes over in order and flips their entries to delivered', () => {
		submitSteeringNote({ sessionId: SESSION_ID, tabId: 'tab-1', text: 'first' });
		submitSteeringNote({ sessionId: SESSION_ID, tabId: 'tab-1', text: 'second' });

		const taken = takeSteeringNotesForDispatch(SESSION_ID);

		expect(taken.map((n) => n.text)).toEqual(['first', 'second']);
		expect(logsIn('tab-1').map((e) => e.steeringNote)).toEqual(['delivered', 'delivered']);
	});

	it('drops the tab id on the way out - the prompt block only needs id, text, time', () => {
		submitSteeringNote({ sessionId: SESSION_ID, tabId: 'tab-1', text: 'note' });

		const [note] = takeSteeringNotesForDispatch(SESSION_ID);

		expect(Object.keys(note).sort()).toEqual(['id', 'text', 'timestamp']);
	});

	it('flips entries in every tab a note came from, not just the active one', () => {
		seed([tab('tab-1'), tab('tab-2')]);
		submitSteeringNote({ sessionId: SESSION_ID, tabId: 'tab-1', text: 'typed in tab 1' });
		submitSteeringNote({ sessionId: SESSION_ID, tabId: 'tab-2', text: 'typed in tab 2' });

		takeSteeringNotesForDispatch(SESSION_ID);

		expect(logsIn('tab-1')[0].steeringNote).toBe('delivered');
		expect(logsIn('tab-2')[0].steeringNote).toBe('delivered');
	});

	it('consumes exactly once so the next task does not get a repeat', () => {
		submitSteeringNote({ sessionId: SESSION_ID, tabId: 'tab-1', text: 'only once' });

		expect(takeSteeringNotesForDispatch(SESSION_ID)).toHaveLength(1);
		expect(takeSteeringNotesForDispatch(SESSION_ID)).toEqual([]);
	});

	it('leaves a note sent after the take for the NEXT task', () => {
		submitSteeringNote({ sessionId: SESSION_ID, tabId: 'tab-1', text: 'for this task' });
		takeSteeringNotesForDispatch(SESSION_ID);

		submitSteeringNote({ sessionId: SESSION_ID, tabId: 'tab-1', text: 'for the next one' });

		expect(takeSteeringNotesForDispatch(SESSION_ID).map((n) => n.text)).toEqual([
			'for the next one',
		]);
	});
});

describe('cancelSteeringNote', () => {
	it('removes the pending note and marks its entry dropped', () => {
		submitSteeringNote({ sessionId: SESSION_ID, tabId: 'tab-1', text: 'never mind' });
		const noteId = useAutoRunSteeringStore.getState().notes[SESSION_ID][0].id;

		cancelSteeringNote(SESSION_ID, noteId);

		expect(pendingCount()).toBe(0);
		expect(logsIn('tab-1')[0].steeringNote).toBe('dropped');
	});

	it('finds the entry via the note own tab, so cancelling from another tab still works', () => {
		seed([tab('tab-1'), tab('tab-2')]);
		submitSteeringNote({ sessionId: SESSION_ID, tabId: 'tab-2', text: 'typed in tab 2' });
		const noteId = useAutoRunSteeringStore.getState().notes[SESSION_ID][0].id;

		cancelSteeringNote(SESSION_ID, noteId);

		expect(logsIn('tab-2')[0].steeringNote).toBe('dropped');
	});

	it('leaves the other pending notes alone', () => {
		submitSteeringNote({ sessionId: SESSION_ID, tabId: 'tab-1', text: 'keep' });
		submitSteeringNote({ sessionId: SESSION_ID, tabId: 'tab-1', text: 'cancel' });
		const cancelId = useAutoRunSteeringStore.getState().notes[SESSION_ID][1].id;

		cancelSteeringNote(SESSION_ID, cancelId);

		expect(useAutoRunSteeringStore.getState().notes[SESSION_ID].map((n) => n.text)).toEqual([
			'keep',
		]);
		expect(logsIn('tab-1').map((e) => e.steeringNote)).toEqual(['pending', 'dropped']);
	});

	it('is a no-op once the note has been delivered - the badge keeps saying delivered', () => {
		submitSteeringNote({ sessionId: SESSION_ID, tabId: 'tab-1', text: 'too late' });
		const noteId = useAutoRunSteeringStore.getState().notes[SESSION_ID][0].id;
		takeSteeringNotesForDispatch(SESSION_ID);

		cancelSteeringNote(SESSION_ID, noteId);

		expect(logsIn('tab-1')[0].steeringNote).toBe('delivered');
	});
});

describe('clearSteeringNotes', () => {
	it('drops everything pending without rewriting the transcript', () => {
		submitSteeringNote({ sessionId: SESSION_ID, tabId: 'tab-1', text: 'stale' });

		clearSteeringNotes(SESSION_ID);

		expect(pendingCount()).toBe(0);
		// The run is over (or a new one started). The note never reached a task,
		// but the row stays as written - rewriting history here would be a lie in
		// the other direction.
		expect(logsIn('tab-1')[0].steeringNote).toBe('pending');
	});
});
