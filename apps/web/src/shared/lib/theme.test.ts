import { afterEach, describe, expect, it } from 'vitest';
import { applyTheme, readTheme, setTheme } from './theme.ts';

const addMeta = (media: string) => {
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.media = media;
  document.head.append(meta);
  return meta;
};

describe('theme preference', () => {
  afterEach(() => {
    setTheme('system');
    document.head.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.remove());
  });

  it('follows the device until a theme is picked', () => {
    expect(readTheme()).toBe('system');
    applyTheme();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('pins a picked theme on <html>, in storage and in the browser chrome', () => {
    const light = addMeta('(prefers-color-scheme: light)');
    const dark = addMeta('(prefers-color-scheme: dark)');
    setTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(readTheme()).toBe('dark');
    expect([light.content, dark.content]).toEqual(['#000000', '#000000']);

    setTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(window.localStorage.getItem('sipges.theme')).toBeNull();
    expect([light.content, dark.content]).toEqual(['#ffffff', '#000000']);
  });

  it('ignores an unknown stored value', () => {
    window.localStorage.setItem('sipges.theme', 'sepia');
    expect(readTheme()).toBe('system');
  });
});
