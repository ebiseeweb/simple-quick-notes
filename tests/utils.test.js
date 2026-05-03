import { describe, it, expect, vi, beforeEach } from 'vitest';
const Utils = require('../utils.js');

describe('Quick Notes Utilities', () => {
  describe('deriveTitle', () => {
    it('should derive title from the first line', () => {
      expect(Utils.deriveTitle('Hello World\nSecond line')).toBe('Hello World');
    });

    it('should truncate long first lines', () => {
      const long = 'a'.repeat(100);
      expect(Utils.deriveTitle(long)).toBe('a'.repeat(40));
    });

    it('should return Untitled for empty content', () => {
      expect(Utils.deriveTitle('')).toBe('Untitled');
      expect(Utils.deriveTitle('\n\n')).toBe('Untitled');
    });
  });

  describe('matchPattern', () => {
    it('should match exact URLs', () => {
      expect(Utils.matchPattern('https://google.com', 'https://google.com')).toBe(true);
    });

    it('should match with wildcards', () => {
      expect(Utils.matchPattern('https://google.com/search', 'https://google.com/*')).toBe(true);
      expect(Utils.matchPattern('https://mail.google.com', 'https://*.google.com')).toBe(true);
    });

    it('should handle invalid regex patterns gracefully', () => {
      expect(Utils.matchPattern('https://test.com', '[')).toBe(false);
    });
  });

  describe('pickDefaultNoteId', () => {
    const notes = [{ id: 'note1' }, { id: 'note2' }];
    const siteDefaults = {
      'https://google.com/*': 'note1',
      'https://github.com/*': 'note2'
    };

    it('should return correct noteId for matching URL', () => {
      expect(Utils.pickDefaultNoteId('https://google.com/search', siteDefaults, notes)).toBe('note1');
    });

    it('should return null if no pattern matches', () => {
      expect(Utils.pickDefaultNoteId('https://bing.com', siteDefaults, notes)).toBe(null);
    });

    it('should return null if noteId does not exist', () => {
      expect(Utils.pickDefaultNoteId('https://google.com/', { 'https://google.com/': 'missing' }, notes)).toBe(null);
    });
  });

  describe('fmtTime', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('should return "just now" for recent timestamps', () => {
      const now = Date.now();
      expect(Utils.fmtTime(now - 10000)).toBe('just now');
    });

    it('should return minutes ago', () => {
      const now = Date.now();
      expect(Utils.fmtTime(now - 120000)).toBe('2m ago');
    });

    it('should return hours ago', () => {
      const now = Date.now();
      expect(Utils.fmtTime(now - 7200000)).toBe('2h ago');
    });
  });
});
