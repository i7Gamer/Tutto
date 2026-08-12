import { describe, it, expect, vi } from 'vitest';
import { JOIN_ERROR_KEYS, joinErrorMessage } from './joinErrors';

describe('joinErrors', () => {
  // Stands in for i18next's t(key, defaultValue): returns the key so a test can
  // see WHICH key was asked for, which is the whole point of the mapping.
  const translate = (key: string): string => `t:${key}`;

  describe('joinErrorMessage', () => {
    it('translates a refusal the server named a code for', () => {
      expect(joinErrorMessage({ code: 'name_taken', error: 'Username already exists in this room' }, translate))
        .toBe('t:lobby.online.joinError.nameTaken');
    });

    it('passes the server prose as the default value, so a missing key still says something', () => {
      // A locale that has not caught up with a new code renders the server's
      // own sentence rather than the raw key.
      const passthrough = vi.fn((_key: string, defaultValue: string) => defaultValue);
      expect(joinErrorMessage({ code: 'room_full', error: 'This room is full' }, passthrough))
        .toBe('This room is full');
      expect(passthrough).toHaveBeenCalledWith('lobby.online.joinError.roomFull', 'This room is full');
    });

    it('falls back to the raw prose for a code this client does not know', () => {
      // An older client against a newer server: the refusal is still shown,
      // just untranslated, rather than swallowed.
      expect(joinErrorMessage({ code: 'code_from_a_newer_server', error: 'Refused for a new reason' }, translate))
        .toBe('Refused for a new reason');
    });

    it('leaves an already-translated message alone when there is no code', () => {
      // The reconnect watchdog resolves its own result with a translated
      // sentence and no code — mapping must not clobber it.
      expect(joinErrorMessage({ error: 'Keine Antwort vom Server.' }, translate))
        .toBe('Keine Antwort vom Server.');
    });

    it('reports nothing to show when the refusal carries neither code nor prose', () => {
      // Lets each caller supply its own fallback instead of inventing one here.
      expect(joinErrorMessage({}, translate)).toBeUndefined();
      expect(joinErrorMessage({ error: '' }, translate)).toBeUndefined();
      expect(joinErrorMessage(null, translate)).toBeUndefined();
      expect(joinErrorMessage(undefined, translate)).toBeUndefined();
    });

    it('translates every code in the table', () => {
      // Guards the map's own integrity: an entry whose value was mistyped or
      // left empty would silently degrade to the untranslated prose.
      for (const [code, key] of JOIN_ERROR_KEYS) {
        expect(joinErrorMessage({ code, error: 'prose' }, translate)).toBe(`t:${key}`);
        expect(key).toMatch(/^lobby\.online\.joinError\./);
      }
    });
  });
});
