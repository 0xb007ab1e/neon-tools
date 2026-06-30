import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom doesn't implement Blob object URLs; stub them so any CSP-safe download helper
// (URL.createObjectURL/revokeObjectURL) can run under test (mirrors the portal suite).
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = vi.fn(() => 'blob:mock');
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = vi.fn();
}

afterEach(() => cleanup());
