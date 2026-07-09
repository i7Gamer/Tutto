import { describe, it, expect } from 'vitest';
import { renderBoldMarkdown } from './renderBoldMarkdown';

describe('renderBoldMarkdown', () => {
  it('converts **bold** markdown into <strong> tags', () => {
    expect(renderBoldMarkdown('This is **bold** text')).toBe('This is <strong>bold</strong> text');
  });

  it('converts multiple bold segments', () => {
    expect(renderBoldMarkdown('**one** and **two**')).toBe('<strong>one</strong> and <strong>two</strong>');
  });

  it('returns plain text unchanged when there is no markdown', () => {
    expect(renderBoldMarkdown('plain text')).toBe('plain text');
  });

  it('escapes raw angle brackets so they cannot inject HTML/script tags', () => {
    expect(renderBoldMarkdown('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes ampersands', () => {
    expect(renderBoldMarkdown('Salt & Pepper')).toBe('Salt &amp; Pepper');
  });

  it('escapes surrounding text while still converting bold markdown', () => {
    expect(renderBoldMarkdown('<b>fake</b> but **real** bold')).toBe('&lt;b&gt;fake&lt;/b&gt; but <strong>real</strong> bold');
  });
});
