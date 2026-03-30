import { useState } from "react";
import { useAuth } from "@workspace/replit-auth-web";
import { useGetMyProfile, getGetMyProfileQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/layout/Layout";
import { FactCard } from "@/components/facts/FactCard";
import { Button } from "@/components/ui/Button";
import { ShieldAlert, LogOut, Clock, ThumbsUp, FileText, Hash } from "lucide-react";
import { Link } from "wouter";

export default function Profile() {
  const { isAuthenticated, login, logout } = useAuth();
  const { data: profile, isLoading } = useGetMyProfile({
    query: { queryKey: getGetMyProfileQueryKey(), enabled: isAuthenticated, retry: false }
  });

  const [activeTab, setActiveTab] = useState<"submitted" | "liked" | "history">("liked");

  if (!isAuthenticated) {
    return (
      <Layout>
        <div className="max-w-2xl mx-auto px-4 py-24 text-center">
          <ShieldAlert className="w-20 h-20 text-primary mx-auto mb-6 opacity-80" />
          <h1 className="text-4xl font-display uppercase mb-4 text-foreground">Access Denied</h1>
          <p className="text-muted-foreground text-lg mb-8">You must authenticate to access personnel records.</p>
          <Button size="lg" onClick={login}>AUTHENTICATE NOW</Button>
        </div>
      </Layout>
    );
  }

  if (isLoading || !profile) {
    return (
      <Layout>
        <div className="max-w-5xl mx-auto px-4 py-12 animate-pulse space-y-8">
          <div className="h-32 bg-card border-2 border-border rounded-sm" />
          <div className="h-12 bg-card border-2 border-border rounded-sm w-full max-w-md" />
          <div className="h-64 bg-card border-2 border-border rounded-sm" />
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="max-w-5xl mx-auto px-4 py-12 md:py-20">
        
        {/* Profile Header */}
        <div className="bg-card border-2 border-border p-8 rounded-sm shadow-xl flex flex-col md:flex-row items-center gap-8 relative overflow-hidden mb-12">
          <div className="absolute top-0 right-0 w-32 h-32 bg-primary/10 rounded-bl-full -mr-16 -mt-16 pointer-events-none" />
          
          {profile.profileImageUrl ? (
            <img src={profile.profileImageUrl} alt={profile.firstName || "Agent"} className="w-24 h-24 rounded-sm border-2 border-primary object-cover shadow-[0_0_15px_rgba(249,115,22,0.3)]" />
          ) : (
            <div className="w-24 h-24 bg-secondary border-2 border-primary flex items-center justify-center rounded-sm font-display text-4xl text-primary font-bold shadow-[0_0_15px_rgba(249,115,22,0.3)]">
              {(profile.firstName?.[0] || profile.email?.[0] || "A").toUpperCase()}
            </div>
          )}
          
          <div className="flex-1 text-center md:text-left z-10">
            <h1 className="text-3xl md:text-4xl font-display uppercase tracking-wide text-foreground mb-2">
              Agent {profile.firstName} {profile.lastName}
            </h1>
            <p className="text-muted-foreground text-lg font-medium">{profile.email}</p>
          </div>

          <div className="z-10">
            <Button variant="danger" onClick={logout} className="gap-2">
              <LogOut className="w-4 h-4" /> DISCONNECT
            </Button>
          </div>
        </div>

        {/* Favorite Hashtags */}
        {profile.favoriteHashtags && profile.favoriteHashtags.length > 0 && (
          <div className="bg-card border-2 border-border p-6 rounded-sm shadow mb-8">
            <div className="flex items-center gap-2 mb-4">
              <Hash className="w-5 h-5 text-primary" />
              <h2 className="font-display text-xl uppercase tracking-wide text-foreground">Favorite Intel Tags</h2>
            </div>
            <div className="flex flex-wrap gap-2">
              {profile.favoriteHashtags.map((tag: string) => (
                <Link key={tag} href={`/search?q=%23${encodeURIComponent(tag)}`}>
                  <span className="inline-block bg-primary/10 text-primary border border-primary/40 hover:bg-primary/20 hover:border-primary transition-colors px-4 py-1.5 rounded-sm font-bold font-display text-sm uppercase tracking-widest cursor-pointer">
                    #{tag}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Custom Tabs */}
        <div className="flex overflow-x-auto gap-2 mb-8 border-b-2 border-border pb-[-2px] no-scrollbar">
          <button 
            onClick={() => setActiveTab("liked")}
            className={`flex items-center gap-2 px-6 py-4 font-display text-lg uppercase tracking-wider transition-colors border-b-2 whitespace-nowrap ${activeTab === "liked" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"}`}
          >
            <ThumbsUp className="w-5 h-5" /> Liked Intel ({profile.likedFacts.length})
          </button>
          <button 
            onClick={() => setActiveTab("submitted")}
            className={`flex items-center gap-2 px-6 py-4 font-display text-lg uppercase tracking-wider transition-colors border-b-2 whitespace-nowrap ${activeTab === "submitted" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"}`}
          >
            <FileText className="w-5 h-5" /> Submissions ({profile.submittedFacts.length})
          </button>
          <button 
            onClick={() => setActiveTab("history")}
            className={`flex items-center gap-2 px-6 py-4 font-display text-lg uppercase tracking-wider transition-colors border-b-2 whitespace-nowrap ${activeTab === "history" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"}`}
          >
            <Clock className="w-5 h-5" /> Search History
          </button>
        </div>

        {/* Tab Content */}
        <div className="min-h-[400px]">
          {activeTab === "liked" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {profile.likedFacts.map(fact => <FactCard key={fact.id} fact={fact} />)}
              {profile.likedFacts.length === 0 && <p className="col-span-full text-center text-muted-foreground py-12">No liked facts. You have high standards.</p>}
            </div>
          )}

          {activeTab === "submitted" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {profile.submittedFacts.map(fact => <FactCard key={fact.id} fact={fact} />)}
              {profile.submittedFacts.length === 0 && (
                <div className="col-span-full text-center py-12 bg-card border-2 border-dashed border-border rounded-sm">
                  <p className="text-muted-foreground text-lg mb-4">You haven't contributed any intel yet.</p>
                  <Link href="/submit"><Button>SUBMIT FACT</Button></Link>
                </div>
              )}
            </div>
          )}

          {activeTab === "history" && (
            <div className="bg-card border-2 border-border rounded-sm p-6 max-w-2xl">
              <h3 className="font-display text-xl uppercase mb-6 text-foreground border-b border-border pb-4">Recent Queries</h3>
              <div className="space-y-2">
                {profile.searchHistory.map((query, i) => (
                  <Link key={i} href={`/search?q=${encodeURIComponent(query)}`} className="block px-4 py-3 bg-secondary hover:bg-primary/20 hover:text-primary transition-colors font-medium rounded-sm border border-transparent hover:border-primary/30">
                    "{query}"
                  </Link>
                ))}
                {profile.searchHistory.length === 0 && <p className="text-muted-foreground italic">Memory wiped. No history found.</p>}
              </div>
            </div>
          )}
        </div>

      </div>
    </Layout>
  );
}
