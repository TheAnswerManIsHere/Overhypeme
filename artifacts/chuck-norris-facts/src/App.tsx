import { useEffect } from "react";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { trackPageView } from "@/lib/analytics";
import { PersonNameProvider } from "@/hooks/use-person-name";

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
import AdminComments from "@/pages/admin/comments";
import AdminAffiliate from "@/pages/admin/affiliate";
import AdminReviews from "@/pages/admin/Reviews";
import ActivityFeed from "@/pages/ActivityFeed";
import MemePage from "@/pages/MemePage";
import Pricing from "@/pages/Pricing";
import Login from "@/pages/Login";
import Hashtags from "@/pages/Hashtags";
import ForgotPassword from "@/pages/ForgotPassword";
import ResetPassword from "@/pages/ResetPassword";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function GAPageTracker() {
  const [location] = useLocation();
  useEffect(() => {
    trackPageView(location);
  }, [location]);
  return null;
}

function Router() {
  return (
    <>
      <GAPageTracker />
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/search" component={Search} />
        <Route path="/facts/:id" component={FactDetail} />
        <Route path="/submit" component={SubmitFact} />
        <Route path="/profile" component={Profile} />
        <Route path="/onboard" component={Onboard} />
        <Route path="/admin/facts" component={AdminFacts} />
        <Route path="/admin/users" component={AdminUsers} />
        <Route path="/admin/billing" component={AdminBilling} />
        <Route path="/admin/comments" component={AdminComments} />
        <Route path="/admin/affiliate" component={AdminAffiliate} />
        <Route path="/admin/reviews" component={AdminReviews} />
        <Route path="/admin" component={AdminDashboard} />
        <Route path="/activity" component={ActivityFeed} />
        <Route path="/meme/:slug" component={MemePage} />
        <Route path="/pricing" component={Pricing} />
        <Route path="/login" component={Login} />
        <Route path="/hashtags" component={Hashtags} />
        <Route path="/forgot-password" component={ForgotPassword} />
        <Route path="/reset-password" component={ResetPassword} />
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
