/**
 * CANON Standard 6 (No self-modification of evaluation).
 *
 * The action→emotion table feeds Theater Prohibition. It must be immutable at
 * runtime: the former runtime-registration back-door is removed, and the export
 * rejects mutation even when its `ReadonlyMap` type is cast away.
 */

import {
  ACTION_EMOTION_MAPPINGS,
  getActionEmotionMapping,
  type ActionEmotionMapping,
} from './action-emotions';

describe('ACTION_EMOTION_MAPPINGS immutability (CANON Standard 6)', () => {
  it('exposes existing mappings via get()', () => {
    const mapping = getActionEmotionMapping('speak_happily');
    expect(mapping).not.toBeNull();
    expect(mapping?.emotion).toBe('satisfaction');
    expect(mapping?.expressionType).toBe('relief');
  });

  it('returns null for unknown action types', () => {
    expect(getActionEmotionMapping('nonexistent_action')).toBeNull();
  });

  it('rejects set() even when the ReadonlyMap type is cast away', () => {
    const mutable = ACTION_EMOTION_MAPPINGS as unknown as Map<
      string,
      ActionEmotionMapping
    >;
    expect(() =>
      mutable.set('injected_action', {
        emotion: 'curiosity' as ActionEmotionMapping['emotion'],
        expressionType: 'pressure',
        pressureThreshold: 0.2,
        reliefThreshold: 0.3,
      }),
    ).toThrow(/immutable .*Standard 6/i);
    // The injection must not have taken effect.
    expect(getActionEmotionMapping('injected_action')).toBeNull();
  });

  it('rejects delete()', () => {
    const mutable = ACTION_EMOTION_MAPPINGS as unknown as Map<
      string,
      ActionEmotionMapping
    >;
    expect(() => mutable.delete('speak_happily')).toThrow(/immutable/i);
    // The entry must survive the attempted deletion.
    expect(getActionEmotionMapping('speak_happily')).not.toBeNull();
  });

  it('rejects clear()', () => {
    const mutable = ACTION_EMOTION_MAPPINGS as unknown as Map<
      string,
      ActionEmotionMapping
    >;
    expect(() => mutable.clear()).toThrow(/immutable/i);
    expect(ACTION_EMOTION_MAPPINGS.size).toBeGreaterThan(0);
  });

  it('does not export a runtime-registration API', () => {
    // registerActionEmotionMapping was the Standard-6 back-door; it must be gone.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('./action-emotions');
    expect(mod.registerActionEmotionMapping).toBeUndefined();
  });
});
