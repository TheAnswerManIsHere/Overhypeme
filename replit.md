# Overview

Overhype.me is a community-driven, personalized facts database where facts are stored with dynamic tokens and rendered with user-defined names. The platform aims to foster user engagement with facts, facilitate meme generation, and integrate affiliate marketing and analytics. It is built as a pnpm monorepo using TypeScript, featuring an Express 5 API, PostgreSQL with Drizzle ORM, and a React with Vite frontend. Key features include user authentication, AI-powered duplicate detection, meme generation with video capabilities, and comprehensive error reporting.

# User Preferences

I prefer clear and concise communication. For coding, I prefer functional programming paradigms where applicable. I favor iterative development and would like to be consulted before any major architectural changes or feature implementations. Please ensure that all changes are thoroughly tested.

# System Architecture

The project utilizes a pnpm monorepo structure, segmenting the API server, frontend, database layer, and generated API clients.

**UI/UX Decisions:**
The `overhype-me` frontend is a React+Vite application with a dark theme and orange accents, offering a facts leaderboard, search, hashtag browsing, user profiles, and an admin interface. Meme generation is handled via an HTML5 Canvas builder. The homepage dynamically adapts content for cold vs. warm visitors, prioritizing engagement and personalized experiences.

**Technical Implementations:**
-   **Monorepo:** pnpm workspaces manage distinct packages.
-   **API Server (`api-server`):** Express 5, Zod for validation.
-   **Frontend (`overhype-me`):** React with Vite, consumes API via generated React Query hooks.
-   **Database Layer (`db`):** PostgreSQL with Drizzle ORM, `pgvector` for AI duplicate detection.
-   **Authentication:** Replit OIDC and local email/password (`bcryptjs`).
-   **API Codegen:** OpenAPI 3.1 and Orval generate TypeScript clients (`api-client-react`) and Zod schemas (`api-zod`).
-   **AI Features:**
    -   **Duplicate Detection:** `pgvector` with OpenAI's `text-embedding-3-small` for cosine similarity.
    -   **Meme Video Generation:** fal.ai's Kling image-to-video model.
-   **Error Reporting:** Sentry for end-to-end monitoring.
-   **Email Notifications:** Resend for transactional emails.
-   **Build System:** `esbuild` for backend, Vite for frontend, `tsc` for type checking.

**Feature Specifications:**
-   **Fact Management:** User submission, AI duplicate detection, admin review.
-   **Meme Generation:** HTML5 Canvas, gradient themes, cloud storage uploads, video generation.
-   **User Engagement:** Leaderboard, search, hashtags, ratings, comments, personalized activity feed.
-   **Admin Interface:** Dashboard for fact management (bulk import), users, billing, and reviews.
-   **Security Hardening:** Includes webhook deduplication/auditing, checkout idempotency, shared rate limiting, data lifecycle/DSR, resource governance, share-route hardening, image URL validation, Stripe 5xx sanitization, and CSRF protection.

# External Dependencies

-   **Monorepo Tool:** pnpm workspaces
-   **Package Manager:** pnpm
-   **API Framework:** Express 5
-   **Database:** PostgreSQL
-   **ORM:** Drizzle ORM
-   **Validation:** Zod
-   **API Codegen:** Orval
-   **AI Embeddings:** OpenAI API
-   **AI Video Generation:** fal.ai API
-   **Cloud Storage:** Google Cloud Storage
-   **Error Reporting:** Sentry
-   **Email Service:** Resend
-   **Payments:** Stripe
-   **Authentication:** Replit OAuth
-   **Captcha:** hCaptcha
-   **Hashing:** bcryptjs