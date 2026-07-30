/**
 * Media File Tab Helpers
 *
 * One predicate for "is this file preview tab a playable media file", shared by
 * everything that needs to agree on the answer: FilePreview (which renders a
 * slot instead of content), MediaPlaybackHost (which owns the element), and the
 * Command palette's MEDIA section.
 *
 * The test is deliberately content-based rather than extension-based. The main
 * process only hands back a `maestro-media://` stream URL for *local* files it
 * can actually range-serve, so a `.mp4` opened over SSH keeps the existing
 * binary "download and open externally" path instead of landing in a player
 * that has no bytes to read.
 */

import { getMediaKind, isMediaStreamUrl, type MediaKind } from '../../shared/mediaTypes';
import type { Session } from '../types';

/**
 * Media kind for a previewed file, or `null` when it is not playable media.
 *
 * Takes the filename and content as separate scalars on purpose. A
 * `FilePreviewTab` splits the name from its extension (`name: 'song'`,
 * `extension: '.mp3'`) while the object handed to FilePreview joins them back
 * together - passing either record shape directly is how you silently get
 * "song" and no media. Callers must produce a filename that has its extension.
 *
 * Safe to call with a stream URL minted by a previous boot: the check is a
 * prefix test, not a token validation, so a restored tab is still recognized as
 * media and the host re-resolves the URL before playing it.
 */
export function getFileTabMediaKind(fileName: string, content: string): MediaKind | null {
	if (!isMediaStreamUrl(content)) return null;
	return getMediaKind(fileName);
}

/** A media tab plus the agent that owns it. */
export interface MediaTabRef {
	tabId: string;
	sessionId: string;
	sessionName: string;
	/** File name as shown in the tab, without the extension. */
	name: string;
	extension: string;
	path: string;
	kind: MediaKind;
	/** One-shot request to start playing, set when the user opened this file. */
	autoplay: boolean;
}

/**
 * Every playable media tab across every agent, in a stable order (agent order,
 * then tab creation order). Spans all sessions on purpose: playback has to
 * survive switching agents, so the host cannot be scoped to the active one.
 */
export function collectMediaTabs(sessions: Session[]): MediaTabRef[] {
	const refs: MediaTabRef[] = [];
	for (const session of sessions) {
		for (const tab of session.filePreviewTabs ?? []) {
			const kind = getFileTabMediaKind(`${tab.name}${tab.extension}`, tab.content);
			if (!kind) continue;
			refs.push({
				tabId: tab.id,
				sessionId: session.id,
				sessionName: session.name,
				name: tab.name,
				extension: tab.extension,
				path: tab.path,
				kind,
				autoplay: !!tab.autoplayMedia,
			});
		}
	}
	return refs;
}
