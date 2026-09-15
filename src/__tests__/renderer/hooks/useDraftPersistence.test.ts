/**
 * Tests for useDraftPersistence - the debounced, key-switch-safe write-back
 * primitive shared by AI Chat's useInputSync and Group Chat's GroupChatInput.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDraftPersistence } from '../../../renderer/hooks/input/useDraftPersistence';

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('useDraftPersistence - queueFlush', () => {
	it('writes the queued value back after the delay, without any explicit flush', () => {
		const onPersist = vi.fn();
		const { result } = renderHook(() => useDraftPersistence<string>(onPersist, 300));

		result.current.queueFlush('key-1', 'never blurred');
		expect(onPersist).not.toHaveBeenCalled();

		vi.advanceTimersByTime(300);

		expect(onPersist).toHaveBeenCalledExactlyOnceWith('key-1', 'never blurred');
	});

	it('coalesces a burst of calls for the same key into one write', () => {
		const onPersist = vi.fn();
		const { result } = renderHook(() => useDraftPersistence<string>(onPersist, 300));

		for (const text of ['n', 'ne', 'nev', 'neve', 'never']) {
			result.current.queueFlush('key-1', text);
		}
		vi.advanceTimersByTime(300);

		expect(onPersist).toHaveBeenCalledTimes(1);
		expect(onPersist).toHaveBeenCalledWith('key-1', 'never');
	});

	it('flushes the previous key immediately when a different key is queued', () => {
		// The guarantee this exists for: switching drafting targets mid-debounce
		// (a tab, a chat) must not drop what was typed for the one being left.
		const onPersist = vi.fn();
		const { result } = renderHook(() => useDraftPersistence<string>(onPersist, 300));

		result.current.queueFlush('key-1', 'first key text');
		result.current.queueFlush('key-2', 'second key text');

		// The first key's write already landed, synchronously, on the switch.
		expect(onPersist).toHaveBeenCalledExactlyOnceWith('key-1', 'first key text');

		vi.advanceTimersByTime(300);

		expect(onPersist).toHaveBeenCalledTimes(2);
		expect(onPersist).toHaveBeenNthCalledWith(2, 'key-2', 'second key text');
	});
});

describe('useDraftPersistence - flushNow', () => {
	it('persists immediately and cancels any pending queued write for that key', () => {
		const onPersist = vi.fn();
		const { result } = renderHook(() => useDraftPersistence<string>(onPersist, 300));

		result.current.queueFlush('key-1', 'about to be sent');
		result.current.flushNow('key-1', '');
		vi.advanceTimersByTime(300);

		// Only the explicit, immediate write happened - the stale queued value
		// never lands after it.
		expect(onPersist).toHaveBeenCalledExactlyOnceWith('key-1', '');
	});
});

describe('useDraftPersistence - flushPending / cancelPending', () => {
	it('flushPending applies whatever is queued right now', () => {
		const onPersist = vi.fn();
		const { result } = renderHook(() => useDraftPersistence<string>(onPersist, 300));

		result.current.queueFlush('key-1', 'mid sentence');
		result.current.flushPending();

		expect(onPersist).toHaveBeenCalledExactlyOnceWith('key-1', 'mid sentence');

		// The timer that would have fired the same write again must be gone too.
		vi.advanceTimersByTime(300);
		expect(onPersist).toHaveBeenCalledTimes(1);
	});

	it('flushPending is a no-op when nothing is queued', () => {
		const onPersist = vi.fn();
		const { result } = renderHook(() => useDraftPersistence<string>(onPersist, 300));

		result.current.flushPending();

		expect(onPersist).not.toHaveBeenCalled();
	});

	it('cancelPending discards the queued write without persisting it', () => {
		const onPersist = vi.fn();
		const { result } = renderHook(() => useDraftPersistence<string>(onPersist, 300));

		result.current.queueFlush('key-1', 'never mind');
		result.current.cancelPending();
		vi.advanceTimersByTime(300);

		expect(onPersist).not.toHaveBeenCalled();
	});
});

describe('useDraftPersistence - unmount', () => {
	it('flushes a pending draft on unmount rather than dropping it', () => {
		const onPersist = vi.fn();
		const { result, unmount } = renderHook(() => useDraftPersistence<string>(onPersist, 300));

		result.current.queueFlush('key-1', 'unsaved at unmount');
		unmount();

		expect(onPersist).toHaveBeenCalledExactlyOnceWith('key-1', 'unsaved at unmount');
	});
});
