import { useEffect, useRef } from "react";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { trackPageView } from "@/lib/analytics";
import { PersonNameProvider, SHARE_LINK_ACTIVE, usePersonName } from "@/hooks/use-person-name";
import { useAuth } from "@workspace/replit-auth-web";

// Pages
import Home from "@/pages/Home";
import Search from "@/pages/Search";
import FactDetail from "@/pages/FactDetail";
import SubmitFact from "@/pages/SubmitFact";
import Profile from "@/pages/Profile";
import Onboard from "@/pages/Onboard";
import AdminDashboard from "@/pages/admin/index";
import AdminFacts from "@/pages/admin/facts";
import AdminUsers from "@/pages/admin/users";
import AdminBilling from "@/pages/admin/billing";
import AdminAffiliate from "@/pages/admin/affiliate";
import AdminModeration from "@/pages/admin/moderation";
import AdminVideoStyles from "@/pages/admin/videoStyles";
import AdminConfig from "@/pages/admin/config";
import AdminFeatures from "@/pages/admin/features";
import ActivityFeed from "@/pages/ActivityFeed";
import MemePage from "@/pages/MemePage";
import VideoPage from "@/pages/VideoPage";
import Pricing from "@/pages/Pricing";
import Login from "@/pages/Login";
import ForgotPassword from "@/pages/ForgotPassword";
import ResetPassword from "@/pages/ResetPassword";
import VerifyEmail from "@/pages/VerifyEmail";
import NotFound from "@/pages/not-found";

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
  const { isAuthenticated, isLoading } = useAuth();
  const { reset, syncFromProfile } = usePersonName();
  const prevAuthRef = useRef<boolean | null>(null);

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
      fetch("/api/users/me", { credentials: "include" })
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (data?.displayName) {
            syncFromProfile(data.displayName, data.pronouns ?? "");
          }
        })
        .catch(() => {});
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

function GAPageTracker() {
  const [location] = useLocation();
  useEffect(() => {
    trackPageView(location);
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
      <AuthProfileSync />
      <ShareParamReader />
      <ShareLinkAutoLogout />
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
    </>
  );
}

function App() {
  return (
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
  );
}

export default App;
