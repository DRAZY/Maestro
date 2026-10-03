/**
 * autoRunSteeringStore - pending Auto Run steering notes, keyed by session.
 *
 * Deliberately NOT part of `batchRunStates` (batchStore). That record is
 * rewritten wholesale by the runner's debounced flush (`setBatchRunStates`
 * resolving a captured snapshot), so a note added between a flush being
 * scheduled and applied would be silently dropped. Notes live in their own
 * store, which nothing else writes, so the only way one disappears is being
 * consumed by a task or cancelled by the operator.
 *
 * Lifetime is the run: cleared when a run starts and when it finishes. Nothing
 * here is persisted - a note that outlived the run it was steering would land
 * in front of an unrelated task days later.
 */

import { create } from 'zustand';
import {
	MAX_PENDING_STEERING_NOTES,
	normalizeSteeringNoteText,
	type AutoRunSteeringNote,
} from '../../shared/autorunSteering';
import { generateId } from '../utils/ids';

/**
 * A pending note plus where its transcript entry lives, so the entry's badge
 * can be flipped from pending to delivered when the note is consumed.
 */
export interface PendingSteeringNote extends AutoRunSteeringNote {
	tabId: string;
}

export interface AutoRunSteeringState {
	/** sessionId -> notes waiting for the next task, oldest first. */
	notes: Record<string, PendingSteeringNote[]>;
}

export interface AutoRunSteeringActions {
	/**
	 * Park a note for the next task. Returns the stored note, or `null` when the
	 * text was empty or the queue is already at `MAX_PENDING_STEERING_NOTES` -
	 * callers fall back to their normal send path rather than dropping input.
	 */
	addNote: (sessionId: string, tabId: string, text: string) => PendingSteeringNote | null;
	/** Cancel a pending note (operator clicked the badge on its transcript entry). */
	removeNote: (sessionId: string, noteId: string) => void;
	/** Read and clear atomically - the notes are now the caller's to deliver. */
	takeNotes: (sessionId: string) => PendingSteeringNote[];
	/** Drop everything pending for a session (run start / run end). */
	clearNotes: (sessionId: string) => void;
}

export type AutoRunSteeringStore = AutoRunSteeringState & AutoRunSteeringActions;

const EMPTY_NOTES: PendingSteeringNote[] = [];

export const useAutoRunSteeringStore = create<AutoRunSteeringStore>()((set, get) => ({
	notes: {},

	addNote: (sessionId, tabId, text) => {
		const normalized = normalizeSteeringNoteText(text);
		if (!normalized) return null;

		const existing = get().notes[sessionId] ?? EMPTY_NOTES;
		if (existing.length >= MAX_PENDING_STEERING_NOTES) return null;

		const note: PendingSteeringNote = {
			id: generateId(),
			text: normalized,
			timestamp: Date.now(),
			tabId,
		};
		set((s) => ({ notes: { ...s.notes, [sessionId]: [...existing, note] } }));
		return note;
	},

	removeNote: (sessionId, noteId) =>
		set((s) => {
			const existing = s.notes[sessionId];
			if (!existing) return {};
			const remaining = existing.filter((note) => note.id !== noteId);
			if (remaining.length === existing.length) return {};
			const next = { ...s.notes };
			if (remaining.length === 0) delete next[sessionId];
			else next[sessionId] = remaining;
			return { notes: next };
		}),

	takeNotes: (sessionId) => {
		const taken = get().notes[sessionId];
		if (!taken || taken.length === 0) return EMPTY_NOTES;
		set((s) => {
			const next = { ...s.notes };
			delete next[sessionId];
			return { notes: next };
		});
		return taken;
	},

	clearNotes: (sessionId) =>
		set((s) => {
			if (!s.notes[sessionId]) return {};
			const next = { ...s.notes };
			delete next[sessionId];
			return { notes: next };
		}),
}));

/** Pending notes for one session. Stable empty array so it is selector-safe. */
export const selectPendingSteeringNotes =
	(sessionId: string) =>
	(s: AutoRunSteeringState): PendingSteeringNote[] =>
		s.notes[sessionId] ?? EMPTY_NOTES;
