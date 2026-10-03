import { describe, it, expect, beforeEach } from 'vitest';
import {
	useAutoRunSteeringStore,
	selectPendingSteeringNotes,
} from '../../../renderer/stores/autoRunSteeringStore';
import { MAX_PENDING_STEERING_NOTES } from '../../../shared/autorunSteering';

const SESSION = 'session-1';
const TAB = 'tab-1';

describe('autoRunSteeringStore', () => {
	beforeEach(() => {
		useAutoRunSteeringStore.setState({ notes: {} });
	});

	it('parks a note against its session and tab', () => {
		const note = useAutoRunSteeringStore.getState().addNote(SESSION, TAB, '  steer left  ');
		expect(note).not.toBeNull();
		expect(note!.text).toBe('steer left');
		expect(note!.tabId).toBe(TAB);
		expect(useAutoRunSteeringStore.getState().notes[SESSION]).toHaveLength(1);
	});

	it('rejects an empty note so the caller can fall back to its normal send path', () => {
		expect(useAutoRunSteeringStore.getState().addNote(SESSION, TAB, '   ')).toBeNull();
		expect(useAutoRunSteeringStore.getState().notes[SESSION]).toBeUndefined();
	});

	it('rejects a note past the pending cap', () => {
		for (let i = 0; i < MAX_PENDING_STEERING_NOTES; i++) {
			expect(useAutoRunSteeringStore.getState().addNote(SESSION, TAB, `note ${i}`)).not.toBeNull();
		}
		expect(useAutoRunSteeringStore.getState().addNote(SESSION, TAB, 'one too many')).toBeNull();
		expect(useAutoRunSteeringStore.getState().notes[SESSION]).toHaveLength(
			MAX_PENDING_STEERING_NOTES
		);
	});

	it('takeNotes reads and clears in one step so a note is never delivered twice', () => {
		useAutoRunSteeringStore.getState().addNote(SESSION, TAB, 'first');
		useAutoRunSteeringStore.getState().addNote(SESSION, TAB, 'second');

		const taken = useAutoRunSteeringStore.getState().takeNotes(SESSION);
		expect(taken.map((n) => n.text)).toEqual(['first', 'second']);
		expect(useAutoRunSteeringStore.getState().notes[SESSION]).toBeUndefined();
		expect(useAutoRunSteeringStore.getState().takeNotes(SESSION)).toEqual([]);
	});

	it('keeps sessions independent', () => {
		useAutoRunSteeringStore.getState().addNote(SESSION, TAB, 'mine');
		useAutoRunSteeringStore.getState().addNote('session-2', 'tab-2', 'theirs');

		useAutoRunSteeringStore.getState().takeNotes(SESSION);
		expect(useAutoRunSteeringStore.getState().notes['session-2']).toHaveLength(1);
	});

	it('removes one pending note and leaves the rest', () => {
		const first = useAutoRunSteeringStore.getState().addNote(SESSION, TAB, 'first')!;
		useAutoRunSteeringStore.getState().addNote(SESSION, TAB, 'second');

		useAutoRunSteeringStore.getState().removeNote(SESSION, first.id);
		expect(useAutoRunSteeringStore.getState().notes[SESSION]).toHaveLength(1);
		expect(useAutoRunSteeringStore.getState().notes[SESSION][0].text).toBe('second');
	});

	it('clearNotes drops everything pending for a session', () => {
		useAutoRunSteeringStore.getState().addNote(SESSION, TAB, 'first');
		useAutoRunSteeringStore.getState().clearNotes(SESSION);
		expect(useAutoRunSteeringStore.getState().notes[SESSION]).toBeUndefined();
	});

	it('hands back a stable empty array so the selector never churns subscribers', () => {
		const state = useAutoRunSteeringStore.getState();
		expect(selectPendingSteeringNotes(SESSION)(state)).toBe(
			selectPendingSteeringNotes('other')(state)
		);
	});
});
