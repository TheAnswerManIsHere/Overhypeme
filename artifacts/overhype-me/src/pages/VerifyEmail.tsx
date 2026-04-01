import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { CheckCircle, XCircle, Loader2, Mail } from "lucide-react";

type Status = "loading" | "success" | "already" | "error";

export default function VerifyEmail() {
  const [, setLocation] = useLocation();
  const [status, setStatus] = useState<Status>("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");

    if (!token) {
      setStatus("error");
      setMessage("No verification token found. Please use the link from your email.");
      return;
    }

    fetch(`/api/auth/verify-email?token=${encodeURIComponent(token)}`, {
      credentials: "include",
    })
      .then(async (res) => {
        const data = (await res.json()) as { success?: boolean; message?: string; error?: string };
        if (res.ok) {
          if (data.message === "Email already verified.") {
            setStatus("already");
            setMessage("Your email is already verified.");
          } else {
            setStatus("success");
            setMessage(data.message ?? "Email verified successfully!");
          }
        } else {
          setStatus("error");
          setMessage(data.error ?? "Verification failed. Please try again.");
        }
      })
      .catch(() => {
        setStatus("error");
        setMessage("Network error. Please try again.");
      });
  }, []);

  return (
    <Layout>
      <div className="min-h-[80vh] flex items-center justify-center px-4">
        <div className="w-full max-w-md">
          <div className="bg-card border-2 border-border rounded-sm p-10 shadow-lg text-center">
            {status === "loading" && (
              <>
                <Loader2 className="w-14 h-14 text-primary animate-spin mx-auto mb-5" />
                <h1 className="font-display text-2xl font-bold tracking-wider mb-2">Verifying your email…</h1>
                <p className="text-muted-foreground text-sm">Please wait a moment.</p>
              </>
            )}

            {status === "success" && (
              <>
                <CheckCircle className="w-14 h-14 text-green-500 mx-auto mb-5" />
                <h1 className="font-display text-2xl font-bold tracking-wider mb-2 text-green-400">Email Verified!</h1>
                <p className="text-muted-foreground text-sm mb-6">{message}</p>
                <Button variant="primary" className="w-full" onClick={() => setLocation("/")}>
                  Go to Home
                </Button>
              </>
            )}

            {status === "already" && (
              <>
                <CheckCircle className="w-14 h-14 text-green-500 mx-auto mb-5" />
                <h1 className="font-display text-2xl font-bold tracking-wider mb-2">Already Verified</h1>
                <p className="text-muted-foreground text-sm mb-6">{message}</p>
                <Button variant="primary" className="w-full" onClick={() => setLocation("/")}>
                  Go to Home
                </Button>
              </>
            )}

            {status === "error" && (
              <>
                <XCircle className="w-14 h-14 text-destructive mx-auto mb-5" />
                <h1 className="font-display text-2xl font-bold tracking-wider mb-2">Verification Failed</h1>
                <p className="text-muted-foreground text-sm mb-6">{message}</p>
                <div className="flex flex-col gap-3">
                  <Button
                    variant="primary"
                    className="w-full gap-2"
                    onClick={async () => {
                      await fetch("/api/auth/resend-verification", {
                        method: "POST",
                        credentials: "include",
                      });
                      setStatus("success");
                      setMessage("A new verification email has been sent. Please check your inbox.");
                    }}
                  >
                    <Mail className="w-4 h-4" /> Resend Verification Email
                  </Button>
                  <Button variant="outline" className="w-full" onClick={() => setLocation("/")}>
                    Go to Home
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
}
