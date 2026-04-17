import { lazy, Suspense, useEffect, useRef } from "react";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Sentry } from "@/lib/sentry";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { trackPageView, trackRouteVisit, getTopRoutes, flushRouteStatsToServer } from "@/lib/analytics";
import { PersonNameProvider, SHARE_LINK_ACTIVE, usePersonName } from "@/hooks/use-person-name";
import { useAuth, AuthProvider } from "@workspace/replit-auth-web";
import SentryFallback from "@/components/SentryFallback";

// Pages — lazy-loaded so each route is its own JS chunk
const Home = lazy(() => import("@/pages/Home"));
const Search = lazy(() => import("@/pages/Search"));
const FactDetail = lazy(() => import("@/pages/FactDetail"));
const SubmitFact = lazy(() => import("@/pages/SubmitFact"));
const Profile = lazy(() => import("@/pages/Profile"));
const Onboard = lazy(() => import("@/pages/Onboard"));
const AdminDashboard = lazy(() => import("@/pages/admin/index"));
const AdminFacts = lazy(() => import("@/pages/admin/facts"));
const AdminUsers = lazy(() => import("@/pages/admin/users"));
const AdminBilling = lazy(() => import("@/pages/admin/billing"));
const AdminAffiliate = lazy(() => import("@/pages/admin/affiliate"));
const AdminModeration = lazy(() => import("@/pages/admin/moderation"));
const AdminVideoStyles = lazy(() => import("@/pages/admin/videoStyles"));
const AdminConfig = lazy(() => import("@/pages/admin/config"));
const AdminFeatures = lazy(() => import("@/pages/admin/features"));
const ActivityFeed = lazy(() => import("@/pages/ActivityFeed"));
const MemePage = lazy(() => import("@/pages/MemePage"));
const VideoPage = lazy(() => import("@/pages/VideoPage"));
const Pricing = lazy(() => import("@/pages/Pricing"));
const Login = lazy(() => import("@/pages/Login"));
const ForgotPassword = lazy(() => import("@/pages/ForgotPassword"));
const ResetPassword = lazy(() => import("@/pages/ResetPassword"));
const VerifyEmail = lazy(() => import("@/pages/VerifyEmail"));
const NotFound = lazy(() => import("@/pages/not-found"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function HashtagsRedirect() {
  const [, setLocation] = useLocation();
  useEffect(() => { setLocation("/"); }, [setLocation]);
  return null;
}

function AdminAIRedirect() {
  const [, setLocation] = useLocation();
  useEffect(() => { setLocation("/admin/config"); }, [setLocation]);
  return null;
}

function AdminModerationRedirect() {
  const [, setLocation] = useLocation();
  useEffect(() => { setLocation("/admin/moderation"); }, [setLocation]);
  return null;
}

/**
 * Strips ?displayName=...&pronouns=... from the address bar after they have
 * been consumed by PersonNameProvider's initial-state logic (which runs at
 * module load time, before any React rendering).
 */
function ShareParamReader() {
  useEffect(() => {
    if (!SHARE_LINK_ACTIVE) return;
    const params = new URLSearchParams(window.location.search);
    params.delete("displayName");
    params.delete("pronouns");
    const remaining = params.toString();
    const clean = remaining
      ? `${window.location.pathname}?${remaining}`
      : window.location.pathname;
    window.history.replaceState({}, "", clean);
  }, []);

  return null;
}

/**
 * Keeps PersonNameProvider in sync with the authenticated user's server profile.
 * - On login  (unauthenticated → authenticated): loads name + pronouns from API.
 * - On logout (authenticated → unauthenticated): resets to defaults and clears storage.
 */
function AuthProfileSync() {
  const { isAuthenticated, isLoading, user } = useAuth();
  const { reset, syncFromProfile } = usePersonName();
  const prevAuthRef = useRef<boolean | null>(null);

  // Keep Sentry's user scope in sync with the auth state.
  // ID is used for error events; name + email are also set so the feedback
  // widget pre-populates its fields for logged-in users.
  useEffect(() => {
    if (isLoading) return;
    if (isAuthenticated && user?.id) {
      const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || undefined;
      Sentry.setUser({
        id: user.id,
        email: user.email ?? undefined,
        name,
      });
    } else {
      Sentry.setUser(null);
    }
  }, [isAuthenticated, isLoading, user?.id, user?.email, user?.firstName, user?.lastName]);

  useEffect(() => {
    if (isLoading) return;

    const prev = prevAuthRef.current;
    prevAuthRef.current = isAuthenticated;

    // Transition: logged in → logged out
    if (prev === true && !isAuthenticated) {
      reset();
      return;
    }

    // Transition: unauthenticated → authenticated (or first load as authenticated)
    if (isAuthenticated && prev !== true) {
      let cancelled = false;
      fetch("/api/users/me", { credentials: "include" })
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (cancelled) return;
          if (data?.displayName) {
            syncFromProfile(data.displayName, data.pronouns ?? "");
            // Update Sentry user scope with the resolved display name so the
            // feedback widget pre-populates the name field. Format:
            // "First Last (DisplayName)" e.g. "David Franklin (Hyperion)"
            if (user?.id) {
              const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ");
              const sentryName = fullName
                ? `${fullName} (${data.displayName})`
                : data.displayName;
              Sentry.setUser({
                id: user.id,
                email: user.email ?? undefined,
                name: sentryName,
              });
            }
          }
        })
        .catch(() => {});
      return () => { cancelled = true; };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, isLoading]);

  return null;
}

/**
 * When a share link is opened by a logged-in user, silently log them out
 * so they experience the page as the recipient (unauthenticated visitor).
 * Uses a ref guard so logout is only triggered once per page load.
 */
function ShareLinkAutoLogout() {
  const { isAuthenticated, isLoading, logout } = useAuth();
  const firedRef = useRef(false);

  useEffect(() => {
    if (!SHARE_LINK_ACTIVE) return;
    if (isLoading) return;
    if (!isAuthenticated) return;
    if (firedRef.current) return;
    firedRef.current = true;
    logout();
  }, [isAuthenticated, isLoading, logout]);

  return null;
}

/**
 * Maps stable route keys (produced by normalizePathToRouteKey) to their
 * lazy-import functions.  Only prefetchable pages are listed here;
 * admin routes and auth flows are intentionally omitted.
 */
const ROUTE_IMPORT_MAP: Record<string, () => Promise<unknown>> = {
  home:     () => import("@/pages/Home"),
  search:   () => import("@/pages/Search"),
  facts:    () => import("@/pages/FactDetail"),
  submit:   () => import("@/pages/SubmitFact"),
  profile:  () => import("@/pages/Profile"),
  activity: () => import("@/pages/ActivityFeed"),
  meme:     () => import("@/pages/MemePage"),
  video:    () => import("@/pages/VideoPage"),
  pricing:  () => import("@/pages/Pricing"),
};

/** Route keys used when no visit data has been recorded yet. */
const DEFAULT_PREFETCH_ROUTES = ["home", "search", "facts"] as const;

const ROUTE_STATS_SESSION_KEY = "omh:prefetch-routes";

/**
 * Resolves the prefetch route list using the following priority chain:
 *   1. Server snapshot (GET /api/route-stats) — cached in sessionStorage so
 *      it is only fetched once per browser session.
 *   2. localStorage top routes (accumulated by trackRouteVisit).
 *   3. Hardcoded defaults.
 * The resolved list is always filtered to valid ROUTE_IMPORT_MAP keys so that
 * non-prefetchable routes (login, onboard, etc.) are never considered.
 */
async function resolvePrefetchRoutes(): Promise<string[]> {
  // 1. Check sessionStorage for a cached server snapshot.
  try {
    const cached = sessionStorage.getItem(ROUTE_STATS_SESSION_KEY);
    if (cached) {
      const parsed = JSON.parse(cached) as string[];
      const valid = parsed.filter((k) => k in ROUTE_IMPORT_MAP).slice(0, 3);
      if (valid.length >= 3) return valid;
    }
  } catch {
    // sessionStorage unavailable — fall through
  }

  // 2. Fetch a fresh server snapshot.
  try {
    const base: string = import.meta.env.BASE_URL ?? "/";
    const url = `${base}api/route-stats?n=3`;
    const res = await fetch(url, { credentials: "same-origin" });
    if (res.ok) {
      const data = (await res.json()) as { routes: string[] };
      const valid = (data.routes ?? [])
        .filter((k) => k in ROUTE_IMPORT_MAP)
        .slice(0, 3);
      // Cache the result for this session regardless of how many items we got.
      try {
        sessionStorage.setItem(ROUTE_STATS_SESSION_KEY, JSON.stringify(valid));
      } catch {
        // ignore
      }
      if (valid.length >= 3) return valid;
    }
  } catch {
    // Network or parse error — fall through to localStorage
  }

  // 3. Fall back to localStorage top routes.
  const localTop = getTopRoutes(Object.keys(ROUTE_IMPORT_MAP).length)
    .filter((k) => k in ROUTE_IMPORT_MAP)
    .slice(0, 3);
  if (localTop.length >= 3) return localTop;

  // 4. Final fallback: hardcoded defaults.
  return [...DEFAULT_PREFETCH_ROUTES];
}

/**
 * Prefetches the most-visited page chunks during browser idle time so that
 * first navigation to those routes has no visible loading delay.
 *
 * The prefetch set is resolved via a server-driven snapshot (refreshed once
 * per session with stale-while-revalidate semantics via sessionStorage), with
 * localStorage visit counts and hardcoded defaults as successive fallbacks.
 * This ensures all users benefit from accurate, traffic-pattern-driven
 * prefetching regardless of their personal visit history.
 */
function PrefetchCriticalRoutes() {
  useEffect(() => {
    let cancelled = false;

    const run = () => {
      resolvePrefetchRoutes().then((keys) => {
        if (cancelled) return;
        for (const key of keys) {
          ROUTE_IMPORT_MAP[key]?.();
        }
      }).catch(() => {
        if (cancelled) return;
        for (const key of DEFAULT_PREFETCH_ROUTES) {
          ROUTE_IMPORT_MAP[key]?.();
        }
      });
    };

    if ("requestIdleCallback" in window) {
      const id = requestIdleCallback(run, { timeout: 3000 });
      return () => { cancelled = true; cancelIdleCallback(id); };
    } else {
      const id = setTimeout(run, 200);
      return () => { cancelled = true; clearTimeout(id); };
    }
  }, []);

  return null;
}

function GAPageTracker() {
  const [location] = useLocation();
  useEffect(() => {
    trackPageView(location);
    trackRouteVisit(location);
  }, [location]);
  return null;
}

/**
 * Flushes localStorage route visit counts to the server once per session
 * during browser idle time so the admin dashboard gets aggregate data.
 */
function RouteStatsFlush() {
  useEffect(() => {
    const flush = () => { flushRouteStatsToServer(); };
    if ("requestIdleCallback" in window) {
      const id = requestIdleCallback(flush, { timeout: 5000 });
      return () => cancelIdleCallback(id);
    } else {
      const id = setTimeout(flush, 1000);
      return () => clearTimeout(id);
    }
  }, []);
  return null;
}

function ScrollToTop() {
  const [location] = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [location]);
  return null;
}

function Router() {
  return (
    <>
      <ScrollToTop />
      <GAPageTracker />
      <RouteStatsFlush />
      <PrefetchCriticalRoutes />
      <AuthProfileSync />
      <ShareParamReader />
      <ShareLinkAutoLogout />
      <Suspense fallback={<div className="min-h-screen" aria-busy="true" />}>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/search" component={Search} />
        <Route path="/facts/:id/:sub?" component={FactDetail} />
        <Route path="/submit" component={SubmitFact} />
        <Route path="/profile" component={Profile} />
        <Route path="/onboard" component={Onboard} />
        <Route path="/admin/facts" component={AdminFacts} />
        <Route path="/admin/users" component={AdminUsers} />
        <Route path="/admin/billing" component={AdminBilling} />
        <Route path="/admin/moderation" component={AdminModeration} />
        <Route path="/admin/comments"><AdminModerationRedirect /></Route>
        <Route path="/admin/reviews"><AdminModerationRedirect /></Route>
        <Route path="/admin/affiliate" component={AdminAffiliate} />
        <Route path="/admin/video-styles" component={AdminVideoStyles} />
        <Route path="/admin/config" component={AdminConfig} />
        <Route path="/admin/ai"><AdminAIRedirect /></Route>
        <Route path="/admin/features" component={AdminFeatures} />
        <Route path="/admin" component={AdminDashboard} />
        <Route path="/activity" component={ActivityFeed} />
        <Route path="/meme/:slug" component={MemePage} />
        <Route path="/video/:id" component={VideoPage} />
        <Route path="/pricing" component={Pricing} />
        <Route path="/login" component={Login} />
        <Route path="/hashtags"><HashtagsRedirect /></Route>
        <Route path="/forgot-password" component={ForgotPassword} />
        <Route path="/reset-password" component={ResetPassword} />
        <Route path="/verify-email" component={VerifyEmail} />
        <Route component={NotFound} />
      </Switch>
      </Suspense>
    </>
  );
}

function App() {
  return (
    <Sentry.ErrorBoundary fallback={({ resetError }) => <SentryFallback resetError={resetError} />}>
      <AuthProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <PersonNameProvider>
              <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
                <Router />
              </WouterRouter>
              <Toaster />
            </PersonNameProvider>
          </TooltipProvider>
        </QueryClientProvider>
      </AuthProvider>
    </Sentry.ErrorBoundary>
  );
}

export default App;
