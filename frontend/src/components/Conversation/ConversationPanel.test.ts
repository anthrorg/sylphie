import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// AC (TK-143): given a submitted word rating, when it is sent, then a
// backend gateway handler receives it — OR, if removal chosen, the drawer
// affordance is gone.
//
// This build chose REMOVAL: `phrase_word_rating` was sent as a raw
// `{type: ...}` frame (not the NestJS `{event,data}` envelope every other
// message uses) and no backend handler ever existed for it — every
// guardian rating was silently dropped. Rather than fabricate a "fix" for
// an end-to-end pipeline this build cannot fully verify (what a rating
// should DO to the WKG phrase node was never specified), the dead
// affordance is removed so the UI stops implying the rating does anything.
// Flagged for ashby/architect follow-up per the ticket's fix-or-remove note.

describe('ConversationPanel — word-rating affordance removed (TK-143, removal branch)', () => {
  it('no longer imports or renders WordRatingDrawer', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, 'ConversationPanel.tsx'),
      'utf-8',
    )
    expect(source).not.toContain('WordRatingDrawer')
    expect(source).not.toContain('phrase_word_rating')
  })

  it('the WordRatingDrawer component file itself is gone', () => {
    const drawerPath = path.resolve(__dirname, 'WordRatingDrawer.tsx')
    expect(fs.existsSync(drawerPath)).toBe(false)
  })
})
