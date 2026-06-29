export const isTestEnv = (): boolean =>
  (typeof window !== 'undefined' && !!window.__TEST_MODE__) ||
  import.meta.env.MODE === 'test';
