export const isTestEnv = () => typeof window !== 'undefined' && window.__TEST_MODE__ || process.env.NODE_ENV === 'test';
