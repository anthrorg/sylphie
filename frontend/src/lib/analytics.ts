// PostHog analytics — mirrors the integration in the portfolio repo
// (src/lib/analytics.ts), adapted for this app's react-router v7 setup.
//
// Behaviour:
//   - No-ops cleanly if VITE_PUBLIC_POSTHOG_PROJECT_TOKEN is unset.
//   - capture_pageview is disabled in the SDK so SPA route changes
//     don't get missed and the landing-page pageview isn't double-fired;
//     useAnalyticsPageviews() handles every navigation explicitly.
//   - person_profiles: 'identified_only' so anonymous traffic doesn't
//     burn profile quota.

import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import type { PostHog } from 'posthog-js'

const POSTHOG_KEY = import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN
const POSTHOG_HOST =
  import.meta.env.VITE_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com'

let posthog: PostHog | null = null
let posthogReady: Promise<void> = Promise.resolve()

export function initAnalytics(): void {
  if (typeof window === 'undefined') return
  if (!POSTHOG_KEY) return

  posthogReady = import('posthog-js').then((mod) => {
    posthog = mod.default
    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      capture_pageview: false,
      capture_pageleave: true,
      autocapture: true,
      person_profiles: 'identified_only',
    })
  })
}

export function useAnalyticsPageviews(): void {
  const location = useLocation()

  useEffect(() => {
    if (!POSTHOG_KEY) return
    const url =
      window.location.origin + location.pathname + (location.search ?? '')
    void posthogReady.then(() => {
      posthog?.capture('$pageview', { $current_url: url })
    })
  }, [location.pathname, location.search])
}
