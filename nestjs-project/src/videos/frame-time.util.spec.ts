import { frameTime } from './frame-time.util';

describe('frameTime', () => {
  it.each([
    [100, 10],
    [5, 1],
    [10, 1],
    [1.5, 0.75],
    [0.5, 0.25],
    [0, 0],
  ])('should place the frame of a %p s video at %p s', (duration, expected) => {
    expect(frameTime(duration)).toBeCloseTo(expected);
  });

  it('should always stay within the duration', () => {
    for (const duration of [0.2, 0.9, 1, 2, 30, 3600]) {
      expect(frameTime(duration)).toBeLessThanOrEqual(duration);
    }
  });
});
