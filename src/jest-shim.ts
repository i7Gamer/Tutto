import { vi } from 'vitest';
(globalThis as unknown as { jest: typeof vi }).jest = vi;
