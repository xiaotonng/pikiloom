import { describe, expect, it } from 'vitest';

import { reserveUploadFileName } from '../src/dashboard/routes/sessions.ts';

describe('dashboard upload filenames', () => {
  it('keeps same-named files distinct within one upload batch', () => {
    const used = new Set<string>();

    expect(reserveUploadFileName('image.png', 'image/png', 0, used)).toBe('image.png');
    expect(reserveUploadFileName('image.png', 'image/png', 1, used)).toBe('image-2.png');
    expect(reserveUploadFileName('image.png', 'image/png', 2, used)).toBe('image-3.png');
  });

  it('dedupes names case-insensitively for case-insensitive filesystems', () => {
    const used = new Set<string>();

    expect(reserveUploadFileName('Image.PNG', 'image/png', 0, used)).toBe('Image.png');
    expect(reserveUploadFileName('image.png', 'image/png', 1, used)).toBe('image-2.png');
  });
});
