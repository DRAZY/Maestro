/**
 * groupChatStore - Zustand store for group chat state management
 *
 * Replaces GroupChatContext. All group chat states (chats list, messages,
 * moderator state, participant states, execution queue, etc.) live here.
 * Components subscribe to individual slices via selectors to avoid
 * unnecessary re-renders.
 *
 * Refs (groupChatInputRef, groupChatMessagesRef) stay outside the store
 * since they are React-specific and don't trigger re-renders.
 *
 * Can be used outside React via useGroupChatStore.getState().
 */

import { create } from 'zustand';
import type { GroupChat, GroupChatMessage, GroupChatState, AgentError } from '../types';
import type { QueuedItem } from '../types';

// ============================================================================
// Types
// ============================================================================

/** Right panel tab within the group chat view */
export type GroupChatRightTab = 'participants' | 'history';

// ============================================================================
// Per-chat view preferences (persisted)
// ============================================================================
// How the user reads ONE room: the full team transcript or only the user <->
// moderator conversation, and which History type pills are lit.
//
// These live in the store rather than in the panel because several unrelated
// places read them - the header control, the message list, and the right
// panel's history tab (a sibling of the panel, not a child) - plus the keyboard
// handler and the command palette, which toggle from outside the React tree
// entirely.
//
// They are keyed BY CHAT. The earlier version kept one moderator-only value for
// every room on the theory that the user is choosing a reading style rather
// than tagging chats. In practice a room's right answer follows the room: a
// busy delivery chat is worth reading in full, a noisy one is only worth the
// moderator's summary, and re-picking on every switch is the annoyance.
//
// Storage is renderer localStorage rather than the chat's own `chat.json`,
// because `updateGroupChat` stamps `updatedAt` on every write
// (`group-chat-storage.ts`), which would make clicking a filter count as chat
// activity and reorder the room list. The cost is that these are per device.
//
// Deliberately NOT here: the History lookback window. It is already persisted
// per chat through `window.maestro.settings` under
// `groupChatHistoryLookback:<id>` (see `GroupChatHistoryPanel`). Folding it in
// would reset every lookback a user has already chosen, to no benefit.

/** The legacy single-value key, still read once as the default for chats with no entry. */
const MODERATOR_ONLY_VIEW_KEY = 'maestro.groupChat.moderatorOnlyView';
const VIEW_PREFS_KEY = 'maestro.groupChat.viewPrefs';

/** What one chat remembers about how it is being read. */
export interface GroupChatViewPrefs {
	/** true = Moderator Only, false = Team Chat. */
	moderatorOnly: boolean;
	/**
	 * History type pills that are switched ON, or null when the chat has never
	 * saved a set (meaning "all of them").
	 *
	 * Held as plain strings so this module stays independent of the history
	 * entry union; the panel narrows them and drops any it does not recognise.
	 * An EMPTY array is a real saved state (every pill off) and is preserved,
	 * which is why "never saved" has to be null rather than `[]`.
	 */
	historyTypes: string[] | null;
}

export type GroupChatViewPrefsMap = Record<string, GroupChatViewPrefs>;

function readLegacyModeratorOnlyView(): boolean {
	if (typeof window === 'undefined') return false;
	try {
		return window.localStorage.getItem(MODERATOR_ONLY_VIEW_KEY) === 'true';
	} catch {
		return false;
	}
}

/**
 * Read the whole per-chat map, tolerating anything on disk.
 *
 * localStorage is user-writable and survives downgrades, so every layer is
 * checked: unparseable JSON, a non-object root, a non-object entry, or a field
 * of the wrong type all degrade to "no saved preference" rather than throwing
 * during store creation, which would take the renderer down on boot.
 */
function readStoredViewPrefs(): GroupChatViewPrefsMap {
	if (typeof window === 'undefined') return {};
	let raw: string | null = null;
	try {
		raw = window.localStorage.getItem(VIEW_PREFS_KEY);
	} catch {
		return {};
	}
	if (!raw) return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

	const out: GroupChatViewPrefsMap = {};
	for (const [chatId, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
		const entry = value as Record<string, unknown>;
		const types = entry.historyTypes;
		out[chatId] = {
			moderatorOnly: entry.moderatorOnly === true,
			historyTypes: Array.isArray(types)
				? types.filter((t): t is string => typeof t === 'string')
				: null,
		};
	}
	return out;
}

function writeStoredViewPrefs(prefs: GroupChatViewPrefsMap): void {
	if (typeof window === 'undefined') return;
	try {
		window.localStorage.setItem(VIEW_PREFS_KEY, JSON.stringify(prefs));
	} catch {
		// Ignore quota / privacy-mode errors - the preference just won't persist.
	}
}

/**
 * The preferences for one chat, falling back to the defaults.
 *
 * A chat nobody has configured inherits the legacy global toggle, so upgrading
 * does not silently flip every room back to Team Chat.
 */
export function viewPrefsFor(
	prefs: GroupChatViewPrefsMap,
	groupChatId: string | null
): GroupChatViewPrefs {
	const saved = groupChatId ? prefs[groupChatId] : undefined;
	if (saved) return saved;
	return { moderatorOnly: readLegacyModeratorOnlyView(), historyTypes: null };
}

/**
 * Save the moderator-only choice against the open chat and return the store
 * slice to merge.
 *
 * The shortcut and the command palette can fire this with no room open. There
 * is no chat to key by then, so it falls back to the legacy global value, which
 * is also what an unconfigured chat inherits - the next room the user opens
 * therefore starts on the mode they just asked for rather than ignoring them.
 */
function persistModeratorOnly(
	state: { activeGroupChatId: string | null; groupChatViewPrefs: GroupChatViewPrefsMap },
	moderatorOnly: boolean
): Partial<{ groupChatViewPrefs: GroupChatViewPrefsMap }> {
	const chatId = state.activeGroupChatId;
	if (!chatId) {
		if (typeof window !== 'undefined') {
			try {
				window.localStorage.setItem(MODERATOR_ONLY_VIEW_KEY, String(moderatorOnly));
			} catch {
				// Ignore quota / privacy-mode errors.
			}
		}
		return {};
	}

	const current = viewPrefsFor(state.groupChatViewPrefs, chatId);
	const prefs: GroupChatViewPrefsMap = {
		...state.groupChatViewPrefs,
		[chatId]: { ...current, moderatorOnly },
	};
	writeStoredViewPrefs(prefs);
	return { groupChatViewPrefs: prefs };
}

/** Group chat error state - tracks which chat has an error and from which participant */
export interface GroupChatErrorState {
	groupChatId: string;
	error: AgentError;
	participantName?: string;
}

export interface GroupChatStoreState {
	// Entity data
	groupChats: GroupChat[];
	activeGroupChatId: string | null;

	// Active chat state
	groupChatMessages: GroupChatMessage[];
	groupChatState: GroupChatState;
	participantStates: Map<string, 'idle' | 'working'>;
	moderatorUsage: { contextUsage: number; totalCost: number; tokenCount: number } | null;

	// All-chats tracking (for sidebar busy indicators when chat is not active)
	groupChatStates: Map<string, GroupChatState>;
	allGroupChatParticipantStates: Map<string, Map<string, 'idle' | 'working'>>;

	/**
	 * Rooms that produced output the user has not looked at. Populated only for
	 * NON-active rooms: the active room is on screen, so its messages are read
	 * by definition. Per-boot, like tab unread state - a restart is a clean
	 * slate rather than a pile of stale red dots.
	 */
	unreadGroupChatIds: Set<string>;

	// Execution
	groupChatExecutionQueue: QueuedItem[];
	groupChatReadOnlyMode: boolean;

	// UI
	groupChatRightTab: GroupChatRightTab;
	groupChatParticipantColors: Record<string, string>;
	groupChatStagedImages: string[];
	/**
	 * True when the room shows only the user <-> moderator conversation, hiding
	 * delegations and participant replies from both the message list and the
	 * history tab. Persisted across restarts; a display filter only.
	 */
	groupChatModeratorOnly: boolean;
	/**
	 * Saved view preferences for every chat that has any, keyed by chat id.
	 * `groupChatModeratorOnly` above is this map's value for the ACTIVE chat,
	 * kept as its own field so the header, keyboard handler and command palette
	 * can read one boolean without knowing which chat is open.
	 */
	groupChatViewPrefs: GroupChatViewPrefsMap;

	// Live output peek
	participantLiveOutput: Map<string, string>;

	// Error
	groupChatError: GroupChatErrorState | null;
}

export interface GroupChatStoreActions {
	// Entity setters
	setGroupChats: (v: GroupChat[] | ((prev: GroupChat[]) => GroupChat[])) => void;
	setActiveGroupChatId: (v: string | null | ((prev: string | null) => string | null)) => void;

	// Active chat setters
	setGroupChatMessages: (
		v: GroupChatMessage[] | ((prev: GroupChatMessage[]) => GroupChatMessage[])
	) => void;
	setGroupChatState: (v: GroupChatState | ((prev: GroupChatState) => GroupChatState)) => void;
	setParticipantStates: (
		v:
			| Map<string, 'idle' | 'working'>
			| ((prev: Map<string, 'idle' | 'working'>) => Map<string, 'idle' | 'working'>)
	) => void;
	setModeratorUsage: (
		v:
			| { contextUsage: number; totalCost: number; tokenCount: number }
			| null
			| ((
					prev: { contextUsage: number; totalCost: number; tokenCount: number } | null
			  ) => { contextUsage: number; totalCost: number; tokenCount: number } | null)
	) => void;

	// All-chats tracking
	setGroupChatStates: (
		v:
			| Map<string, GroupChatState>
			| ((prev: Map<string, GroupChatState>) => Map<string, GroupChatState>)
	) => void;
	setAllGroupChatParticipantStates: (
		v:
			| Map<string, Map<string, 'idle' | 'working'>>
			| ((
					prev: Map<string, Map<string, 'idle' | 'working'>>
			  ) => Map<string, Map<string, 'idle' | 'working'>>)
	) => void;

	// Unread
	/** Flag a room as having output the user hasn't seen. No-op if already flagged. */
	markGroupChatUnread: (groupChatId: string) => void;
	/** Clear a room's unread flag (opening it), or every room when called bare. */
	clearGroupChatUnread: (groupChatId?: string) => void;

	// Execution
	setGroupChatExecutionQueue: (v: QueuedItem[] | ((prev: QueuedItem[]) => QueuedItem[])) => void;
	setGroupChatReadOnlyMode: (v: boolean | ((prev: boolean) => boolean)) => void;

	// UI
	setGroupChatRightTab: (
		v: GroupChatRightTab | ((prev: GroupChatRightTab) => GroupChatRightTab)
	) => void;
	setGroupChatParticipantColors: (
		v: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>)
	) => void;
	setGroupChatStagedImages: (v: string[] | ((prev: string[]) => string[])) => void;
	/** Set the moderator-only view preference and persist it. */
	setGroupChatModeratorOnly: (v: boolean | ((prev: boolean) => boolean)) => void;
	/** Flip between the team view and the moderator-only view. */
	toggleGroupChatModeratorOnly: () => void;
	/** Persist which History type pills are lit for one chat. */
	setGroupChatHistoryTypes: (groupChatId: string, types: string[]) => void;

	// Live output peek
	appendParticipantLiveOutput: (participantName: string, chunk: string) => void;
	clearParticipantLiveOutput: (participantName?: string) => void;

	// Error
	setGroupChatError: (
		v:
			| GroupChatErrorState
			| null
			| ((prev: GroupChatErrorState | null) => GroupChatErrorState | null)
	) => void;

	// Convenience methods
	/** Clear the current error. Focus side-effect (ref.focus) must be handled by caller. */
	clearGroupChatError: () => void;
	/** Reset active chat state (close chat). Clears activeGroupChatId, messages, state, participants, error. */
	resetGroupChatState: () => void;
}

export type GroupChatStore = GroupChatStoreState & GroupChatStoreActions;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve a value-or-updater argument, matching React's setState signature.
 */
function resolve<T>(valOrFn: T | ((prev: T) => T), prev: T): T {
	return typeof valOrFn === 'function' ? (valOrFn as (prev: T) => T)(prev) : valOrFn;
}

// ============================================================================
// Store
// ============================================================================

export const useGroupChatStore = create<GroupChatStore>()((set) => ({
	// --- State ---
	groupChats: [],
	activeGroupChatId: null,
	groupChatMessages: [],
	groupChatState: 'idle' as GroupChatState,
	participantStates: new Map(),
	moderatorUsage: null,
	groupChatStates: new Map(),
	allGroupChatParticipantStates: new Map(),
	unreadGroupChatIds: new Set(),
	groupChatExecutionQueue: [],
	groupChatReadOnlyMode: false,
	groupChatRightTab: 'participants' as GroupChatRightTab,
	groupChatParticipantColors: {},
	groupChatStagedImages: [],
	groupChatViewPrefs: readStoredViewPrefs(),
	// No chat is open at boot, so this is the legacy default until one is
	// selected and `setActiveGroupChatId` swaps in that chat's own value.
	groupChatModeratorOnly: viewPrefsFor(readStoredViewPrefs(), null).moderatorOnly,
	participantLiveOutput: new Map(),
	groupChatError: null,

	// --- Actions ---
	setGroupChats: (v) => set((s) => ({ groupChats: resolve(v, s.groupChats) })),
	// Switching rooms swaps in that room's own reading mode. Recomputed only on
	// an actual change of id, so re-selecting the open chat cannot clobber a
	// toggle that is landing in the same tick.
	setActiveGroupChatId: (v) =>
		set((s) => {
			const next = resolve(v, s.activeGroupChatId);
			if (next === s.activeGroupChatId) return {};
			return {
				activeGroupChatId: next,
				groupChatModeratorOnly: viewPrefsFor(s.groupChatViewPrefs, next).moderatorOnly,
			};
		}),
	setGroupChatMessages: (v) => set((s) => ({ groupChatMessages: resolve(v, s.groupChatMessages) })),
	setGroupChatState: (v) => set((s) => ({ groupChatState: resolve(v, s.groupChatState) })),
	setParticipantStates: (v) => set((s) => ({ participantStates: resolve(v, s.participantStates) })),
	setModeratorUsage: (v) => set((s) => ({ moderatorUsage: resolve(v, s.moderatorUsage) })),
	setGroupChatStates: (v) => set((s) => ({ groupChatStates: resolve(v, s.groupChatStates) })),
	setAllGroupChatParticipantStates: (v) =>
		set((s) => ({
			allGroupChatParticipantStates: resolve(v, s.allGroupChatParticipantStates),
		})),
	// Both guard on membership before allocating a new Set: these fire on every
	// inbound message and on every chat open, and an unconditional copy would
	// re-render every unread subscriber for a no-op change.
	markGroupChatUnread: (groupChatId) =>
		set((s) => {
			if (s.unreadGroupChatIds.has(groupChatId)) return {};
			const next = new Set(s.unreadGroupChatIds);
			next.add(groupChatId);
			return { unreadGroupChatIds: next };
		}),

	clearGroupChatUnread: (groupChatId) =>
		set((s) => {
			if (groupChatId === undefined) {
				return s.unreadGroupChatIds.size === 0 ? {} : { unreadGroupChatIds: new Set<string>() };
			}
			if (!s.unreadGroupChatIds.has(groupChatId)) return {};
			const next = new Set(s.unreadGroupChatIds);
			next.delete(groupChatId);
			return { unreadGroupChatIds: next };
		}),

	setGroupChatExecutionQueue: (v) =>
		set((s) => ({ groupChatExecutionQueue: resolve(v, s.groupChatExecutionQueue) })),
	setGroupChatReadOnlyMode: (v) =>
		set((s) => ({ groupChatReadOnlyMode: resolve(v, s.groupChatReadOnlyMode) })),
	setGroupChatRightTab: (v) => set((s) => ({ groupChatRightTab: resolve(v, s.groupChatRightTab) })),
	setGroupChatParticipantColors: (v) =>
		set((s) => ({ groupChatParticipantColors: resolve(v, s.groupChatParticipantColors) })),
	setGroupChatStagedImages: (v) =>
		set((s) => ({ groupChatStagedImages: resolve(v, s.groupChatStagedImages) })),
	setGroupChatModeratorOnly: (v) =>
		set((s) => {
			const next = resolve(v, s.groupChatModeratorOnly);
			if (next === s.groupChatModeratorOnly) return {};
			return { ...persistModeratorOnly(s, next), groupChatModeratorOnly: next };
		}),
	toggleGroupChatModeratorOnly: () =>
		set((s) => {
			const next = !s.groupChatModeratorOnly;
			return { ...persistModeratorOnly(s, next), groupChatModeratorOnly: next };
		}),
	setGroupChatHistoryTypes: (groupChatId, types) =>
		set((s) => {
			const current = viewPrefsFor(s.groupChatViewPrefs, groupChatId);
			const prefs: GroupChatViewPrefsMap = {
				...s.groupChatViewPrefs,
				[groupChatId]: { ...current, historyTypes: types },
			};
			writeStoredViewPrefs(prefs);
			return { groupChatViewPrefs: prefs };
		}),
	setGroupChatError: (v) => set((s) => ({ groupChatError: resolve(v, s.groupChatError) })),

	appendParticipantLiveOutput: (participantName, chunk) =>
		set((s) => {
			const next = new Map(s.participantLiveOutput);
			const existing = next.get(participantName) || '';
			// Cap at ~50KB per participant to prevent unbounded growth
			const combined = existing + chunk;
			next.set(participantName, combined.length > 50000 ? combined.slice(-50000) : combined);
			return { participantLiveOutput: next };
		}),

	clearParticipantLiveOutput: (participantName) =>
		set((s) => {
			if (participantName) {
				const next = new Map(s.participantLiveOutput);
				next.delete(participantName);
				return { participantLiveOutput: next };
			}
			return { participantLiveOutput: new Map() };
		}),

	clearGroupChatError: () => set({ groupChatError: null }),

	resetGroupChatState: () =>
		set({
			activeGroupChatId: null,
			groupChatMessages: [],
			groupChatState: 'idle' as GroupChatState,
			participantStates: new Map(),
			participantLiveOutput: new Map(),
			groupChatError: null,
		}),
}));
