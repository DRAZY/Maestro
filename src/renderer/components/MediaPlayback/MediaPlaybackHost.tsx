import { memo, useEffect, useMemo, useRef } from 'react';

import { MediaViewer } from '../FilePreview/MediaViewer';
import { collectMediaTabs, type MediaTabRef } from '../../utils/mediaTabs';
import { useMediaPlaybackStore } from '../../stores/mediaPlaybackStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useTabStore } from '../../stores/tabStore';
import type { Theme } from '../../types';

interface MediaPlaybackHostProps {
	theme: Theme;
}

/**
 * App-level owner of every audio/video element.
 *
 * Mounted exactly once, near the root, and never unmounted. MainPanelContent
 * only renders FilePreview for the active file tab of the active session, so a
 * player living inside the tab would be torn down the moment the user looked
 * elsewhere - and removing a media element from the document runs the HTML
 * spec's internal pause steps, killing playback. Hosting the elements here is
 * what lets a podcast keep playing while the user switches tabs and agents.
 *
 * Each element is parked over the rect published by the MediaViewportSlot that
 * FilePreview renders in its place. When the owning tab is off screen the box
 * keeps its last rect but goes `visibility: hidden` - the same trick the
 * terminal and browser tab overlays use, chosen over unmounting for exactly the
 * same reason, and over zero-sizing so a video's decode pipeline stays intact.
 */
export const MediaPlaybackHost = memo(function MediaPlaybackHost({
	theme,
}: MediaPlaybackHostProps) {
	const sessions = useSessionStore((s) => s.sessions);
	const slots = useMediaPlaybackStore((s) => s.slots);
	const clearTab = useMediaPlaybackStore((s) => s.clearTab);

	const mediaTabs = useMemo(() => collectMediaTabs(sessions), [sessions]);

	// Drop store entries for tabs that have closed. Without this, a closed tab
	// would keep reporting itself as playing in the Command palette forever.
	const knownTabIdsRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		const live = new Set(mediaTabs.map((t) => t.tabId));
		for (const tabId of knownTabIdsRef.current) {
			if (!live.has(tabId)) clearTab(tabId);
		}
		knownTabIdsRef.current = live;
	}, [mediaTabs, clearTab]);

	if (mediaTabs.length === 0) return null;

	return (
		<>
			{mediaTabs.map((ref) => (
				<MediaPlaybackFrame key={ref.tabId} mediaRef={ref} slot={slots[ref.tabId]} theme={theme} />
			))}
		</>
	);
});

interface MediaPlaybackFrameProps {
	mediaRef: MediaTabRef;
	slot:
		| { rect: { top: number; left: number; width: number; height: number }; visible: boolean }
		| undefined;
	theme: Theme;
}

/**
 * One media element, positioned over its tab's slot. Split out so a rect change
 * on one tab does not re-render the others (and so React keeps each element
 * instance stable, which is the whole point).
 */
function MediaPlaybackFrame({ mediaRef, slot, theme }: MediaPlaybackFrameProps) {
	const clearAutoplay = useTabStore((s) => s.clearFileTabAutoplayMedia);

	// Clear the persisted one-shot once it has been handed to the player, so no
	// later re-render can replay a file the user has since paused. Child effects
	// run before parent ones, so MediaViewer has already armed itself off the
	// prop by the time this fires.
	useEffect(() => {
		if (mediaRef.autoplay) clearAutoplay(mediaRef.tabId);
	}, [mediaRef.autoplay, mediaRef.tabId, clearAutoplay]);

	// Before the slot has ever reported in, there is nothing sensible to lay out.
	// Park the element off screen at a real size so it can still load and play.
	const rect = slot?.rect ?? { top: 0, left: 0, width: 640, height: 360 };
	const visible = slot?.visible ?? false;

	return (
		<div
			data-media-frame={mediaRef.tabId}
			style={{
				position: 'fixed',
				top: rect.top,
				left: rect.left,
				width: rect.width,
				height: rect.height,
				visibility: visible ? 'visible' : 'hidden',
				pointerEvents: visible ? 'auto' : 'none',
				// Above the file preview content, far below modals (9999) and
				// Center Flash (100001) so it can never cover an overlay.
				zIndex: visible ? 5 : -1,
				backgroundColor: theme.colors.bgMain,
			}}
		>
			<MediaViewer
				tabId={mediaRef.tabId}
				kind={mediaRef.kind}
				name={`${mediaRef.name}${mediaRef.extension}`}
				path={mediaRef.path}
				autoplay={mediaRef.autoplay}
				theme={theme}
			/>
		</div>
	);
}
