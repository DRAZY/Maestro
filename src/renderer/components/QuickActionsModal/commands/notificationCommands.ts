import type { QuickAction } from '../types';

interface BuildNotificationCommandsArgs {
	/** Number of toasts currently on screen. */
	visibleToastCount: number;
	clearToasts: () => void;
	setQuickActionOpen: (open: boolean) => void;
}

/**
 * Bulk escape hatch for a stacked-up toast queue.
 *
 * Sticky (dismissible) toasts have no auto-dismiss timer, so a burst of them -
 * or a misbehaving integration firing them in a loop - leaves a wall of cards
 * that can only be cleared one close button at a time. Offered only when there
 * is something to clear so the palette does not carry a dead entry.
 */
export function buildNotificationCommands({
	visibleToastCount,
	clearToasts,
	setQuickActionOpen,
}: BuildNotificationCommandsArgs): QuickAction[] {
	if (visibleToastCount <= 0) return [];

	return [
		{
			id: 'clear-all-notifications',
			label: 'Clear All Notifications',
			subtext: `Dismiss ${visibleToastCount} visible toast${visibleToastCount === 1 ? '' : 's'}`,
			action: () => {
				clearToasts();
				setQuickActionOpen(false);
			},
		},
	];
}
