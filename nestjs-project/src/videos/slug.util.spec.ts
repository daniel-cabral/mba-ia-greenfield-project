import { generateSlug } from './slug.util';

describe('generateSlug', () => {
  it('should return 11 base64url characters and differ between calls', () => {
    const slugs = Array.from({ length: 200 }, () => generateSlug());

    for (const slug of slugs) {
      expect(slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
    }
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
