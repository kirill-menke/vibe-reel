/* phone/src/components/detail/detail.js techBadges(): the TechBadges row on the
 * phone's title pages. The audio badge is tracks.js audioBadge(), so it names
 * the file's codec like the audio menu — "TrueHD Atmos" for a TrueHD Atmos
 * track (user decision 2026-10-04, V-F4), "DD+ Atmos" for E-AC3 Atmos. */
import { describe, it, expect, beforeEach } from 'vitest';
import { techBadges } from '../../phone/src/components/detail/detail.js';
import { SET, DEFAULTS } from '../../src/lib/settings.svelte.js';
import { source, video, tracks, movie, resetIds } from '../helpers/media.js';

beforeEach(() => {
  resetIds();
  Object.assign(SET, DEFAULTS);
});

const v4k = () => video({ Width: 3840, Height: 2160, VideoRange: 'HDR', VideoRangeType: 'HDR10' });

describe('phone techBadges: the audio badge', () => {
  it('a file whose only audio is TrueHD Atmos 7.1 → "TrueHD Atmos", then its channels', () => {
    const m = movie({ MediaSources: [source([v4k(), tracks.truehdAtmos({ IsDefault: true })])] });
    expect(techBadges(m)).toEqual([{ label: '4K', strong: true }, { label: 'HDR10', strong: true }, 'TrueHD Atmos', '7.1']);
  });

  it('a TrueHD default next to DD+ Atmos still badges the DD+ track the player picks', () => {
    const m = movie({ MediaSources: [source([v4k(), tracks.truehdAtmos({ IsDefault: true }), tracks.eac3Atmos()])] });
    expect(techBadges(m)).toContain('DD+ Atmos');
    expect(techBadges(m)).not.toContain('TrueHD Atmos');
  });
});
