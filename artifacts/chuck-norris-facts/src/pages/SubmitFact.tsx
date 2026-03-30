import { useState } from "react";
import { useLocation } from "wouter";
import HCaptcha from "@hcaptcha/react-hcaptcha";
import { useAuth } from "@workspace/replit-auth-web";

import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { Textarea, Input } from "@/components/ui/Input";
import { useAppMutations } from "@/hooks/use-mutations";
import { ShieldAlert, AlertTriangle } from "lucide-react";

const HCAPTCHA_SITE_KEY =
  import.meta.env.VITE_HCAPTCHA_SITE_KEY || "10000000-ffff-ffff-ffff-000000000001";

export default function SubmitFact() {
  const { isAuthenticated, login } = useAuth();
  const [, setLocation] = useLocation();
  const { createFact } = useAppMutations();
  
  const [text, setText] = useState("");
  const [hashtagsStr, setHashtagsStr] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const [error, setError] = useState("");

  if (!isAuthenticated) {
    return (
      <Layout>
        <div className="max-w-2xl mx-auto px-4 py-24 text-center">
          <ShieldAlert className="w-20 h-20 text-primary mx-auto mb-6 opacity-80" />
          <h1 className="text-4xl font-display uppercase mb-4 text-foreground">Restricted Area</h1>
          <p className="text-muted-foreground text-lg mb-8">You must be authorized to submit facts to the database.</p>
          <Button size="lg" onClick={login}>IDENTIFY YOURSELF (LOGIN)</Button>
        </div>
      </Layout>
    );
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (text.length < 10) {
      setError("Fact must be at least 10 characters.");
      return;
    }
    if (!captchaToken) {
      setError("Please prove you are not a bot.");
      return;
    }

    const tags = hashtagsStr.split(",")
      .map(t => t.trim().replace(/^#/, ""))
      .filter(t => t.length > 0);

    createFact.mutate(
      { data: { text, hashtags: tags, captchaToken } },
      {
        onSuccess: (data) => {
          setLocation(`/facts/${data.id}`);
        },
        onError: (err) => {
          setError(err.data?.error || err.message || "Failed to submit fact");
        }
      }
    );
  };

  return (
    <Layout>
      <div className="max-w-3xl mx-auto px-4 py-12 md:py-20">
        <div className="mb-10 text-center">
          <h1 className="text-5xl font-display uppercase tracking-wider text-foreground mb-4">Submit Protocol</h1>
          <p className="text-muted-foreground text-lg max-w-xl mx-auto">
            Add a new verified fact to the database. Duplicate submissions will be dealt with severely.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="bg-card border-2 border-border p-6 md:p-10 rounded-sm shadow-2xl relative overflow-hidden">
          {/* Accent bar */}
          <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-primary to-destructive" />

          {error && (
            <div className="mb-8 p-4 bg-destructive/10 border-l-4 border-destructive text-destructive flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <span className="font-bold">{error}</span>
            </div>
          )}

          <div className="space-y-8">
            <div>
              <label className="block font-display text-xl uppercase text-foreground mb-2">The Fact</label>
              <Textarea 
                value={text}
                onChange={e => setText(e.target.value)}
                placeholder="When Chuck Norris looks in a mirror, there is no reflection. There can only be one Chuck Norris."
                className="text-lg min-h-[160px]"
                disabled={createFact.isPending}
              />
              <p className="text-sm text-muted-foreground mt-2 font-medium">Minimum 10 characters. Make it hit hard.</p>
            </div>

            <div>
              <label className="block font-display text-xl uppercase text-foreground mb-2">Hashtags</label>
              <Input 
                value={hashtagsStr}
                onChange={e => setHashtagsStr(e.target.value)}
                placeholder="impossible, strong, facts"
                disabled={createFact.isPending}
              />
              <p className="text-sm text-muted-foreground mt-2 font-medium">Comma separated. No need for the # symbol.</p>
            </div>

            <div className="pt-4 border-t-2 border-border">
              <label className="block font-display text-xl uppercase text-foreground mb-4">Security Clearance</label>
              <div className="bg-background p-4 rounded-sm border-2 border-border inline-block">
                <HCaptcha
                  sitekey={HCAPTCHA_SITE_KEY}
                  onVerify={setCaptchaToken}
                />
              </div>
            </div>

            <div className="pt-6">
              <Button 
                type="submit" 
                size="lg" 
                className="w-full h-16 text-xl"
                isLoading={createFact.isPending}
              >
                COMMIT TO DATABASE
              </Button>
            </div>
          </div>
        </form>
      </div>
    </Layout>
  );
}
