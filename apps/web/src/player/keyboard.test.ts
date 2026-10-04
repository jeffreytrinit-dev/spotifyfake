import { describe, expect, it } from 'vitest';
import { isTypingTarget, shortcutFor } from './keyboard.js';

const k = (
  key: string,
  mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {},
) => ({
  key,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});

describe('shortcutFor', () => {
  it('maps the documented keys', () => {
    expect(shortcutFor(k(' '))).toBe('togglePlay');
    expect(shortcutFor(k('ArrowLeft'))).toBe('seekBack');
    expect(shortcutFor(k('ArrowRight', { shiftKey: true }))).toBe('next');
    expect(shortcutFor(k('ArrowLeft', { shiftKey: true }))).toBe('previous');
    expect(shortcutFor(k('ArrowUp'))).toBe('volumeUp');
    expect(shortcutFor(k('R'))).toBe('repeat');
    expect(shortcutFor(k('?'))).toBe('help');
  });

  it('ignores combinations used by the browser and unknown keys', () => {
    expect(shortcutFor(k('r', { ctrlKey: true }))).toBeNull();
    expect(shortcutFor(k('ArrowLeft', { metaKey: true }))).toBeNull();
    expect(shortcutFor(k('x'))).toBeNull();
  });
});

describe('isTypingTarget', () => {
  it('treats text inputs as typing but not checkboxes or buttons', () => {
    const text = document.createElement('input');
    const box = document.createElement('input');
    box.type = 'checkbox';
    const range = document.createElement('input');
    range.type = 'range';
    expect(isTypingTarget(text)).toBe(true);
    expect(isTypingTarget(box)).toBe(false);
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
    expect(isTypingTarget(range)).toBe(true);
  });

  it('leaves arrow keys to drag handles and menus', () => {
    const handle = document.createElement('button');
    handle.setAttribute('aria-roledescription', 'sortable');
    const menu = document.createElement('ul');
    menu.setAttribute('role', 'menu');
    const item = document.createElement('button');
    menu.append(item);
    expect(isTypingTarget(handle)).toBe(true);
    expect(isTypingTarget(item)).toBe(true);
  });
});
