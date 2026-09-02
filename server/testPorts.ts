/**
 * Central registry of the TCP ports the server test suites bind.
 *
 * Several server suites spawn the real server as a child process, and vitest
 * runs test files in parallel, so two suites holding the same port will collide
 * at runtime. That failure is unhelpfully indirect — it surfaces as an
 * EADDRINUSE line buried in the child's stderr plus a 20 second beforeAll hook
 * timeout, on whichever suite happened to lose the race, not on the one that
 * introduced the duplicate.
 *
 * Allocating every port here instead makes the constraint visible in one place
 * and turns a duplicate into an immediate, named error at import time (see the
 * check below) rather than an intermittent timeout.
 *
 * Adding a suite: append an entry with a name matching its describe block. Do
 * not reuse a value, and do not inline a bare port number in a test file.
 *
 * Two checkouts of the repo (a second worktree, a CI matrix on one runner)
 * running these suites at the same time would collide on the same numbers;
 * TEST_PORT_OFFSET shifts the whole registry so each checkout gets its own
 * range. Unset or empty means no shift.
 */
const BASE_PORTS = {
  // Socket integration suites (see socketTestHarness.ts).
  socketsRoom: '3005',
  socketsConfig: '3014',
  socketsAuthorization: '3015',
  socketsPresence: '3016',
  socketsStats: '3017',
  socketsResilience: '3020',

  // HTTP API suites.
  apiTokenProtection: '3006',
  apiCorsOrigin: '3007',
  apiGlobalStatsRateLimit: '3012',
  apiClientErrorRateLimit: '3013',
  apiProductionCors: '3018',

  // Focused socket behaviour suites.
  socketConfigBounds: '3008',
  socketSecurityTimers: '3009',
  // 3010 was turnTimer's, freed when that suite moved in-process (it binds an
  // OS-assigned ephemeral port now and needs no reservation). Left unassigned
  // rather than reused, so an old checkout running alongside a new one does not
  // collide with whichever suite inherited it.
  pushStateValidation: '3011',
  socketTestHarnessEnvIsolation: '3019',
} as const;

const PORT_OFFSET_ENV = 'TEST_PORT_OFFSET';
const rawOffset = process.env[PORT_OFFSET_ENV];
const portOffset = rawOffset === undefined || rawOffset === '' ? 0 : Number(rawOffset);
if (!Number.isInteger(portOffset) || portOffset < 0) {
  throw new Error(`${PORT_OFFSET_ENV} must be a non-negative integer, got ${JSON.stringify(rawOffset)}`);
}

const PORTS = Object.fromEntries(
  Object.entries(BASE_PORTS).map(([suite, port]) => [suite, String(Number(port) + portOffset)]),
) as Record<keyof typeof BASE_PORTS, string>;

// Runs when any suite imports the registry, so a duplicate fails loudly and
// names both offenders instead of racing for the socket.
const owners = new Map<string, string>();
for (const [suite, port] of Object.entries(PORTS)) {
  const existing = owners.get(port);
  if (existing) {
    throw new Error(
      `Duplicate test port ${port} in testPorts.ts: "${existing}" and "${suite}" would bind the same port. Give one of them an unused port.`,
    );
  }
  owners.set(port, suite);
}

export const TEST_PORTS = PORTS;
