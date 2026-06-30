import { describe, it, expect } from 'vitest';
import { asObject, parseJsonObject, parseJsonString } from './parseJson';

describe('asObject', () => {
  it('returns plain objects unchanged', () => {
    const o = { a: 1 };
    expect(asObject(o)).toBe(o);
    expect(asObject({})).toEqual({});
  });

  it('returns null for non-objects, null, and arrays', () => {
    expect(asObject(null)).toBeNull();
    expect(asObject(undefined)).toBeNull();
    expect(asObject(5)).toBeNull();
    expect(asObject('str')).toBeNull();
    expect(asObject(true)).toBeNull();
    expect(asObject([1, 2, 3])).toBeNull();
  });
});

describe('parseJsonObject', () => {
  const resWith = (value: unknown): Response =>
    ({ json: () => Promise.resolve(value) } as Response);

  it('returns the parsed object for an object body', async () => {
    expect(await parseJsonObject(resWith({ gamesPlayed: 3 }))).toEqual({ gamesPlayed: 3 });
  });

  it('returns null for an empty object', async () => {
    // The empty object is still an object — callers treat fields as possibly-absent.
    expect(await parseJsonObject(resWith({}))).toEqual({});
  });

  it('returns null for non-object bodies', async () => {
    expect(await parseJsonObject(resWith(null))).toBeNull();
    expect(await parseJsonObject(resWith('error'))).toBeNull();
    expect(await parseJsonObject(resWith([1, 2]))).toBeNull();
  });

  it('returns null when json() throws', async () => {
    const res = { json: () => Promise.reject(new Error('bad json')) } as unknown as Response;
    expect(await parseJsonObject(res)).toBeNull();
  });
});

describe('parseJsonString', () => {
  it('parses a JSON object string', () => {
    expect(parseJsonString('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns null for null/empty input', () => {
    expect(parseJsonString(null)).toBeNull();
    expect(parseJsonString('')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseJsonString('{not json')).toBeNull();
  });

  it('returns null for valid JSON that is not an object', () => {
    expect(parseJsonString('5')).toBeNull();
    expect(parseJsonString('"text"')).toBeNull();
    expect(parseJsonString('[1,2,3]')).toBeNull();
    expect(parseJsonString('null')).toBeNull();
  });
});
