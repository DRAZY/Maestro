/**
 * Auto Run steering - operator-side helpers.
 *
 * Owns the two halves of a steering note's visible life:
 *  - `submitSteeringNote` parks the note and writes the transcript entry that
 *    proves it landed (badge: pending).
 *  - `takeSteeringNotesForDispatch` hands the notes to the task about to run
 *    and flips those same entries to delivered.
 *
 * Both live here rather than in the store so the store stays pure state, and
 * rather than in the composer so the batch runner can consume notes without
 * importing anything from the input layer.
 */

import { updateAiTab } from '../stores/sessionStore';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import { useAutoRunSteeringStore, type PendingSteeringNote } from '../stores/autoRunSteeringStore';
import type { AutoRunSteeringNote } from '../../shared/autorunSteering';
import type { LogEntry } from '../types';

export interface SubmitSteeringNoteArgs {
	sessionId: string;
	/** Tab whose transcript records the note. */
	tabId: string;
	text: string;
}

/**
 * Park a steering note for the next Auto Run task and show it in the transcript.
 *
 * Returns `false` when the note was not accepted (empty text, or the pending
 * cap is reached). Callers fall back to their normal send path in that case -
 * a rejected note must never swallow what the operator typed.
 */
export function submitSteeringNote(args: SubmitSteeringNoteArgs): boolean {
	const { sessionId, tabId, text } = args;
	const note = useAutoRunSteeringStore.getState().addNote(sessionId, tabId, text);
	if (!note) return false;

	// The transcript entry carries the note's own id, which is what lets the
	// delivery flip (and the operator's cancel click) find it again.
	const entry: LogEntry = {
		id: note.id,
		timestamp: note.timestamp,
		source: 'user',
		text: note.text,
		steeringNote: 'pending',
	};
	updateAiTab(sessionId, tabId, (tab) => ({ ...tab, logs: [...tab.logs, entry] }));

	notifyCenterFlash({
		message: 'Steering note queued',
		detail: 'Delivered at the start of the next Auto Run task',
		color: 'theme',
	});
	return true;
}

/**
 * Cancel a pending note and mark its transcript entry as dropped.
 *
 * No-op once the note has been consumed - the store no longer holds it, so the
 * entry keeps its delivered badge.
 */
export function cancelSteeringNote(sessionId: string, noteId: string): void {
	const pending = useAutoRunSteeringStore.getState().notes[sessionId] ?? [];
	// The note carries its own tab, so the caller (a transcript row that only
	// knows its session) does not have to.
	const target = pending.find((note) => note.id === noteId);
	if (!target) return;

	useAutoRunSteeringStore.getState().removeNote(sessionId, noteId);
	updateAiTab(sessionId, target.tabId, (tab) => ({
		...tab,
		logs: tab.logs.map((entry) =>
			entry.id === noteId ? { ...entry, steeringNote: 'dropped' as const } : entry
		),
	}));
}

/**
 * Consume every pending note for a session, for the task that is about to be
 * dispatched, and mark their transcript entries delivered.
 *
 * Read-and-clear is atomic in the store, so a note the operator sends between
 * this call and the spawn belongs to the NEXT task rather than being lost.
 */
export function takeSteeringNotesForDispatch(sessionId: string): AutoRunSteeringNote[] {
	const taken = useAutoRunSteeringStore.getState().takeNotes(sessionId);
	if (taken.length === 0) return [];

	markNotesDelivered(sessionId, taken);
	return taken.map(({ id, text, timestamp }) => ({ id, text, timestamp }));
}

/** Clear anything pending (run start and run end own the lifetime). */
export function clearSteeringNotes(sessionId: string): void {
	useAutoRunSteeringStore.getState().clearNotes(sessionId);
}

function markNotesDelivered(sessionId: string, notes: readonly PendingSteeringNote[]): void {
	// Notes can span tabs (the operator switched tabs mid-run), so group by tab
	// and do one store write per tab rather than one per note.
	const idsByTab = new Map<string, Set<string>>();
	for (const note of notes) {
		const ids = idsByTab.get(note.tabId) ?? new Set<string>();
		ids.add(note.id);
		idsByTab.set(note.tabId, ids);
	}

	for (const [tabId, ids] of idsByTab) {
		updateAiTab(sessionId, tabId, (tab) => ({
			...tab,
			logs: tab.logs.map((entry) =>
				ids.has(entry.id) ? { ...entry, steeringNote: 'delivered' as const } : entry
			),
		}));
	}
}
