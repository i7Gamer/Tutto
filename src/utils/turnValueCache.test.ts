/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { BoundedValueCache, ChainValueCache } from './turnValueCache';

describe('bounded value caches', () => {
  const CAPACITY = 2;

  it('evicts only the oldest entry, including when zero is cached', () => {
    const cache = new BoundedValueCache<string, number>(CAPACITY);
    expect(cache.get('missing')).toBeUndefined();
    expect(cache.set('a', 0)).toBe(0);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(0);
    cache.set('c', 3);
    expect(cache.size).toBe(CAPACITY);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('updating an existing key at capacity does not evict its neighbour', () => {
    const cache = new BoundedValueCache<string, number>(CAPACITY);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 4);
    expect(cache.size).toBe(CAPACITY);
    expect(cache.get('a')).toBe(4);
    expect(cache.get('b')).toBe(2);
  });

  it.each([0, -1, 1.5, Infinity, NaN])('rejects an invalid capacity %s', capacity => {
    expect(() => new BoundedValueCache(capacity)).toThrow(RangeError);
    expect(() => new ChainValueCache(capacity, CAPACITY)).toThrow(RangeError);
    expect(() => new ChainValueCache(CAPACITY, capacity)).toThrow(RangeError);
  });

  it('keeps the current chain hot and evicts the least recently used bucket', () => {
    const cache = new ChainValueCache(CAPACITY, CAPACITY);
    const a = cache.forChain('a');
    a.set('bank-0', 0);
    cache.forChain('b').set('bank-0', 2);
    expect(cache.forChain('a')).toBe(a);
    cache.forChain('c').set('bank-0', 3);
    expect(cache.bucketCount).toBe(CAPACITY);
    expect(cache.forChain('a').get('bank-0')).toBe(0);
    expect(cache.forChain('b').get('bank-0')).toBeUndefined();
    expect(cache.bucketCount).toBe(CAPACITY);
  });

  it('bounds each bucket independently without clearing other entries', () => {
    const cache = new ChainValueCache(CAPACITY, CAPACITY);
    const a = cache.forChain('a');
    a.set('1', 1);
    a.set('2', 2);
    cache.forChain('b').set('1', 10);
    a.set('3', 3);
    expect(a.get('1')).toBeUndefined();
    expect(a.get('2')).toBe(2);
    expect(a.get('3')).toBe(3);
    expect(cache.forChain('b').get('1')).toBe(10);
    expect(cache.size).toBe(3);
    expect(cache.bucketSizes).toEqual([2, 1]);
  });
});
