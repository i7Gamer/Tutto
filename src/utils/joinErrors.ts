// The i18n key for each join refusal the server can name, kept out of
// OnlineLobby the way scannerMessages.ts is kept out of RoomQrScanner: a
// component module may only export components
// (react-refresh/only-export-components), and this table now has three readers
// — the lobby's error box, the restore-session popup and the auto-reconnect
// handler — plus the drift test in src/locales/translations.test.ts.
//
// Keys mirror the server's JOIN_REFUSAL_CODES (server/socketRoomHandlers.ts),
// which that test pins: a fifteenth refusal added there without an entry here
// falls back to the server's English prose instead of failing quietly.
export const JOIN_ERROR_KEYS = new Map<string, string>([
  ['rate_limited', 'lobby.online.joinError.rateLimited'],
  ['invalid_payload', 'lobby.online.joinError.invalidPayload'],
  ['invalid_room', 'lobby.online.joinError.invalidRoom'],
  ['invalid_device', 'lobby.online.joinError.invalidDevice'],
  ['invalid_name', 'lobby.online.joinError.invalidName'],
  ['disconnected', 'lobby.online.joinError.disconnected'],
  ['device_in_other_room', 'lobby.online.joinError.deviceInOtherRoom'],
  ['already_seated', 'lobby.online.joinError.alreadySeated'],
  ['server_full', 'lobby.online.joinError.serverFull'],
  ['name_taken', 'lobby.online.joinError.nameTaken'],
  ['game_running', 'lobby.online.joinError.gameRunning'],
  ['room_full', 'lobby.online.joinError.roomFull'],
  ['too_many_rooms', 'lobby.online.joinError.tooManyRooms'],
  ['room-gone', 'lobby.online.joinError.roomGone'],
]);

/** The parts of a refused joinRoom ack this module needs. */
export interface JoinRefusalResult {
  error?: string;
  // Which refusal `error` is describing. Absent on a success, on a locally
  // produced result (the reconnect watchdog's own timeout), and from any server
  // older than the codes.
  code?: string;
}

/**
 * What to put on screen for a refused join, translated when the server named a
 * code for it.
 *
 * Returns `undefined` rather than inventing a message when the refusal carries
 * nothing to show: the three callers want different fallbacks (the lobby leaves
 * its error box alone, the two reconnect paths say "failed to reconnect"), so
 * the choice stays with them.
 *
 * `translate` takes the prose as its default value, so an unknown code, or a
 * locale that has not caught up with a new one, still renders the server's own
 * sentence instead of a bare key. A result with prose but no code is passed
 * through untouched — that is how the watchdog's already-translated timeout
 * message survives this.
 */
export const joinErrorMessage = (
  res: JoinRefusalResult | null | undefined,
  translate: (key: string, defaultValue: string) => string,
): string | undefined => {
  const key = res?.code ? JOIN_ERROR_KEYS.get(res.code) : undefined;
  if (key) return translate(key, res?.error ?? '');
  return res?.error || undefined;
};
