/**
 * Media Playback Store
 *
 * Transient state for audio/video files open in file preview tabs. Two things
 * live here, both of which have to outlive the FilePreview component:
 *
 *  - **Playback state** (`playing`), so the Command palette can list what is
 *    currently making noise and jump back to it.
 *  - **Slot geometry** (`slots`), so the app-level MediaPlaybackHost can park
 *    each media element over the tab that owns it.
 *
 * Why the element cannot just live in FilePreview: MainPanelContent only renders
 * FilePreview for the *active* file tab of the *active* session, so switching
 * tabs or agents unmounts it. Removing a media element from the document runs
 * the HTML spec's internal pause steps, which would kill playback every time
 * the user looked at something else. The element therefore lives in a host that
 * is mounted once in App.tsx and is never unmounted; this store is how the
 * in-tab UI and that host talk to each other.
 *
 * Nothing here is persisted. Playback does not survive a restart, and the
 * `maestro-media://` stream URLs are re-minted per boot anyway.
 */

import { create } from 'zustand';

/** Viewport rect (CSS pixels, viewport-relative) of a media tab's slot. */
export interface MediaSlotRect {
	top: number;
	left: number;
	width: number;
	height: number;
}

export interface MediaSlotState {
	/**
	 * Last known rect of the in-tab slot. Retained even while hidden so the
	 * media element keeps non-zero dimensions - a zero-sized video can get its
	 * decode pipeline torn down, which is the same failure `visibility: hidden`
	 * (rather than unmounting) exists to avoid for terminals and browser tabs.
	 */
	rect: MediaSlotRect;
	/** Whether the owning tab is currently on screen. */
	visible: boolean;
}

interface MediaPlaybackStoreState {
	/** File tab ID -> whether that tab's media is playing right now. */
	playing: Record<string, boolean>;
	/** File tab ID -> where to park that tab's media element. */
	slots: Record<string, MediaSlotState>;

	setPlaying: (tabId: string, playing: boolean) => void;
	/** Publish the slot rect and mark the tab visible. Called from the in-tab slot. */
	setSlotRect: (tabId: string, rect: MediaSlotRect) => void;
	/** Mark the slot off screen, keeping its last rect so playback continues. */
	hideSlot: (tabId: string) => void;
	/** Drop everything for a tab. Called when the tab itself goes away. */
	clearTab: (tabId: string) => void;
}

export const useMediaPlaybackStore = create<MediaPlaybackStoreState>()((set) => ({
	playing: {},
	slots: {},

	setPlaying: (tabId, playing) =>
		set((state) => {
			if (!!state.playing[tabId] === playing) return state;
			return { playing: { ...state.playing, [tabId]: playing } };
		}),

	setSlotRect: (tabId, rect) =>
		set((state) => {
			const prev = state.slots[tabId];
			if (
				prev?.visible &&
				prev.rect.top === rect.top &&
				prev.rect.left === rect.left &&
				prev.rect.width === rect.width &&
				prev.rect.height === rect.height
			) {
				// Identical rect: bail out so ResizeObserver churn does not
				// re-render the host (and with it every mounted media element).
				return state;
			}
			return { slots: { ...state.slots, [tabId]: { rect, visible: true } } };
		}),

	hideSlot: (tabId) =>
		set((state) => {
			const prev = state.slots[tabId];
			if (!prev || !prev.visible) return state;
			return { slots: { ...state.slots, [tabId]: { ...prev, visible: false } } };
		}),

	clearTab: (tabId) =>
		set((state) => {
			if (state.playing[tabId] === undefined && state.slots[tabId] === undefined) return state;
			const playing = { ...state.playing };
			const slots = { ...state.slots };
			delete playing[tabId];
			delete slots[tabId];
			return { playing, slots };
		}),
}));

/** Non-React access, for callers outside the component tree. */
export function getMediaPlaybackActions() {
	const state = useMediaPlaybackStore.getState();
	return {
		setPlaying: state.setPlaying,
		setSlotRect: state.setSlotRect,
		hideSlot: state.hideSlot,
		clearTab: state.clearTab,
	};
}

/** Whether any media tab is currently playing. */
export function selectHasPlayingMedia(state: { playing: Record<string, boolean> }): boolean {
	return Object.values(state.playing).some(Boolean);
}
