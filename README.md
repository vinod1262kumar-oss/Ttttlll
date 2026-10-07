# TruthLens V1

TruthLens — **Uncover What's Really Inside.**

V1 includes:
- Desktop-first TruthLens landing page based on the selected dark/gold UI direction.
- Supabase email/password authentication.
- Optional Google OAuth button using the Supabase client.
- Product label image scanning with Gemini on the backend.
- Deterministic nutrition + claim analysis after OCR/vision extraction.
- Scan history tied to the authenticated user.
- Durva AI assistant for food questions, meal planning, and task/plan creation.
- 8 free scans per account. After 8 scans, the UI shows an upgrade state; no payment provider is enabled in V1.
- Server-side secrets, Helmet CSP, rate limiting, request-size limits, strict validation, auth checks, atomic quota RPC, and RLS SQL.

## Setup

1. Copy `.env.example` to `.env` and fill the values.
2. Run `npm install`.
3. Open the Supabase SQL editor and run `sql/schema.sql`.
4. Enable Email/Password in Supabase Auth. If desired, configure Google in Supabase Auth and keep the Google button enabled.
5. Start with `npm start`.
6. Open `http://localhost:3000`.

## Production

Set the same environment variables in Render. Do not commit `.env`. The browser receives only the Supabase URL and publishable key; Gemini and the Supabase secret key stay server-side.

## Security model

The Supabase secret key is used only by the backend. User data is protected with RLS. The scan counter is incremented atomically by a database function so concurrent requests cannot simply race past the free allowance. AI calls require a signed-in user. Image payloads are limited by bytes and MIME type. API errors intentionally avoid returning stack traces or secrets.

This is security-hardened application code, not a guarantee that any internet-facing software can never be attacked. Keep dependencies updated and rotate any key that is ever exposed.

## Frontend wiring

The landing page JavaScript now supports the Stitch-style landing page:
- Get Started -> Supabase email/password or Google OAuth.
- Scan a Product -> authenticated scanner modal.
- Scan result -> Gemini-backed nutrition/claim analysis.
- Scan history -> `/app.html`.
- Durva -> dedicated `/durva.html`.
- Dashboard -> scan history and Durva tasks.

## Environment variables

Never put `SUPABASE_SECRET_KEY` or `GEMINI_API_KEY` in `public/` or frontend JavaScript. On Render, add them under **Environment**. Only `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are sent to the browser.

For Google login, configure Google under Supabase Authentication > Providers and add your production site/redirect URL to the Supabase URL configuration.
