/**
 * The storage every browser test starts from: the visitor has already
 * dismissed the analytics notice (launch Phase 14, increment 2), so that
 * fixed card never sits over a control a test clicks. A test about the notice
 * itself starts from empty storage with
 * `test.use({ storageState: { cookies: [], origins: [] } })`.
 *
 * The key and value are AnalyticsNotice.tsx's (`ANALYTICS_NOTICE_KEY`, set to
 * "seen" by "Got it"). They are copied rather than imported so the Playwright
 * config does not load a React component; publicScreens.spec.ts proves they
 * still match by dismissing the notice and reading the stored value.
 */
export const ANALYTICS_NOTICE_STORAGE = { name: "overhype.analyticsNotice.v2", value: "seen" } as const;

export function dismissedNoticesState(baseURL: string) {
  return {
    cookies: [],
    origins: [{ origin: new URL(baseURL).origin, localStorage: [{ ...ANALYTICS_NOTICE_STORAGE }] }],
  };
}
