/**
 * @purpose The one full-page navigation seam: components that must leave the single-page app (a sign-in with Google or Apple, a page that must start signed out, checkout) go through `pageNavigation.go`, and tests stub it instead of fighting jsdom's non-configurable `window.location.assign`.
 * @subsystem public-site
 */
export const pageNavigation = {
  go(url: string) {
    window.location.assign(url);
  },
};
