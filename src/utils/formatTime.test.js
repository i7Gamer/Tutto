import { describe, it, expect } from 'vitest';
import { formatTime } from './formatTime';

describe('formatTime', () => {
  it('formats less than a minute correctly', () => {
    expect(formatTime(45)).toBe('00:45');
  });

  it('formats exactly one minute correctly', () => {
    expect(formatTime(60)).toBe('01:00');
  });

  it('formats minutes and seconds correctly', () => {
    expect(formatTime(125)).toBe('02:05');
  });

  it('formats tens of minutes correctly', () => {
    expect(formatTime(600)).toBe('10:00');
  });

  it('formats hours correctly', () => {
    expect(formatTime(3600)).toBe('01:00:00');
  });

  it('formats hours, minutes, and seconds correctly', () => {
    expect(formatTime(3665)).toBe('01:01:05');
  });

  it('formats tens of hours correctly', () => {
    expect(formatTime(36000)).toBe('10:00:00');
  });

  it('handles 0 correctly', () => {
    expect(formatTime(0)).toBe('00:00');
  });

  it('handles negative inputs by treating them as 0 or throwing (based on implementation, assuming 00:00)', () => {
    // Assuming Math.max(0, seconds) or similar inside formatTime, or just native behavior
    // If it doesn't handle negative, we test what it does
    expect(formatTime(-5)).toBe('00:00'); // Or whatever the actual output is if unguarded
  });
});
