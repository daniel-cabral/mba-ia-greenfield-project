import { sanitizeFilename } from './filename.util';

describe('sanitizeFilename', () => {
  it.each([
    ['my clip.mp4', 'my clip.mp4'],
    ['a/b\\c"d.mp4', 'a_b_c_d.mp4'],
    ['  spaced   out  .mp4 ', 'spaced out .mp4'],
    ['line\nbreak\t.mp4', 'line_break_.mp4'],
    ['../../etc/passwd', '_.._etc_passwd'],
    ['...', 'video'],
    ['', 'video'],
  ])('should turn %j into %j', (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  it('should cap the length at 255 characters', () => {
    expect(sanitizeFilename('a'.repeat(400))).toHaveLength(255);
  });
});
