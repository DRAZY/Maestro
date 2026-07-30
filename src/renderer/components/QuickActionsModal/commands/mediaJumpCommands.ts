import type { Session } from '../../../types';
import { collectMediaTabs } from '../../../utils/mediaTabs';
import { fileTabFocusFields } from '../../../utils/tabHelpers';
import type { QuickAction } from '../types';
import { alphabetizeKey } from '../utils/quickActionSorting';

interface BuildMediaJumpCommandsArgs {
	sessions: Session[];
	/** File tab IDs currently playing, from the media playback store. */
	playingTabIds: Set<string>;
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	setActiveSessionId: (id: string) => void;
	revealJumpTarget: (session: Session) => void;
}

/**
 * One entry per file preview tab that is currently playing audio or video.
 *
 * Because playback is hosted app-level, a tab can be making noise while its
 * agent sits idle and its tab is nowhere on screen - which is exactly the case
 * these rows exist for. Selecting one activates the owning agent *and* focuses
 * the tab, landing the user on the transport so they can pause it.
 */
export function buildMediaJumpCommands({
	sessions,
	playingTabIds,
	setSessions,
	setActiveSessionId,
	revealJumpTarget,
}: BuildMediaJumpCommandsArgs): QuickAction[] {
	if (playingTabIds.size === 0) return [];

	return collectMediaTabs(sessions)
		.filter((ref) => playingTabIds.has(ref.tabId))
		.map((ref) => {
			const label = `${ref.name}${ref.extension}`;
			return {
				id: `jump-media-${ref.tabId}`,
				label,
				subtext: ref.sessionName,
				action: () => {
					setSessions((prev) =>
						prev.map((s) =>
							s.id === ref.sessionId ? { ...s, ...fileTabFocusFields(ref.tabId) } : s
						)
					);
					setActiveSessionId(ref.sessionId);
					const owner = sessions.find((s) => s.id === ref.sessionId);
					if (owner) revealJumpTarget(owner);
				},
				playingMediaKind: ref.kind,
				agentSortKey: alphabetizeKey(label),
			};
		});
}
