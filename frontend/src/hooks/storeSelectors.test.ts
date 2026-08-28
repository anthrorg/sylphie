import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// AC (TK-148): given a panel subscribed to the Zustand store, when an
// unrelated store write occurs, then the panel does not re-render.
//
// The reported offenders were the media-driven hooks that re-render at
// camera/mic frame rates (15fps / 2Hz): calling the store hook with NO
// selector argument subscribes to EVERY field, so the hook's identity (and
// therefore its owning component) re-renders on every unrelated store write
// (e.g. a telemetry tick), not just the fields it actually reads.
// Field-scoped selectors (passing a `(s) => s.field` accessor) avoid that.

const HOOKS_DIR = path.resolve(__dirname)
const OFFENDERS = [
  'usePerception.ts',
  'useWebRTC.ts',
  'useVoiceRecording.ts',
  'useAudioStream.ts',
]

// A bare store-hook call with no selector argument (the no-argument,
// whole-store subscription pattern this ticket removes) — built from parts
// so this file's own prose above doesn't accidentally match its own check.
const noSelectorCallPattern = new RegExp('useAppStore' + '\\(\\)')

describe('media-driven hooks use field-scoped store selectors, not whole-store subscriptions (TK-148)', () => {
  for (const file of OFFENDERS) {
    it(`${file} does not call the store hook with no selector argument`, () => {
      const source = fs.readFileSync(path.join(HOOKS_DIR, file), 'utf-8')
      expect(source).not.toMatch(noSelectorCallPattern)
    })
  }
})
