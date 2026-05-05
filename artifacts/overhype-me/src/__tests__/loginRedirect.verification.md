# Sign-in Redirect Smoke Test — Task #454

## What was verified

The `isMobileDevice()` fix for iOS 13+ iPads and the `handleGoogleLogin` /
`handleAppleLogin` branching logic in `Login.tsx` were validated via automated
component-level tests running in a jsdom environment with mocked navigator
properties.

## Test execution results

All 7 component-level tests in `loginRedirect.test.ts` pass (run via
`pnpm --filter @workspace/overhype-me test`).

### Devices / UAs simulated and outcome

| Device / Context | UA platform | maxTouchPoints | Expected | Result |
|---|---|---|---|---|
| iPad iOS 13+ — Safari | MacIntel | 5 | **redirect** (Google) | PASS |
| iPad iOS 13+ — Safari | MacIntel | 5 | **redirect** (Apple) | PASS |
| iPad iOS 13+ — boundary | MacIntel | 2 | **redirect** | PASS |
| macOS Safari — boundary | MacIntel | 1 | **popup** (not tablet) | PASS |
| Android tablet (SM-T870, Android 12) | Linux armv8l | 5 | **redirect** | PASS |
| macOS Chrome desktop | MacIntel | 0 | **popup** | PASS |
| Windows Chrome desktop | Win32 | 0 | **popup** | PASS |

### How the test works

Each test:
1. Overrides `navigator.userAgent`, `navigator.platform`, and
   `navigator.maxTouchPoints` to simulate the target device.
2. Renders the real `<Login />` component (layout and pronoun editor mocked
   as pass-throughs to avoid the auth/query dependency tree).
3. `fireEvent.click`s the actual "CONTINUE WITH GOOGLE" / "CONTINUE WITH APPLE"
   buttons — the same DOM buttons a real user taps.
4. Asserts that `window.location.href` was set (redirect) or `window.open` was
   called with the `&popup=1` URL (popup).

### Why the automated tests are the best available evidence

Real hardware testing is not available in the CI/automated environment.
The jsdom simulation is a faithful proxy because:

- The detection logic (`isMobileDevice()`) is a pure function of
  `navigator.userAgent`, `navigator.platform`, and `navigator.maxTouchPoints`.
- The iPadOS 13+ masquerade (MacIntel UA + maxTouchPoints > 1) is a
  well-documented, deterministic browser behaviour.
- The component tests exercise the actual production code path — no handler
  logic was reimplemented or stubbed.

## Relevant files

- `src/lib/utils.ts` — `isMobileDevice()` implementation
- `src/pages/Login.tsx` — `handleGoogleLogin`, `handleAppleLogin`
- `src/__tests__/loginRedirect.test.ts` — component-level tests (this task)
- `src/lib/utils.test.ts` — unit tests for `isMobileDevice()` (pre-existing)
