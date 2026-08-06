/** @vitest-environment node */
/**
 * Guards the deployment contract of the shipped docker-compose.yml.
 *
 * README's quick start is "copy this file, write API_TOKEN into .env beside it,
 * `docker compose up -d`". Nothing else in the repository exercises that flow —
 * the CI smoke test uses `docker run`, and the compose file is otherwise only
 * ever read by a deployer's compose CLI — so a mistake in it ships silently.
 *
 * It has already happened once. The `${API_TOKEN:?...}` error message ended in
 * "generate one with: openssl rand -hex 32", and a colon followed by a space
 * terminates a YAML plain scalar and promotes it to an implicit key. The
 * sequence item parsed as a single-pair map, and compose refused the file with
 * `services.tutto.environment.[0]: unexpected type map[string]interface {}` —
 * the documented quick start could not start at all.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parse } from 'yaml';

const COMPOSE_PATH = path.join(__dirname, '..', 'docker-compose.yml');

interface ComposeService {
  environment?: unknown;
}

interface ComposeFile {
  services: Record<string, ComposeService>;
}

const readCompose = (): ComposeFile => parse(fs.readFileSync(COMPOSE_PATH, 'utf8')) as ComposeFile;

const services = (): [string, ComposeService][] => Object.entries(readCompose().services);

/** Every `NAME=value` entry across every service, with its service name. */
const environmentEntries = (): { service: string; entry: unknown }[] =>
  services().flatMap(([service, definition]) =>
    (Array.isArray(definition.environment) ? definition.environment : []).map(entry => ({
      service,
      entry,
    }))
  );

describe('docker-compose.yml is a file compose can actually load', () => {
  it('declares at least one service', () => {
    // Sanity check on the helpers: an empty parse would make every assertion
    // below vacuously pass.
    expect(services().length).toBeGreaterThan(0);
  });

  it('gives every service a list of environment strings', () => {
    // compose-spec types the list form of `environment` as `items: {type: string}`.
    // An entry that parses as anything else is rejected outright, so the stack
    // never starts — and a tolerant loader would define a mangled variable name
    // and leave the intended one unset, which is worse.
    const notStrings = services()
      .filter(([, definition]) => definition.environment !== undefined)
      .filter(([, definition]) => !Array.isArray(definition.environment))
      .map(([service]) => `${service}: environment is not a list`)
      .concat(
        environmentEntries()
          .filter(({ entry }) => typeof entry !== 'string')
          .map(({ service, entry }) => `${service}: ${JSON.stringify(entry)}`)
      );

    expect(notStrings).toEqual([]);
  });
});

describe('the compose file cannot deploy a guessable admin token', () => {
  const apiTokenEntries = (): string[] =>
    environmentEntries()
      .map(({ entry }) => entry)
      .filter((entry): entry is string => typeof entry === 'string')
      .filter(entry => entry.startsWith('API_TOKEN='));

  it('supplies API_TOKEN from the environment rather than a literal', () => {
    // A literal committed here would be public, and an unedited copy of this
    // file would then deploy a server whose admin token anyone can read — the
    // case server/startupGuards.ts still has to refuse by value.
    const literals = apiTokenEntries().filter(entry => !entry.includes('${API_TOKEN'));
    expect(literals).toEqual([]);
  });

  it('makes an unset API_TOKEN refuse to start instead of falling back', () => {
    // The ":?" form is what turns a missing token into a compose error. Without
    // it an unset variable expands to empty and the container starts unguarded.
    expect(apiTokenEntries()).not.toEqual([]);
    expect(apiTokenEntries().every(entry => entry.includes('${API_TOKEN:?'))).toBe(true);
  });
});
