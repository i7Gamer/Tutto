const assertCapacity = (capacity: number): void => {
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('Cache capacity must be a positive integer');
};

/** FIFO eviction removes one old value, never the whole working set. */
export class BoundedValueCache<K, V> {
  private readonly values = new Map<K, V>();

  constructor(private readonly capacity: number) {
    assertCapacity(capacity);
  }

  get size(): number { return this.values.size; }

  get(key: K): V | undefined { return this.values.get(key); }

  set(key: K, value: V): V {
    if (!this.values.has(key) && this.values.size >= this.capacity) {
      const oldest = this.values.keys().next();
      if (!oldest.done) this.values.delete(oldest.value);
    }
    this.values.set(key, value);
    return value;
  }
}

/** Retain a few complete deck/standings contexts; old contexts leave together. */
export class ChainValueCache {
  private readonly buckets = new Map<string, BoundedValueCache<string, number>>();

  constructor(private readonly capacity: number, private readonly bucketCapacity: number) {
    assertCapacity(capacity);
    assertCapacity(bucketCapacity);
  }

  get bucketCount(): number { return this.buckets.size; }
  get bucketSizes(): number[] { return [...this.buckets.values()].map(bucket => bucket.size); }
  get size(): number { return this.bucketSizes.reduce((sum, size) => sum + size, 0); }

  forChain(key: string): BoundedValueCache<string, number> {
    let bucket = this.buckets.get(key);
    if (bucket) {
      // Map insertion order tracks context use, independently of inner FIFO order.
      this.buckets.delete(key);
    } else {
      if (this.buckets.size >= this.capacity) {
        const oldest = this.buckets.keys().next();
        if (!oldest.done) this.buckets.delete(oldest.value);
      }
      bucket = new BoundedValueCache(this.bucketCapacity);
    }
    this.buckets.set(key, bucket);
    return bucket;
  }
}
