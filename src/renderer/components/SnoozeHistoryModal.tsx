/**
 * SnoozeHistoryModal - the log of snoozes that have ended.
 *
 * One chronological list, newest first, across every agent. Each row answers
 * the questions you actually have looking back: what did I park, what did I
 * tell myself about it, when was it due, and when did it come back.
 *
 * Reached from the "View History" link in the Snoozed Tabs modal.
 */

import { useMemo } from 'react';
import { History, StickyNote, RotateCcw, BellRing, X } from 'lucide-react';
import type { Theme, SnoozeHistoryEntry, SnoozeResolution } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal } from './ui';
import { useSnoozeHistoryStore, MAX_SNOOZE_HISTORY } from '../stores/snoozeHistoryStore';
import { formatSnoozeTarget } from '../../shared/snooze';
import { formatRelativeTime } from '../../shared/formatters';

export interface SnoozeHistoryModalProps {
	theme: Theme;
	onClose: () => void;
}

/** Icon and wording per resolution, so the three outcomes read distinctly. */
const RESOLUTION_META: Record<
	SnoozeResolution,
	{ icon: typeof BellRing; label: string; describe: (entry: SnoozeHistoryEntry) => string }
> = {
	woke: {
		icon: BellRing,
		label: 'Came back',
		describe: (entry) => `Came back ${formatRelativeTime(entry.resolvedAt)}`,
	},
	unsnoozed: {
		icon: RotateCcw,
		label: 'Brought back early',
		describe: (entry) => `Brought back early ${formatRelativeTime(entry.resolvedAt)}`,
	},
	dismissed: {
		icon: X,
		label: 'Dismissed',
		describe: (entry) => `Dismissed ${formatRelativeTime(entry.resolvedAt)}`,
	},
};

export function SnoozeHistoryModal({ theme, onClose }: SnoozeHistoryModalProps) {
	const entries = useSnoozeHistoryStore((state) => state.entries);

	// The store keeps entries newest-first, but sort defensively so the view is
	// chronological regardless of how the log was written or hydrated.
	const ordered = useMemo(
		() => [...entries].sort((a, b) => b.resolvedAt - a.resolvedAt),
		[entries]
	);

	return (
		<Modal
			theme={theme}
			title="Snooze History"
			headerIcon={<History className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			priority={MODAL_PRIORITIES.SNOOZE_HISTORY}
			onClose={onClose}
			width={560}
			maxHeight="70vh"
		>
			{/* Click-driven shell; row content opts back into selection below. */}
			<div className="select-none">
				{ordered.length === 0 ? (
					<div
						className="flex flex-col items-center gap-2 py-10 text-center"
						style={{ color: theme.colors.textDim }}
					>
						<History className="w-7 h-7 opacity-40" />
						<div className="text-sm">No snooze history yet</div>
						<div className="text-xs max-w-xs">
							Once a snoozed tab comes back or you dismiss it, it shows up here with the note you
							left yourself.
						</div>
					</div>
				) : (
					<>
						<div className="flex flex-col gap-1.5">
							{ordered.map((entry) => {
								const meta = RESOLUTION_META[entry.resolution];
								const Icon = meta.icon;
								const dismissed = entry.resolution === 'dismissed';

								return (
									<div
										key={entry.id}
										className="rounded px-3 py-2.5"
										style={{
											backgroundColor: theme.colors.bgActivity,
											border: `1px solid ${theme.colors.border}`,
										}}
									>
										<div className="flex items-start gap-2.5">
											<Icon
												className="w-3.5 h-3.5 shrink-0 mt-0.5"
												style={{
													color: dismissed ? theme.colors.textDim : theme.colors.accent,
												}}
											/>

											<div className="flex-1 min-w-0 select-text">
												<div
													className="text-sm truncate"
													style={{
														color: theme.colors.textMain,
														// A dismissed tab was given up on; dim it so the list
														// reads at a glance.
														opacity: dismissed ? 0.65 : 1,
													}}
													title={entry.label}
												>
													{entry.label}
												</div>

												<div
													className="flex flex-wrap items-center gap-1.5 text-xs mt-0.5"
													style={{ color: theme.colors.textDim }}
												>
													{entry.sessionName && (
														<>
															<span className="truncate">{entry.sessionName}</span>
															<span>·</span>
														</>
													)}
													<span className="whitespace-nowrap">{meta.describe(entry)}</span>
												</div>

												<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
													Was due {formatSnoozeTarget(entry.wakeAt)}
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
										</div>
									</div>
								);
							})}
						</div>

						{ordered.length >= MAX_SNOOZE_HISTORY && (
							<div className="text-[11px] text-center mt-3" style={{ color: theme.colors.textDim }}>
								Showing the most recent {MAX_SNOOZE_HISTORY}. Older entries are dropped as new ones
								arrive.
							</div>
						)}
					</>
				)}
			</div>
		</Modal>
	);
}
