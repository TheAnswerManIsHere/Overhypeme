import { Suspense, useEffect, useRef } from "react";
import { lazyWithRetry as lazy } from "@/lib/lazy-retry";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Sentry } from "@/lib/sentry";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { trackPageView, trackRouteVisit, getTopRoutes } from "@/lib/analytics";
import { PersonNameProvider, usePersonName } from "@/hooks/use-person-name";
import { WelcomeModal } from "@/components/WelcomeModal";
import { ShareLinkResolver } from "@/hooks/use-identity-gate";
import { clearAllWizardStates } from "@/components/meme-builder/wizard/state/wizardStorage";
import { FactExpansionProvider } from "@/contexts/fact-expansion-context";
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
const AdminRefundsDisputes = lazy(() => import("@/pages/admin/refundsDisputes"));
const AdminModeration = lazy(() => import("@/pages/admin/moderation"));
const AdminEvalDashboard = lazy(() => import("@/pages/admin/evalDashboard"));
const AdminConfig = lazy(() => import("@/pages/admin/config"));
const AdminEngines = lazy(() => import("@/pages/admin/engines"));
const AdminTaxonomyHealth = lazy(() => import("@/pages/admin/taxonomy-health"));
const AdminFeatures = lazy(() => import("@/pages/admin/features"));
const AdminEmailQueue = lazy(() => import("@/pages/admin/emailQueue"));
const AdminQueueHealth = lazy(() => import("@/pages/admin/queueHealth"));
const AdminHelp = lazy(() => import("@/pages/admin/help"));
const ActivityFeed = lazy(() => import("@/pages/ActivityFeed"));
const MemePage = lazy(() => import("@/pages/MemePage"));
const Pricing = lazy(() => import("@/pages/Pricing"));
const Login = lazy(() => import("@/pages/Login"));
const ForgotPassword = lazy(() => import("@/pages/ForgotPassword"));
const ResetPassword = lazy(() => import("@/pages/ResetPassword"));
const VerifyEmail = lazy(() => import("@/pages/VerifyEmail"));
const TopFacts = lazy(() => import("@/pages/TopFacts"));
const Library = lazy(() => import("@/pages/Library"));
const NotFound = lazy(() => import("@/pages/not-found"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function HallOfFameRedirect() {
  const [, setLocation] = useLocation();
  useEffect(() => { setLocation("/top-facts"); }, [setLocation]);
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
 * Keeps PersonNameProvider in sync with the authenticated user's server profile.
 * - On login  (unauthenticated → authenticated): loads name + pronouns from API.
 * - On logout (authenticated → unauthenticated): clears meme-builder drafts; the identity is kept, since this transition also follows a mere session expiry.
 */
function AuthProfileSync() {
  const { isAuthenticated, isLoading, user } = useAuth();
  const { syncFromProfile } = usePersonName();
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

    // Transition: logged in → logged out. This also fires when a session
    // simply expires, which is not a sign-out, so the visitor's identity is
    // kept; the sign-out operation (useSignOut) is what clears it (#723).
    if (prev === true && !isAuthenticated) {
      // Drop every in-flight meme-builder draft so a draft started by the
      // previous viewer can't leak into the next session.
      clearAllWizardStates();
      return;
    }

    // Transition: unauthenticated → authenticated (or first load as authenticated)
    if (isAuthenticated && prev !== true) {
      // Same reasoning as logout — wipe any draft from the prior (guest or
      // other-user) session so the freshly-authenticated viewer always starts
      // the wizard with their own identity from `usePersonName`.
      clearAllWizardStates();
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
    return undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, isLoading]);

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
  pricing:      () => import("@/pages/Pricing"),
  "top-facts": () => import("@/pages/TopFacts"),
};

/** Route keys used when no visit data has been recorded yet. */
const DEFAULT_PREFETCH_ROUTES = ["home", "search", "facts"] as const;

/**
 * Resolves the prefetch route list: this browser's own most-visited routes
 * (accumulated in localStorage by trackRouteVisit), else hardcoded defaults.
 * The list is filtered to valid ROUTE_IMPORT_MAP keys so that non-prefetchable
 * routes (login, onboard, etc.) are never considered. (A server-wide snapshot
 * from the route-visit counters was the first source until launch Phase 4
 * removed them.)
 */
async function resolvePrefetchRoutes(): Promise<string[]> {
  // 1. This browser's top routes.
  const localTop = getTopRoutes(Object.keys(ROUTE_IMPORT_MAP).length)
    .filter((k) => k in ROUTE_IMPORT_MAP)
    .slice(0, 3);
  if (localTop.length >= 3) return localTop;

  // 2. Fallback: hardcoded defaults.
  return [...DEFAULT_PREFETCH_ROUTES];
}

/**
 * Prefetches the most-visited page chunks during browser idle time so that
 * first navigation to those routes has no visible loading delay.
 *
 * The prefetch set is this browser's own most-visited routes, with hardcoded
 * defaults until it has visited enough of them.
 */
function PrefetchCriticalRoutes() {
  useEffect(() => {
    let cancelled = false;

    const run = () => {
      resolvePrefetchRoutes().then((keys) => {
        if (cancelled) return;
        for (const key of keys) {
          ROUTE_IMPORT_MAP[key]?.().catch(() => {});
        }
      }).catch(() => {
        if (cancelled) return;
        for (const key of DEFAULT_PREFETCH_ROUTES) {
          ROUTE_IMPORT_MAP[key]?.().catch(() => {});
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
      <PrefetchCriticalRoutes />
      <AuthProfileSync />
      <ShareLinkResolver />
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
        <Route path="/admin/refunds-disputes" component={AdminRefundsDisputes} />
        <Route path="/admin/moderation" component={AdminModeration} />
        <Route path="/admin/eval" component={AdminEvalDashboard} />
        <Route path="/admin/comments"><AdminModerationRedirect /></Route>
        <Route path="/admin/reviews"><AdminModerationRedirect /></Route>
        <Route path="/admin/config" component={AdminConfig} />
        <Route path="/admin/engines" component={AdminEngines} />
        <Route path="/admin/taxonomy-health" component={AdminTaxonomyHealth} />
        <Route path="/admin/ai"><AdminAIRedirect /></Route>
        <Route path="/admin/features" component={AdminFeatures} />
        <Route path="/admin/email-queue" component={AdminEmailQueue} />
        <Route path="/admin/queue-health" component={AdminQueueHealth} />
        <Route path="/admin/help/:chapter" component={AdminHelp} />
        <Route path="/admin/help" component={AdminHelp} />
        <Route path="/admin" component={AdminDashboard} />
        <Route path="/top-facts" component={TopFacts} />
        <Route path="/library" component={Library} />
        <Route path="/hall-of-fame"><HallOfFameRedirect /></Route>
        <Route path="/activity" component={ActivityFeed} />
        <Route path="/m/:slug" component={MemePage} />
        <Route path="/pricing" component={Pricing} />
        <Route path="/login" component={Login} />
        <Route path="/forgot-password" component={ForgotPassword} />
        <Route path="/reset-password" component={ResetPassword} />
        <Route path="/verify-email" component={VerifyEmail} />
        <Route component={NotFound} />
      </Switch>
      </Suspense>
      <WelcomeModal />
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
              <FactExpansionProvider>
                <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
                  <Router />
                </WouterRouter>
                <Toaster />
              </FactExpansionProvider>
            </PersonNameProvider>
          </TooltipProvider>
        </QueryClientProvider>
      </AuthProvider>
    </Sentry.ErrorBoundary>
  );
}

export default App;
