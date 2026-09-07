// Vitest 5 reads custom matcher declarations from its own `Matchers<R, T>`
// only — neither the global `jest.Matchers` that `@testing-library/jest-dom`
// augments nor the one-parameter `Assertion<T>` its `/vitest` entry augments
// merges any more (testing-library/jest-dom#738). Until jest-dom ships the
// two-parameter form, this is the augmentation that upstream proposes.
import 'vitest';
import type { ExpectStatic } from 'vitest';
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

type AsymmetricMatcher = ReturnType<ExpectStatic['stringContaining']>;

declare module 'vitest' {
  // Both are augmentation slots: an empty body and an unused `T` are the
  // shape vitest merges on, not an oversight.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars
  interface Matchers<R, T> extends TestingLibraryMatchers<AsymmetricMatcher, R> {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<AsymmetricMatcher, unknown> {}
}
