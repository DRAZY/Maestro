import { describe, expect, it, vi } from 'vitest';
import { buildNotificationCommands } from '../../../../../renderer/components/QuickActionsModal/commands/notificationCommands';

function harness(visibleToastCount: number) {
	const clearToasts = vi.fn();
	const setQuickActionOpen = vi.fn();
	const actions = buildNotificationCommands({
		visibleToastCount,
		clearToasts,
		setQuickActionOpen,
	});
	return { actions, clearToasts, setQuickActionOpen };
}

describe('buildNotificationCommands', () => {
	it('offers nothing when no toasts are on screen', () => {
		// Keeps the palette free of a dead entry when there is nothing to clear.
		expect(harness(0).actions).toEqual([]);
	});

	it('offers the clear command when toasts are stacked up', () => {
		const { actions } = harness(12);
		expect(actions).toHaveLength(1);
		expect(actions[0].id).toBe('clear-all-notifications');
		expect(actions[0].label).toBe('Clear All Notifications');
	});

	it('reports the pending count in the subtext', () => {
		expect(harness(12).actions[0].subtext).toBe('Dismiss 12 visible toasts');
	});

	it('singularizes the subtext for a lone toast', () => {
		expect(harness(1).actions[0].subtext).toBe('Dismiss 1 visible toast');
	});

	it('clears the queue and closes the palette', () => {
		const { actions, clearToasts, setQuickActionOpen } = harness(3);
		actions[0].action();
		expect(clearToasts).toHaveBeenCalledOnce();
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	it('is findable by searching for "notifications"', () => {
		// The label has to contain the word users would type; this pins it against
		// a rename that would make the command unreachable.
		expect(harness(1).actions[0].label.toLowerCase()).toContain('notification');
	});
});
