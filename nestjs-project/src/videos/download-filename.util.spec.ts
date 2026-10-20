import { attachmentDisposition } from './download-filename.util';

describe('attachmentDisposition', () => {
  it.each([
    ['My clip', 'video/mp4', 'My clip.mp4'],
    ['My clip.mp4', 'video/mp4', 'My clip.mp4'],
    ['Holiday', 'video/quicktime', 'Holiday.mov'],
    ['Show', 'video/x-matroska', 'Show.mkv'],
    ['Odd', 'video/mp4; codecs=avc1', 'Odd.mp4'],
  ])('should name %j (%s) as %j', (title, mime, expected) => {
    expect(attachmentDisposition(title, mime)).toContain(
      `filename="${expected}"`,
    );
  });

  it('should strip slashes and quotes from unsafe titles', () => {
    const header = attachmentDisposition('a/b\\"c"', 'video/mp4');
    const quoted = header.match(/filename="([^"]*)"/)![1];

    expect(quoted).toBe('a_b__c_.mp4');
    expect(header.startsWith('attachment;')).toBe(true);
  });

  it('should keep an ASCII fallback and a UTF-8 name for accented titles', () => {
    const header = attachmentDisposition('Férias', 'video/mp4');

    expect(header).toContain('filename="F_rias.mp4"');
    expect(header).toContain("filename*=UTF-8''F%C3%A9rias.mp4");
  });
});
