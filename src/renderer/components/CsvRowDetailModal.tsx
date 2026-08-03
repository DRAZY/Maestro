/**
 * CsvRowDetailModal - vertical ("record") view of a single CSV/TSV row.
 *
 * The table renderer lays a row out horizontally, which hides long or
 * multi-line cells behind an ellipsis. Double-clicking a row opens this modal,
 * which flips the same data into a two-column field/value table: one field per
 * line, values wrapped and rendered with their newlines intact.
 *
 * Includes a field/value filter and prev/next navigation through the rows
 * currently displayed by the table (i.e. after its own sort and search).
 */

import { useMemo, useRef, useState } from 'react';
import { ChevronUp, ChevronDown, Copy, Search, X } from 'lucide-react';
import type { Theme } from '../types';
import { Modal } from './ui/Modal';
import { GhostIconButton } from './ui/GhostIconButton';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { highlightMatches } from '../utils/highlightMatches';
import { safeClipboardWrite } from '../utils/clipboard';
import { flashCopiedToClipboard } from '../utils/flashCopiedToClipboard';

interface CsvRowDetailModalProps {
	/** Header cells from the first CSV row, used as field names */
	headers: string[];
	/** Cells of the row being inspected */
	row: string[];
	/** Total column count across the file (rows may be short) */
	columnCount: number;
	/** 0-based position of this row within the displayed rows */
	index: number;
	/** How many rows the table is currently displaying */
	total: number;
	/** Move to another displayed row (already clamped by the caller) */
	onNavigate: (nextIndex: number) => void;
	onClose: () => void;
	theme: Theme;
}

export function CsvRowDetailModal({
	headers,
	row,
	columnCount,
	index,
	total,
	onNavigate,
	onClose,
	theme,
}: CsvRowDetailModalProps) {
	const [filter, setFilter] = useState('');
	const searchRef = useRef<HTMLInputElement>(null);
	const query = filter.trim().slice(0, 200);

	const fields = useMemo(
		() =>
			Array.from({ length: columnCount }, (_, i) => ({
				key: headers[i]?.trim() || `Column ${i + 1}`,
				value: row[i] ?? '',
			})),
		[headers, row, columnCount]
	);

	const visibleFields = useMemo(() => {
		if (!query) return fields;
		const lower = query.toLowerCase();
		return fields.filter(
			(f) => f.key.toLowerCase().includes(lower) || f.value.toLowerCase().includes(lower)
		);
	}, [fields, query]);

	const canPrev = index > 0;
	const canNext = index < total - 1;

	const copyValue = async (value: string) => {
		if (await safeClipboardWrite(value)) flashCopiedToClipboard(value);
	};

	const customHeader = (
		<div
			className="p-4 border-b flex items-center justify-between gap-3 shrink-0"
			style={{ borderColor: theme.colors.border }}
		>
			<h2 className="text-sm font-bold truncate" style={{ color: theme.colors.textMain }}>
				Row {index + 1}
				<span style={{ color: theme.colors.textDim }}> of {total.toLocaleString()}</span>
			</h2>
			<div className="flex items-center gap-1 shrink-0">
				<GhostIconButton
					onClick={() => canPrev && onNavigate(index - 1)}
					disabled={!canPrev}
					title="Previous row (Up arrow)"
					ariaLabel="Previous row"
					color={theme.colors.textDim}
				>
					<ChevronUp className="w-4 h-4" />
				</GhostIconButton>
				<GhostIconButton
					onClick={() => canNext && onNavigate(index + 1)}
					disabled={!canNext}
					title="Next row (Down arrow)"
					ariaLabel="Next row"
					color={theme.colors.textDim}
				>
					<ChevronDown className="w-4 h-4" />
				</GhostIconButton>
				<GhostIconButton onClick={onClose} ariaLabel="Close modal" color={theme.colors.textDim}>
					<X className="w-4 h-4" />
				</GhostIconButton>
			</div>
		</div>
	);

	// Arrow keys step through rows, but only when the caret isn't in the filter
	// input (where Up/Down move within the text) and no modifier is held.
	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.target === searchRef.current) return;
		if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
		if (e.key === 'ArrowUp' && canPrev) {
			e.preventDefault();
			onNavigate(index - 1);
		} else if (e.key === 'ArrowDown' && canNext) {
			e.preventDefault();
			onNavigate(index + 1);
		}
	};

	return (
		<Modal
			theme={theme}
			title={`Row ${index + 1} of ${total}`}
			priority={MODAL_PRIORITIES.CSV_ROW_DETAIL}
			onClose={onClose}
			customHeader={customHeader}
			closeOnBackdropClick
			// The table renders inside the Main Panel, whose `isolate` wrapper is a
			// stacking context - without the portal the backdrop dims only the
			// center and the Left/Right panels stay lit on top of it.
			portal
			resizeKey="csv-row-detail"
			defaultSize={{ width: 900, height: 640 }}
			minSize={{ width: 380, height: 260 }}
			initialFocusRef={searchRef}
			contentClassName="flex flex-col flex-1 min-h-0"
			testId="csv-row-detail-modal"
		>
			<div className="flex flex-col flex-1 min-h-0" onKeyDown={handleKeyDown}>
				{/* Filter */}
				<div
					className="px-4 py-3 border-b shrink-0 flex items-center gap-2"
					style={{ borderColor: theme.colors.border }}
				>
					<Search className="w-4 h-4 shrink-0" style={{ color: theme.colors.textDim }} />
					<input
						ref={searchRef}
						type="text"
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						placeholder="Filter fields and values..."
						className="flex-1 bg-transparent outline-none text-sm min-w-0"
						style={{ color: theme.colors.textMain }}
						data-testid="csv-row-detail-search"
					/>
					{query && (
						<span className="text-xs shrink-0" style={{ color: theme.colors.textDim }}>
							{visibleFields.length} of {fields.length}
						</span>
					)}
					{filter && (
						<GhostIconButton
							onClick={() => setFilter('')}
							ariaLabel="Clear filter"
							color={theme.colors.textDim}
						>
							<X className="w-3 h-3" />
						</GhostIconButton>
					)}
				</div>

				{/* Field / value pairs */}
				<div className="flex-1 min-h-0 overflow-y-auto select-text">
					{visibleFields.length === 0 ? (
						<div className="p-6 text-sm text-center" style={{ color: theme.colors.textDim }}>
							No fields match "{query}"
						</div>
					) : (
						<table className="w-full" style={{ borderCollapse: 'collapse', fontSize: '13px' }}>
							<tbody>
								{visibleFields.map((field, i) => (
									<tr
										key={`${field.key}-${i}`}
										className="group"
										style={{
											backgroundColor: i % 2 === 0 ? 'transparent' : theme.colors.bgActivity + '60',
										}}
									>
										<td
											style={{
												padding: '8px 12px',
												verticalAlign: 'top',
												width: '30%',
												minWidth: '120px',
												borderRight: `1px solid ${theme.colors.border}`,
												borderBottom: `1px solid ${theme.colors.border}40`,
												color: theme.colors.textDim,
												fontWeight: 600,
												wordBreak: 'break-word',
											}}
										>
											{highlightMatches(field.key, query, theme.colors.accent)}
										</td>
										<td
											style={{
												padding: '8px 12px',
												verticalAlign: 'top',
												borderBottom: `1px solid ${theme.colors.border}40`,
												color: field.value ? theme.colors.textMain : theme.colors.textDim,
												fontFamily:
													'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
												whiteSpace: 'pre-wrap',
												overflowWrap: 'anywhere',
											}}
										>
											<div className="flex items-start gap-2">
												<div className="flex-1 min-w-0">
													{field.value ? (
														highlightMatches(field.value, query, theme.colors.accent)
													) : (
														<span style={{ opacity: 0.5 }}>empty</span>
													)}
												</div>
												{field.value && (
													<GhostIconButton
														onClick={() => copyValue(field.value)}
														title="Copy value"
														ariaLabel={`Copy ${field.key}`}
														color={theme.colors.textDim}
														className="opacity-0 group-hover:opacity-100 shrink-0"
													>
														<Copy className="w-3 h-3" />
													</GhostIconButton>
												)}
											</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>
			</div>
		</Modal>
	);
}
