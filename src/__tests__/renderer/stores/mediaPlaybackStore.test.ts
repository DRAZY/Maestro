import { beforeEach, describe, expect, it } from 'vitest';
import {
	selectHasPlayingMedia,
	useMediaPlaybackStore,
} from '../../../renderer/stores/mediaPlaybackStore';

const RECT = { top: 10, left: 20, width: 300, height: 200 };

describe('mediaPlaybackStore', () => {
	beforeEach(() => {
		useMediaPlaybackStore.setState({ playing: {}, slots: {} });
	});

	it('tracks playback per tab', () => {
		useMediaPlaybackStore.getState().setPlaying('a', true);
		useMediaPlaybackStore.getState().setPlaying('b', true);
		useMediaPlaybackStore.getState().setPlaying('a', false);
		expect(useMediaPlaybackStore.getState().playing).toEqual({ a: false, b: true });
	});

	it('does not record an entry for a tab that was never playing', () => {
		// Every player reports false on mount; absent and false mean the same
		// thing, so paused tabs must not accumulate entries.
		useMediaPlaybackStore.getState().setPlaying('a', false);
		expect(useMediaPlaybackStore.getState().playing).toEqual({});
	});

	it('keeps the same state object when playback is unchanged', () => {
		useMediaPlaybackStore.getState().setPlaying('a', true);
		const before = useMediaPlaybackStore.getState().playing;
		useMediaPlaybackStore.getState().setPlaying('a', true);
		// Identity is the point: a no-op must not re-render every media element.
		expect(useMediaPlaybackStore.getState().playing).toBe(before);
	});

	it('publishes a slot rect and marks it visible', () => {
		useMediaPlaybackStore.getState().setSlotRect('a', RECT);
		expect(useMediaPlaybackStore.getState().slots.a).toEqual({ rect: RECT, visible: true });
	});

	it('ignores a repeated identical rect', () => {
		useMediaPlaybackStore.getState().setSlotRect('a', RECT);
		const before = useMediaPlaybackStore.getState().slots;
		useMediaPlaybackStore.getState().setSlotRect('a', { ...RECT });
		expect(useMediaPlaybackStore.getState().slots).toBe(before);
	});

	it('applies a changed rect', () => {
		useMediaPlaybackStore.getState().setSlotRect('a', RECT);
		useMediaPlaybackStore.getState().setSlotRect('a', { ...RECT, width: 400 });
		expect(useMediaPlaybackStore.getState().slots.a.rect.width).toBe(400);
	});

	it('retains the last rect when hiding so playback keeps a real size', () => {
		useMediaPlaybackStore.getState().setSlotRect('a', RECT);
		useMediaPlaybackStore.getState().hideSlot('a');
		expect(useMediaPlaybackStore.getState().slots.a).toEqual({ rect: RECT, visible: false });
	});

	it('re-shows a hidden slot when the tab comes back', () => {
		useMediaPlaybackStore.getState().setSlotRect('a', RECT);
		useMediaPlaybackStore.getState().hideSlot('a');
		useMediaPlaybackStore.getState().setSlotRect('a', RECT);
		expect(useMediaPlaybackStore.getState().slots.a.visible).toBe(true);
	});

	it('hiding an unknown or already-hidden slot is a no-op', () => {
		const before = useMediaPlaybackStore.getState().slots;
		useMediaPlaybackStore.getState().hideSlot('nope');
		expect(useMediaPlaybackStore.getState().slots).toBe(before);
	});

	it('clears everything for a closed tab', () => {
		useMediaPlaybackStore.getState().setPlaying('a', true);
		useMediaPlaybackStore.getState().setSlotRect('a', RECT);
		useMediaPlaybackStore.getState().setPlaying('b', true);

		useMediaPlaybackStore.getState().clearTab('a');

		expect(useMediaPlaybackStore.getState().playing).toEqual({ b: true });
		expect(useMediaPlaybackStore.getState().slots.a).toBeUndefined();
	});

	it('clearing an unknown tab is a no-op', () => {
		const before = useMediaPlaybackStore.getState().playing;
		useMediaPlaybackStore.getState().clearTab('nope');
		expect(useMediaPlaybackStore.getState().playing).toBe(before);
	});

	it('selectHasPlayingMedia reports whether anything is audible', () => {
		expect(selectHasPlayingMedia({ playing: {} })).toBe(false);
		expect(selectHasPlayingMedia({ playing: { a: false } })).toBe(false);
		expect(selectHasPlayingMedia({ playing: { a: false, b: true } })).toBe(true);
	});
});
