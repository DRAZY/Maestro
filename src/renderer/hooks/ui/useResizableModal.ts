/**
 * useResizableModal - Drag-to-resize logic for centered modal cards.
 *
 * The sibling hook `useResizablePanel` covers edge-docked sidebars (one axis,
 * one settings key). Modals differ enough to warrant their own hook: they resize
 * on both axes from a corner grip, they are centered rather than docked, and
 * their sizes all persist into a single `modalSizes` map in uiStore keyed by the
 * modal's `resizeKey`.
 *
 * Shared with useResizablePanel: DOM writes during the drag (no re-render per
 * mousemove) with a single state commit + persist on mouseup.
 *
 * Because the card is centered, growing the width by W moves its right edge by
 * only W/2. Deltas are therefore doubled so the grip stays under the pointer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useUIStore, type ModalSize } from '../../stores/uiStore';

/** Floor for any resizable modal, so nothing can be dragged into an unusable sliver. */
export const MODAL_MIN_WIDTH = 360;
export const MODAL_MIN_HEIGHT = 300;

/** Share of the viewport a modal may occupy, matching the CSS 95vw/95vh clamp. */
const VIEWPORT_LIMIT = 0.95;

export interface UseResizableModalOptions {
	/** Stable key the size persists under. Undefined disables resizing entirely. */
	resizeKey?: string;
	/** Smallest width the user may drag to. Defaults to MODAL_MIN_WIDTH */
	minWidth?: number;
	/** Smallest height the user may drag to. Defaults to MODAL_MIN_HEIGHT */
	minHeight?: number;
}

export interface UseResizableModalReturn {
	/** Attach to the modal card element */
	cardRef: React.RefObject<HTMLDivElement>;
	/** User-chosen size, or null when the modal is still at its default */
	size: ModalSize | null;
	/** True while dragging - use to suppress transitions and text selection */
	isResizing: boolean;
	/** onMouseDown handler for the corner grip */
	onResizeStart: (e: React.MouseEvent) => void;
	/** Drop the remembered size and snap back to the declared default */
	onResetSize: () => void;
	/** Whether this modal is resizable at all (a resizeKey was supplied) */
	enabled: boolean;
}

/** Clamp a candidate size into [min, 95% of viewport]. */
function clampSize(width: number, height: number, minWidth: number, minHeight: number): ModalSize {
	const maxWidth = Math.max(minWidth, window.innerWidth * VIEWPORT_LIMIT);
	const maxHeight = Math.max(minHeight, window.innerHeight * VIEWPORT_LIMIT);
	return {
		width: Math.round(Math.max(minWidth, Math.min(maxWidth, width))),
		height: Math.round(Math.max(minHeight, Math.min(maxHeight, height))),
	};
}

export function useResizableModal({
	resizeKey,
	minWidth = MODAL_MIN_WIDTH,
	minHeight = MODAL_MIN_HEIGHT,
}: UseResizableModalOptions): UseResizableModalReturn {
	const cardRef = useRef<HTMLDivElement>(null) as React.RefObject<HTMLDivElement>;
	const [isResizing, setIsResizing] = useState(false);
	// Optional chaining on the map: tests and partial store resets can leave
	// `modalSizes` undefined, and a modal must never crash over a missing size.
	const storedSize = useUIStore((s) => (resizeKey ? (s.modalSizes?.[resizeKey] ?? null) : null));

	// Cleanup listeners on unmount (safety net for mid-drag unmount, e.g. Escape)
	const cleanupRef = useRef<(() => void) | null>(null);
	useEffect(() => {
		return () => {
			cleanupRef.current?.();
		};
	}, []);

	const onResizeStart = useCallback(
		(e: React.MouseEvent) => {
			if (!resizeKey) return;
			e.preventDefault();
			e.stopPropagation();
			const card = cardRef.current;
			if (!card) return;

			setIsResizing(true);
			const startX = e.clientX;
			const startY = e.clientY;
			const rect = card.getBoundingClientRect();
			let current: ModalSize = { width: rect.width, height: rect.height };

			const handleMouseMove = (moveEvent: MouseEvent) => {
				current = clampSize(
					rect.width + (moveEvent.clientX - startX) * 2,
					rect.height + (moveEvent.clientY - startY) * 2,
					minWidth,
					minHeight
				);
				if (cardRef.current) {
					cardRef.current.style.width = `${current.width}px`;
					cardRef.current.style.height = `${current.height}px`;
				}
			};

			const handleMouseUp = () => {
				setIsResizing(false);
				useUIStore.getState().setModalSize(resizeKey, current);
				cleanupRef.current?.();
			};

			cleanupRef.current = () => {
				document.removeEventListener('mousemove', handleMouseMove);
				document.removeEventListener('mouseup', handleMouseUp);
				cleanupRef.current = null;
			};

			document.addEventListener('mousemove', handleMouseMove);
			document.addEventListener('mouseup', handleMouseUp);
		},
		[resizeKey, minWidth, minHeight]
	);

	const onResetSize = useCallback(() => {
		if (!resizeKey) return;
		// Clear the inline styles written during the last drag, otherwise they
		// would keep overriding the default size React re-renders with.
		if (cardRef.current) {
			cardRef.current.style.width = '';
			cardRef.current.style.height = '';
		}
		useUIStore.getState().resetModalSize(resizeKey);
	}, [resizeKey]);

	// Re-clamp a persisted size against the current viewport: a modal sized on a
	// large display must not open taller than a laptop screen after a move.
	const size = storedSize
		? clampSize(
				Math.max(storedSize.width, minWidth),
				Math.max(storedSize.height, minHeight),
				minWidth,
				minHeight
			)
		: null;

	return {
		cardRef,
		size,
		isResizing,
		onResizeStart,
		onResetSize,
		enabled: Boolean(resizeKey),
	};
}

/** Exported for tests and any custom modal shell that clamps its own size. */
export { clampSize as clampModalSize };
