/**
 * WS1/C1 follow-up — unit spec for recallKeyForQuestion.
 *
 * recallKeyForQuestion is the pure key-derivation helper at the head of the
 * grounded-recall path: it maps a recall question to the OKG fact KEY it targets
 * (name / location / dog / favorite_color / occupation) or returns null when the
 * question maps to no taught dimension. A null return is the C2 safety hinge — it
 * sends unknowables down the honest WKG/LLM_ASSISTED ladder instead of letting a
 * collision (e.g. "what TOWN did I grow up in" → location) falsely read GROUNDED.
 *
 * This spec covers (a) the positive key derivations and (b) the C2-collision
 * exclusions the helper explicitly guards against: middle/last name vs first
 * name, childhood/grew-up town vs current location, and other "favorite X" vs
 * favorite_color. It exercises the helper directly with no Neo4j/LLM/frame.
 */

import { recallKeyForQuestion } from './deliberation.service';

// Suppress verbose logging in the imported module.
jest.mock('@sylphie/shared', () => {
  const actual = jest.requireActual('@sylphie/shared');
  return { ...actual, verboseFor: () => () => {} };
});

describe('recallKeyForQuestion — positive key derivations', () => {
  it.each([
    ['what is my name?', 'name'],
    ['what am I called?', 'name'],
    ['where do I live?', 'location'],
    ['what city am I in?', 'location'],
    ['what is my location?', 'location'],
    ['what is my dog named?', 'dog'],
    ["what's my pet called?", 'dog'],
    ['what is my favorite color?', 'favorite_color'],
    ['what is my favourite colour?', 'favorite_color'],
    ['what do I do for work?', 'occupation'],
    ['what is my job?', 'occupation'],
    ['what is my occupation?', 'occupation'],
    ['what is my profession?', 'occupation'],
  ])('%j → %j', (question, expectedKey) => {
    expect(recallKeyForQuestion(question)).toBe(expectedKey);
  });

  it('is case-insensitive', () => {
    expect(recallKeyForQuestion('WHAT IS MY NAME?')).toBe('name');
    expect(recallKeyForQuestion('Where Do I Live?')).toBe('location');
  });
});

describe('recallKeyForQuestion — non-recall questions → null', () => {
  it.each([
    'tell me a story about dragons',
    'how does photosynthesis happen?',
    'what time is it?',
    '',
  ])('%j → null', (question) => {
    expect(recallKeyForQuestion(question)).toBeNull();
  });
});

describe('recallKeyForQuestion — C2 collision exclusions', () => {
  // The taught fact is the FIRST name. Middle/last/surname/maiden are unknowable
  // variants and must NOT resolve to the 'name' key (which would falsely ground
  // the first name as the answer to a different question).
  describe('name: excludes middle/last/surname/maiden', () => {
    it.each([
      'what is my middle name?',
      'what is my last name?',
      'what is my surname?',
      'what is my maiden name?',
    ])('%j → not "name"', (question) => {
      expect(recallKeyForQuestion(question)).not.toBe('name');
    });

    it('middle-name question does not falsely resolve to any taught key', () => {
      // It contains "name" but the middle-name exclusion fires; nothing else
      // matches, so it falls through to null (honest unknowable).
      expect(recallKeyForQuestion('what is my middle name?')).toBeNull();
    });
  });

  // The taught fact is the CURRENT city. "grow up / grew up / born / childhood /
  // raised" target a different (childhood) place and must NOT resolve to location.
  describe('location: excludes childhood/birth place', () => {
    it.each([
      'what town did I grow up in?',
      'where did I grow up?',
      'where was I born?',
      'what was my childhood city?',
      'where was I raised?',
    ])('%j → not "location"', (question) => {
      expect(recallKeyForQuestion(question)).not.toBe('location');
    });

    it('"where did I grow up" falls through to null (no current-location collision)', () => {
      expect(recallKeyForQuestion('where did I grow up?')).toBeNull();
    });
  });

  // favorite_color is the only taught "favorite". Other favorite-X categories
  // (food/drink/movie/book/song/music/sport/meal/dish) must NOT resolve to it.
  describe('favorite_color: excludes other favorite-X categories', () => {
    it.each([
      'what is my favorite food?',
      'what is my favourite drink?',
      'what is my favorite movie?',
      'what is my favorite book?',
      'what is my favorite song?',
      'what is my favorite music?',
      'what is my favorite sport?',
      'what is my favorite meal?',
      'what is my favorite dish?',
    ])('%j → not "favorite_color"', (question) => {
      expect(recallKeyForQuestion(question)).not.toBe('favorite_color');
    });

    it('"favorite food" falls through to null (no color collision)', () => {
      expect(recallKeyForQuestion('what is my favorite food?')).toBeNull();
    });

    it('still resolves a genuine color question that also mentions "favorite"', () => {
      expect(recallKeyForQuestion('what is my favorite color?')).toBe('favorite_color');
    });
  });
});
