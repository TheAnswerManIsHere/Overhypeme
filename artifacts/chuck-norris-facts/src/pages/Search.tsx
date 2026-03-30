import { useLocation } from "wouter";
import { useEffect, useState } from "react";
import { useListFacts, useRecordSearch } from "@workspace/api-client-react";
import { Layout } from "@/components/layout/Layout";
import { FactCard } from "@/components/facts/FactCard";
import { Input } from "@/components/ui/Input";
import { Search as SearchIcon } from "lucide-react";
import { useAppMutations } from "@/hooks/use-mutations";

export default function Search() {
  const [location] = useLocation();
  const queryParams = new URLSearchParams(window.location.search);
  const initialQuery = queryParams.get("q") || "";
  
  const [inputValue, setInputValue] = useState(initialQuery);
  const [debouncedSearch, setDebouncedSearch] = useState(initialQuery);
  
  const { recordSearch } = useAppMutations();

  // Extract hashtag if query starts with #
  const isHashtagSearch = debouncedSearch.startsWith("#");
  const searchQuery = isHashtagSearch ? "" : debouncedSearch;
  const hashtagQuery = isHashtagSearch ? debouncedSearch.slice(1) : "";

  const { data, isLoading } = useListFacts({ 
    search: searchQuery || undefined, 
    hashtag: hashtagQuery || undefined,
    sort: "newest" 
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(inputValue);
      // Record search history if there's a valid query
      if (inputValue.trim().length > 2) {
        recordSearch.mutate({ data: { query: inputValue.trim() } });
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [inputValue, recordSearch]);

  return (
    <Layout>
      <div className="max-w-5xl mx-auto px-4 py-12">
        <div className="mb-12">
          <h1 className="text-4xl font-display uppercase tracking-widest text-foreground mb-6">Search Database</h1>
          <Input 
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="Type to search..."
            icon={<SearchIcon className="w-6 h-6" />}
            className="h-16 text-xl font-bold bg-card border-border"
          />
        </div>

        <div className="space-y-8">
          <div className="border-b-2 border-border pb-4 flex justify-between items-end">
            <h2 className="text-xl font-display text-muted-foreground uppercase">
              {isLoading ? "Searching..." : `Results (${data?.total || 0})`}
            </h2>
          </div>

          {isLoading && (
            <div className="space-y-6">
              {[1, 2, 3].map(i => (
                <div key={i} className="h-40 bg-card border-2 border-border rounded-sm animate-pulse" />
              ))}
            </div>
          )}

          {!isLoading && data?.facts && (
            <div className="space-y-6">
              {data.facts.map(fact => (
                <FactCard key={fact.id} fact={fact} />
              ))}
            </div>
          )}
          
          {!isLoading && data?.facts?.length === 0 && (
            <div className="text-center py-20 bg-card border-2 border-dashed border-border rounded-sm">
              <SearchIcon className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
              <h3 className="text-2xl font-display uppercase text-muted-foreground">No matches found</h3>
              <p className="text-muted-foreground/80 mt-2">Chuck Norris already deleted these records.</p>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
