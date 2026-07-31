/**
 * SnoozedTabsModal - every snoozed tab, across every agent, soonest first.
 *
 * Each row offers the three things you'd want from a reminder list:
 *  - Unsnooze: bring the tab back right now
 *  - Reschedule: pick a new time (reopens SnoozeTabModal pre-filled)
 *  - Dismiss: drop the snooze and the tab, because you no longer care
 *
 * Reached from the Search popover and the command palette.
 */

import { useState, useMemo, useCallback } from 'react';
import { Clock, RotateCcw, CalendarClock, X, StickyNote } from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal } from './ui';
import { SnoozeTabModal } from './SnoozeTabModal';
import { useSessionStore } from '../stores/sessionStore';
import { useTabStore } from '../stores/tabStore';
import { notifyToast } from '../stores/notificationStore';
import { collectSnoozedTabs, getSnoozedTabLabel } from '../utils/snoozeHelpers';
import { formatSnoozeTarget, formatSnoozeCountdown } from '../../shared/snooze';

export interface SnoozedTabsModalProps {
	theme: Theme;
	onClose: () => void;
	/** Focus an agent + tab after unsnoozing, so the restored tab is shown. */
	onJumpToTab?: (sessionId: string, tabId: string) => void;
}

export function SnoozedTabsModal({ theme, onClose, onJumpToTab }: SnoozedTabsModalProps) {
	const sessions = useSessionStore((state) => state.sessions);
	const unsnoozeTab = useTabStore((state) => state.unsnoozeTab);
	const dismissSnoozedTab = useTabStore((state) => state.dismissSnoozedTab);
	const rescheduleSnoozedTab = useTabStore((state) => state.rescheduleSnoozedTab);

	// Snooze currently being rescheduled, if any.
	const [editing, setEditing] = useState<{ sessionId: string; snoozeId: string } | null>(null);

	const items = useMemo(() => collectSnoozedTabs(sessions), [sessions]);

	const editingItem = useMemo(
		() =>
			editing
				? (items.find(
						(item) => item.sessionId === editing.sessionId && item.entry.id === editing.snoozeId
					) ?? null)
				: null,
		[editing, items]
	);

	const handleUnsnooze = useCallback(
		(sessionId: string, snoozeId: string) => {
			const result = unsnoozeTab(sessionId, snoozeId);
			if (!result) return;
			onJumpToTab?.(sessionId, result.tabId);
			onClose();
		},
		[unsnoozeTab, onJumpToTab, onClose]
	);

	const handleDismiss = useCallback(
		(sessionId: string, snoozeId: string, label: string) => {
			dismissSnoozedTab(sessionId, snoozeId);
			notifyToast({
				color: 'theme',
				title: 'Snooze dismissed',
				message: `"${label}" won't come back.`,
			});
		},
		[dismissSnoozedTab]
	);

	const handleReschedule = useCallback(
		(wakeAt: number, note: string) => {
			if (!editing) return;
			rescheduleSnoozedTab(editing.sessionId, editing.snoozeId, wakeAt, note);
			setEditing(null);
		},
		[editing, rescheduleSnoozedTab]
	);

	return (
		<>
			<Modal
				theme={theme}
				title="Snoozed Tabs"
				headerIcon={<Clock className="w-4 h-4" style={{ color: theme.colors.accent }} />}
				priority={MODAL_PRIORITIES.SNOOZED_TABS}
				onClose={onClose}
				width={560}
			>
				{/* Click-driven list: suppress drag-select, opt content back in per row. */}
				<div className="select-none">
					{items.length === 0 ? (
						<div
							className="flex flex-col items-center gap-2 py-10 text-center"
							style={{ color: theme.colors.textDim }}
						>
							<Clock className="w-7 h-7 opacity-40" />
							<div className="text-sm">No snoozed tabs</div>
							<div className="text-xs max-w-xs">
								Snooze a tab from its hover menu to hide it until later. It comes back with a
								notification you have to dismiss.
							</div>
						</div>
					) : (
						<div className="flex flex-col gap-1.5">
							{items.map(({ entry, sessionId, sessionName }) => {
								const label = getSnoozedTabLabel(entry);
								const overdue = entry.wakeAt <= Date.now();

								return (
									<div
										key={entry.id}
										className="rounded px-3 py-2.5"
										style={{
											backgroundColor: theme.colors.bgActivity,
											border: `1px solid ${theme.colors.border}`,
										}}
									>
										<div className="flex items-start gap-3">
											<div className="flex-1 min-w-0 select-text">
												<div
													className="text-sm truncate"
													style={{ color: theme.colors.textMain }}
													title={label}
												>
													{label}
												</div>

												<div
													className="flex items-center gap-1.5 text-xs mt-0.5"
													style={{ color: theme.colors.textDim }}
												>
													<span className="truncate">{sessionName}</span>
													<span>·</span>
													<span
														className="whitespace-nowrap"
														style={{ color: overdue ? theme.colors.warning : undefined }}
													>
														{formatSnoozeTarget(entry.wakeAt)} (
														{formatSnoozeCountdown(entry.wakeAt)})
													</span>
												</div>

												{entry.note && (
													<div
														className="flex items-start gap-1.5 text-xs mt-1.5"
														style={{ color: theme.colors.textDim }}
													>
														<StickyNote className="w-3 h-3 shrink-0 mt-0.5" />
														<span className="italic">{entry.note}</span>
													</div>
												)}
											</div>

											{/* Row actions */}
											<div className="flex items-center gap-1 shrink-0">
												<button
													type="button"
													onClick={() => handleUnsnooze(sessionId, entry.id)}
													title="Unsnooze now"
													className="p-1.5 rounded hover:bg-white/10 transition-colors"
													style={{ color: theme.colors.textDim }}
												>
													<RotateCcw className="w-3.5 h-3.5" />
												</button>
												<button
													type="button"
													onClick={() => setEditing({ sessionId, snoozeId: entry.id })}
													title="Change snooze time"
													className="p-1.5 rounded hover:bg-white/10 transition-colors"
													style={{ color: theme.colors.textDim }}
												>
													<CalendarClock className="w-3.5 h-3.5" />
												</button>
												<button
													type="button"
													onClick={() => handleDismiss(sessionId, entry.id, label)}
													title="Dismiss - discard this tab entirely"
													className="p-1.5 rounded hover:bg-white/10 transition-colors"
													style={{ color: theme.colors.textDim }}
												>
													<X className="w-3.5 h-3.5" />
												</button>
											</div>
										</div>
									</div>
								);
							})}
						</div>
					)}
				</div>
			</Modal>

			{editingItem && (
				<SnoozeTabModal
					theme={theme}
					tabLabel={getSnoozedTabLabel(editingItem.entry)}
					initialWakeAt={editingItem.entry.wakeAt}
					initialNote={editingItem.entry.note}
					onClose={() => setEditing(null)}
					onConfirm={handleReschedule}
				/>
			)}
		</>
	);
}
