interface SentryFallbackProps {
  resetError: () => void;
}

export default function SentryFallback({ resetError }: SentryFallbackProps) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#0d0d0e",
        color: "#fff",
        padding: "2rem",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <div style={{ maxWidth: 480, textAlign: "center" }}>
        <h1
          style={{
            fontFamily: "Oswald, Impact, sans-serif",
            fontWeight: 700,
            fontSize: "2.5rem",
            color: "#FF3C00",
            marginBottom: "1rem",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Something broke
        </h1>
        <p style={{ fontSize: "1rem", lineHeight: 1.6, marginBottom: "2rem", opacity: 0.85 }}>
          We hit an unexpected error on the page. Our team has been notified. Try
          reloading — most of the time that's enough.
        </p>
        <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center" }}>
          <button
            type="button"
            onClick={() => {
              resetError();
              window.location.reload();
            }}
            style={{
              backgroundColor: "#FF3C00",
              color: "#fff",
              border: "none",
              padding: "0.75rem 1.5rem",
              fontFamily: "Oswald, Impact, sans-serif",
              fontSize: "1rem",
              fontWeight: 600,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              cursor: "pointer",
              borderRadius: 4,
            }}
          >
            Reload page
          </button>
          <button
            type="button"
            onClick={() => {
              window.location.href = "/";
            }}
            style={{
              backgroundColor: "transparent",
              color: "#fff",
              border: "1px solid rgba(255,255,255,0.3)",
              padding: "0.75rem 1.5rem",
              fontFamily: "Oswald, Impact, sans-serif",
              fontSize: "1rem",
              fontWeight: 600,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              cursor: "pointer",
              borderRadius: 4,
            }}
          >
            Go home
          </button>
        </div>
      </div>
    </div>
  );
}
