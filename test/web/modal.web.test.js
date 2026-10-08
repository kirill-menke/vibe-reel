/* web/src/lib/modal.svelte.js: the keys that make the desktop shell inert
 * (App.svelte reads MODAL.holds). */
import { describe, it, expect, beforeEach } from 'vitest';
import { MODAL, holdInert, releaseInert } from '../../web/src/lib/modal.svelte.js';

beforeEach(() => MODAL.holds.splice(0));

describe('inert holds', () => {
  it('holds each key once and releases it', () => {
    holdInert('ctx');
    holdInert('ctx');
    holdInert('confirm');
    expect(MODAL.holds).toEqual(['ctx', 'confirm']);
    releaseInert('ctx');
    expect(MODAL.holds).toEqual(['confirm']);
  });

  it('ignores a release of a key nobody holds', () => {
    holdInert('login');
    releaseInert('ctx');
    expect(MODAL.holds).toEqual(['login']);
  });
});
