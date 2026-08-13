import { memo, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { FileAudio, FileVideo, Volume2, X } from 'lucide-react';

import { GhostIconButton } from '../ui/GhostIconButton';
import { useAnchoredMenuPosition } from '../../hooks/ui/useAnchoredMenuPosition';
import type { MediaItem } from '../../utils/mediaItems';
import type { Theme } from '../../types';

interface MediaListMenuProps {
	/** The title bar button this list hangs off. */
	anchorRef: RefObject<HTMLElement | null>;
	/** Owned by the parent so its outside-click check can see the portaled list. */
	menuRef: RefObject<HTMLDivElement>;
	/** Heading, and the word the remove tooltips use ("queue" / "history"). */
	title: string;
	listLabel: string;
	entries: MediaItem[];
	activeItemId: string | null;
	onSelect: (item: MediaItem) => void;
	onRemove: (itemId: string) => void;
	/** Empties the whole list. Omitted when there is nothing worth clearing. */
	onClear?: () => void;
	testId: string;
	theme: Theme;
}

/**
 * The player's drop-down list of media, used for both the play queue and the
 * recently played history.
 *
 * The two lists are the same UI over different data - one is what plays next in
 * open order, the other is what already played in recency order - so they share
 * a component rather than drifting apart. Media has no tabs, and the
 * transport's prev/next only step one position, so these menus are the only way
 * to reach a file that is neither adjacent nor loaded.
 *
 * Portaled to the body because the player clips its own overflow, which would
 * slice an in-flow menu off at the frame edge.
 */
export const MediaListMenu = memo(function MediaListMenu({
	anchorRef,
	menuRef,
	title,
	listLabel,
	entries,
	activeItemId,
	onSelect,
	onRemove,
	onClear,
	testId,
	theme,
}: MediaListMenuProps) {
	const { left, top, ready } = useAnchoredMenuPosition(menuRef, anchorRef, { align: 'end' });

	return createPortal(
		<div
			ref={menuRef}
			data-testid={testId}
			// Above the player (60), far below modals (9999) so it can never cover
			// an overlay.
			className="fixed z-[100] py-1 rounded shadow-xl border max-h-80 overflow-y-auto select-none min-w-[16rem] max-w-[24rem]"
			style={{
				left,
				top,
				opacity: ready ? 1 : 0,
				backgroundColor: theme.colors.bgActivity,
				borderColor: theme.colors.border,
			}}
		>
			<div className="flex items-center gap-2 px-3 py-1">
				<span
					className="text-[10px] uppercase tracking-wide flex-1"
					style={{ color: theme.colors.textDim }}
				>
					{title}
				</span>
				{onClear && entries.length > 0 && (
					<button
						onClick={onClear}
						className="text-[10px] uppercase tracking-wide hover:underline"
						style={{ color: theme.colors.textDim }}
					>
						Clear
					</button>
				)}
			</div>

			{entries.map((entry) => {
				const isActive = entry.id === activeItemId;
				const KindIcon = entry.kind === 'video' ? FileVideo : FileAudio;
				return (
					<div
						key={entry.id}
						className="group flex items-center gap-2 px-3 py-1 hover:bg-white/10 transition-colors"
					>
						<KindIcon
							className="w-3.5 h-3.5 shrink-0"
							style={{ color: isActive ? theme.colors.accent : theme.colors.textDim }}
						/>
						<button
							onClick={() => onSelect(entry)}
							className="flex flex-col items-start min-w-0 flex-1 text-left"
							title={entry.path}
						>
							<span
								className="text-xs truncate max-w-full"
								style={{ color: isActive ? theme.colors.accent : theme.colors.textMain }}
							>
								{entry.name}
							</span>
							<span
								className="text-[10px] truncate max-w-full"
								style={{ color: theme.colors.textDim }}
							>
								{entry.sessionName}
							</span>
						</button>

						{/* Marks what is loaded right now, so the list reads as a place you
						    are in rather than a flat log. */}
						{isActive && (
							<Volume2 className="w-3 h-3 shrink-0" style={{ color: theme.colors.accent }} />
						)}

						<GhostIconButton
							onClick={() => onRemove(entry.id)}
							title={`Remove from the ${listLabel}`}
							ariaLabel={`Remove ${entry.name} from the ${listLabel}`}
							color={theme.colors.textDim}
						>
							<X className="w-3 h-3" />
						</GhostIconButton>
					</div>
				);
			})}
		</div>,
		document.body
	);
});
