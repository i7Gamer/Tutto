import { renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useRoomLink } from './useRoomLink';

const visit = (url: string) => window.history.replaceState({}, '', url);

beforeEach(() => {
  visit('/');
});

describe('useRoomLink', () => {
  it('reports the room a join link is asking for', () => {
    visit('/?room=ROOM1');

    const { result } = renderHook(() => useRoomLink());

    expect(result.current).toBe('ROOM1');
  });

  it('reports nothing for an ordinary visit', () => {
    const { result } = renderHook(() => useRoomLink());

    expect(result.current).toBeNull();
  });

  it('ignores a room the server would never accept', () => {
    visit('/?room=');

    const { result } = renderHook(() => useRoomLink());

    expect(result.current).toBeNull();
  });

  it('takes the room back out of the address bar', () => {
    // Otherwise a refresh re-applies the invitation, and the code sits in the
    // address bar (and in the browser history) long after it stopped meaning
    // anything.
    visit('/?room=ROOM1');

    renderHook(() => useRoomLink());

    expect(window.location.search).toBe('');
  });

  it('leaves the rest of the URL alone while doing so', () => {
    visit('/?utm=qr&room=ROOM1#top');

    renderHook(() => useRoomLink());

    expect(window.location.search).toBe('?utm=qr');
    expect(window.location.hash).toBe('#top');
  });

  it('keeps reporting the room after the URL has been cleaned', () => {
    // The strip must not pull the value out from under whatever is still
    // rendering with it.
    visit('/?room=ROOM1');

    const { result, rerender } = renderHook(() => useRoomLink());
    rerender();

    expect(result.current).toBe('ROOM1');
  });
});
