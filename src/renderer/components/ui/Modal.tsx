/**
 * Modal - Reusable modal wrapper component
 *
 * This component provides consistent modal UI structure across the application,
 * combining the useModalLayer hook for layer stack management with standardized
 * backdrop, container, header, and footer patterns.
 *
 * Features:
 * - Automatic layer stack registration via useModalLayer
 * - Consistent themed styling (backdrop, borders, colors)
 * - Configurable width and max height
 * - Optional header with title and close button
 * - Optional footer for action buttons
 * - Auto-focus support for initial focus target
 * - Escape key handling via layer stack
 * - Accessible dialog semantics (role, aria-modal, aria-label)
 *
 * Usage:
 * ```tsx
 * <Modal
 *   theme={theme}
 *   title="Confirm Action"
 *   priority={MODAL_PRIORITIES.CONFIRM}
 *   onClose={handleClose}
 *   footer={
 *     <>
 *       <button onClick={handleClose}>Cancel</button>
 *       <button onClick={handleConfirm}>Confirm</button>
 *     </>
 *   }
 * >
 *   <p>Are you sure you want to proceed?</p>
 * </Modal>
 * ```
 */

import React, { useRef, useEffect, useCallback, ReactNode } from 'react';
import { X } from 'lucide-react';
import { GhostIconButton } from './GhostIconButton';
import type { Theme } from '../../types';
import { useModalLayer, type UseModalLayerOptions } from '../../hooks';
import { useResizableModal, MODAL_MIN_WIDTH } from '../../hooks/ui/useResizableModal';
import { ModalResizeGrip } from './ModalResizeGrip';

export interface ModalProps {
	/** Theme object for styling */
	theme: Theme;
	/** Modal title displayed in the header */
	title: string;
	/** Modal priority from MODAL_PRIORITIES constant */
	priority: number;
	/** Callback when modal should close (via X button, Escape, or backdrop click) */
	onClose: () => void;
	/** Modal content */
	children: ReactNode;
	/** Optional footer content (typically action buttons) */
	footer?: ReactNode;
	/** Optional custom header content (replaces default title + close button) */
	customHeader?: ReactNode;
	/** Optional icon to display before the title */
	headerIcon?: ReactNode;
	/** Modal width in pixels. Defaults to 400 */
	width?: number;
	/**
	 * Scale the width with the Cmd+= font-size setting via --font-scale (14px
	 * baseline → scale 1). `width` is the baseline and the modal grows/shrinks
	 * proportionally with the font, clamped to 95vw. This is on by default: at
	 * the baseline font it's a no-op, and at larger fonts it keeps button rows
	 * and headers from wrapping/clipping inside a fixed-px shell. Pass `false`
	 * only for a modal that must stay a literal pixel width regardless of font.
	 */
	scaleWidthWithFont?: boolean;
	/**
	 * Upper bound on the modal width as a CSS value, used as the clamp ceiling
	 * for the font-scaled width. Defaults to '95vw'. Pass e.g. '50vw' to keep a
	 * wide modal from dominating large displays.
	 */
	maxWidthCss?: string;
	/** Max height as CSS value (e.g., '90vh', '600px'). Defaults to '90vh' */
	maxHeight?: string;
	/** Whether clicking the backdrop closes the modal. Defaults to false */
	closeOnBackdropClick?: boolean;
	/** z-index for the modal. Defaults to 9999 */
	zIndex?: number;
	/** Whether to show the default header. Defaults to true */
	showHeader?: boolean;
	/** Whether to show the close button in header. Defaults to true */
	showCloseButton?: boolean;
	/** Additional options for useModalLayer hook */
	layerOptions?: Omit<UseModalLayerOptions, 'onEscape'>;
	/** Ref to the element that should receive initial focus */
	initialFocusRef?: React.RefObject<HTMLElement>;
	/** Test ID for the modal container */
	testId?: string;
	/** Override className for the content wrapper (default: 'p-6 overflow-y-auto flex-1') */
	contentClassName?: string;
	/** Allow content to overflow the modal container (e.g., for dropdowns). Defaults to false */
	allowOverflow?: boolean;
	/** Ref to the inner modal card (used by callers that need to animate the card itself) */
	cardRef?: React.Ref<HTMLDivElement>;
	/**
	 * Opt this modal into drag-to-resize. The value is the stable key its size
	 * persists under (one entry in uiStore's `modalSizes` map), so it must be
	 * unique per modal and must not change between renders. Omit for a modal
	 * that should stay at its declared size.
	 */
	resizeKey?: string;
	/**
	 * Smallest width the user may drag to, in px. Defaults to MODAL_MIN_WIDTH,
	 * or the declared `width` when that is already narrower. Raise it for a
	 * modal whose content stops making sense below a certain width.
	 */
	minWidth?: number;
	/** Smallest height the user may drag to, in px. Defaults to MODAL_MIN_HEIGHT */
	minHeight?: number;
}

/**
 * Reusable modal wrapper component that encapsulates common modal patterns
 */
export function Modal({
	theme,
	title,
	priority,
	onClose,
	children,
	footer,
	customHeader,
	headerIcon,
	width = 400,
	scaleWidthWithFont = true,
	maxWidthCss = '95vw',
	maxHeight = '90vh',
	closeOnBackdropClick = false,
	zIndex = 9999,
	showHeader = true,
	showCloseButton = true,
	layerOptions,
	initialFocusRef,
	testId,
	contentClassName,
	allowOverflow = false,
	cardRef,
	resizeKey,
	minWidth,
	minHeight,
}: ModalProps) {
	const containerRef = useRef<HTMLDivElement>(null);

	// Register with layer stack for Escape handling and focus management
	useModalLayer(priority, title, onClose, layerOptions);

	const resize = useResizableModal({
		resizeKey,
		// Never let the floor exceed the modal's own declared width - a narrow
		// modal (e.g. a 400px confirm) would otherwise open wider than designed.
		minWidth: minWidth ?? Math.min(width, MODAL_MIN_WIDTH),
		minHeight,
	});

	// Merge the internal resize ref with any caller-supplied cardRef so both see
	// the same node (callers use theirs to animate the card).
	const setCardRef = useCallback(
		(node: HTMLDivElement | null) => {
			(resize.cardRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
			if (typeof cardRef === 'function') cardRef(node);
			else if (cardRef) (cardRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
		},
		[cardRef, resize.cardRef]
	);

	// Auto-focus on mount
	useEffect(() => {
		requestAnimationFrame(() => {
			if (initialFocusRef?.current) {
				initialFocusRef.current.focus();
			} else {
				// Focus the container for keyboard accessibility
				containerRef.current?.focus();
			}
		});
	}, [initialFocusRef]);

	const handleBackdropClick = (e: React.MouseEvent) => {
		// Only close if clicking directly on backdrop, not on modal content.
		// Stop propagation so a parent modal's backdrop handler doesn't also
		// fire — matters when a Modal renders nested inside another modal
		// (e.g. AgentDetailModal inside UsageDashboardModal); without this
		// the outer modal would close too.
		if (closeOnBackdropClick && e.target === e.currentTarget) {
			e.stopPropagation();
			onClose();
		}
	};

	return (
		<div
			ref={containerRef}
			className="fixed inset-0 modal-overlay flex items-center justify-center animate-in fade-in duration-200 outline-none"
			style={{ zIndex }}
			role="dialog"
			aria-modal="true"
			aria-label={title}
			tabIndex={-1}
			onClick={handleBackdropClick}
			onKeyDown={(e) => e.stopPropagation()}
			data-testid={testId}
		>
			<div
				ref={setCardRef}
				className={`border rounded-lg shadow-2xl flex flex-col relative ${allowOverflow ? 'overflow-visible' : 'overflow-hidden'} ${resize.isResizing ? 'select-none' : ''}`}
				style={{
					// A size the user dragged to wins over the declared width, and
					// stays clamped to the viewport so it survives a display change.
					width: resize.size
						? `min(${resize.size.width}px, 95vw)`
						: scaleWidthWithFont
							? `min(calc(${width}px * var(--font-scale, 1)), ${maxWidthCss})`
							: `${width}px`,
					height: resize.size ? `min(${resize.size.height}px, 95vh)` : undefined,
					maxHeight: resize.size ? undefined : maxHeight,
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
				}}
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				{showHeader &&
					(customHeader || (
						<div
							className="p-4 border-b flex items-center justify-between shrink-0"
							style={{ borderColor: theme.colors.border }}
						>
							<div className="flex items-center gap-2">
								{headerIcon}
								<h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
									{title}
								</h2>
							</div>
							{showCloseButton && (
								<GhostIconButton
									onClick={onClose}
									ariaLabel="Close modal"
									color={theme.colors.textDim}
								>
									<X className="w-4 h-4" />
								</GhostIconButton>
							)}
						</div>
					))}

				{/* Content */}
				<div className={contentClassName ?? 'p-6 overflow-y-auto flex-1'}>{children}</div>

				{/* Footer */}
				{footer && (
					<div
						className="p-4 border-t flex justify-end gap-2 shrink-0"
						style={{ borderColor: theme.colors.border }}
					>
						{footer}
					</div>
				)}

				{resize.enabled && (
					<ModalResizeGrip
						theme={theme}
						onResizeStart={resize.onResizeStart}
						onReset={resize.onResetSize}
						canReset={resize.size !== null}
					/>
				)}
			</div>
		</div>
	);
}

/**
 * ModalFooter - Standard footer button layout helper
 *
 * Usage:
 * ```tsx
 * <Modal footer={
 *   <ModalFooter
 *     theme={theme}
 *     onCancel={handleClose}
 *     onConfirm={handleSubmit}
 *     confirmLabel="Save"
 *     confirmDisabled={!isValid}
 *   />
 * }>
 *   ...
 * </Modal>
 * ```
 */
export interface ModalFooterProps {
	theme: Theme;
	/** Cancel button click handler */
	onCancel: () => void;
	/** Confirm button click handler */
	onConfirm: () => void;
	/** Cancel button label. Defaults to 'Cancel' */
	cancelLabel?: string;
	/** Confirm button label. Defaults to 'Confirm' */
	confirmLabel?: string;
	/** Whether confirm button is disabled */
	confirmDisabled?: boolean;
	/** Whether confirm button uses destructive (error) color. Defaults to false */
	destructive?: boolean;
	/** Whether to show cancel button. Defaults to true */
	showCancel?: boolean;
	/** Additional class name for confirm button */
	confirmClassName?: string;
	/** Ref to attach to confirm button for focus management */
	confirmButtonRef?: React.RefObject<HTMLButtonElement>;
	/** Ref to attach to cancel button for focus management */
	cancelButtonRef?: React.RefObject<HTMLButtonElement>;
}

export function ModalFooter({
	theme,
	onCancel,
	onConfirm,
	cancelLabel = 'Cancel',
	confirmLabel = 'Confirm',
	confirmDisabled = false,
	destructive = false,
	showCancel = true,
	confirmClassName = '',
	confirmButtonRef,
	cancelButtonRef,
}: ModalFooterProps) {
	// Stop Enter key propagation to prevent parent handlers from triggering after modal closes
	const handleKeyDown = (e: React.KeyboardEvent, action: () => void) => {
		if (e.key === 'Enter') {
			e.stopPropagation();
			action();
		}
	};

	return (
		<>
			{showCancel && (
				<button
					ref={cancelButtonRef}
					type="button"
					onClick={onCancel}
					onKeyDown={(e) => handleKeyDown(e, onCancel)}
					className="px-4 py-2 rounded border hover:bg-white/5 transition-colors outline-none focus:ring-2 focus:ring-offset-1"
					style={{
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
					}}
				>
					{cancelLabel}
				</button>
			)}
			<button
				ref={confirmButtonRef}
				type="button"
				onClick={onConfirm}
				onKeyDown={(e) => !confirmDisabled && handleKeyDown(e, onConfirm)}
				disabled={confirmDisabled}
				className={`px-4 py-2 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed outline-none focus:ring-2 focus:ring-offset-1 ${confirmClassName}`}
				style={{
					backgroundColor: destructive ? theme.colors.error : theme.colors.accent,
					color: destructive ? '#ffffff' : theme.colors.accentForeground,
				}}
			>
				{confirmLabel}
			</button>
		</>
	);
}

export default Modal;
