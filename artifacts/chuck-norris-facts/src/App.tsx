import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

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
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
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
      <Route path="/admin" component={AdminDashboard} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
