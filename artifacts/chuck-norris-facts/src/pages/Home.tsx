import { useListFacts } from "@workspace/api-client-react";
import { FactCard } from "@/components/facts/FactCard";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { Search } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useState } from "react";
import { motion } from "framer-motion";

export default function Home() {
  const [searchQuery, setSearchQuery] = useState("");
  const [, setLocation] = useLocation();
  const { data, isLoading, error } = useListFacts({ sort: "top", limit: 10 });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      setLocation(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
    }
  };

  return (
    <Layout>
      {/* Hero Section */}
      <section className="relative pt-24 pb-32 md:pt-32 md:pb-48 overflow-hidden border-b-4 border-primary">
        <div className="absolute inset-0 z-0">
          <img 
            src={`${import.meta.env.BASE_URL}images/hero-bg.png`} 
            alt="Hero Action Background" 
            className="w-full h-full object-cover opacity-40 mix-blend-luminosity grayscale contrast-150"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-background via-background/80 to-transparent" />
        </div>
        
        <div className="relative z-10 max-w-5xl mx-auto px-4 text-center">
          <motion.h1 
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-5xl md:text-7xl lg:text-8xl font-display font-bold uppercase tracking-tight text-white drop-shadow-[0_5px_5px_rgba(0,0,0,1)] mb-6"
          >
            The Universe Doesn't Expand. <br/>
            <span className="text-primary block mt-2 transform -skew-x-6 drop-shadow-[0_0_30px_rgba(249,115,22,0.8)]">Chuck Norris Pushes It.</span>
          </motion.h1>
          
          <motion.p 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto mb-10 font-medium"
          >
            The ultimate database of Chuck Norris facts. Rated by survivors.
          </motion.p>

          <motion.form 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.3 }}
            onSubmit={handleSearch} 
            className="max-w-2xl mx-auto flex flex-col sm:flex-row gap-4"
          >
            <div className="relative flex-1">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-6 h-6 text-muted-foreground" />
              <input 
                type="text"
                placeholder="Find a fact..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full h-14 pl-12 pr-4 bg-background/80 backdrop-blur border-2 border-border focus:border-primary text-lg font-bold rounded-sm outline-none transition-colors shadow-2xl"
              />
            </div>
            <Button type="submit" size="lg" className="shrink-0 w-full sm:w-auto">
              SEARCH
            </Button>
          </motion.form>
        </div>
      </section>

      {/* Leaderboard Section */}
      <section className="max-w-7xl mx-auto px-4 py-20">
        <div className="flex items-end justify-between mb-12 border-b-2 border-border pb-4">
          <div>
            <h2 className="text-4xl font-display text-foreground tracking-wide">THE HALL OF FAME</h2>
            <p className="text-primary font-bold mt-1 tracking-widest uppercase text-sm">Top Rated Facts</p>
          </div>
          <Button variant="outline" onClick={() => setLocation('/submit')} className="hidden sm:flex">
            SUBMIT A FACT
          </Button>
        </div>

        {isLoading && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 animate-pulse">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-64 bg-card border-2 border-border rounded-sm" />
            ))}
          </div>
        )}

        {error && (
          <div className="bg-destructive/10 border-2 border-destructive p-8 text-center rounded-sm">
            <p className="text-destructive font-bold text-xl uppercase">Error loading facts. Chuck Norris destroyed the server.</p>
          </div>
        )}

        {data?.facts && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-12">
            {data.facts.map((fact, idx) => (
              <FactCard key={fact.id} fact={fact} rank={idx + 1} showRank={true} />
            ))}
          </div>
        )}

        {data?.facts?.length === 0 && (
          <p className="text-muted-foreground text-center py-12 text-lg">No facts found. Better start running.</p>
        )}
      </section>
    </Layout>
  );
}
