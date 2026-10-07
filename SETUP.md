# TruthLens V1 setup

## 1. Local environment

Copy `.env.example` to `.env` and fill:

- `SUPABASE_URL`: your Supabase project URL.
- `SUPABASE_PUBLISHABLE_KEY`: browser-safe Supabase publishable/anon key.
- `SUPABASE_SECRET_KEY`: server-only Supabase secret/service key.
- `GEMINI_API_KEY`: server-only Gemini API key.
- `GEMINI_MODEL`: e.g. `gemini-2.5-flash`.
- `FREE_SCANS`: `8`.

**Never place `SUPABASE_SECRET_KEY` or `GEMINI_API_KEY` in `public/`, HTML, or frontend JS.**

## 2. Supabase

Run `sql/schema.sql` in the Supabase SQL editor.

Enable Email/Password under Supabase Authentication > Providers.

For Google login, enable Google under Authentication > Providers and configure its OAuth credentials there. Add your production site and `/app.html` callback URL as allowed redirect URLs.

## 3. Render

Set the environment variables in Render > Environment:

```text
SUPABASE_URL=...
SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_SECRET_KEY=...
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
FREE_SCANS=8
SITE_URL=https://YOUR-RENDER-DOMAIN
MAX_IMAGE_BYTES=5242880
PORT=10000
CONTACT_EMAIL=...
```

Do not commit `.env`.

## 4. What is wired

- Email sign-in/sign-up
- Google OAuth
- Persistent Supabase session
- Scan a product
- Camera/file input
- Gemini label analysis through the backend
- Nutrition extraction
- Claim verification
- Atomic 8-scan free quota
- User-specific scan history
- Delete history items
- Dedicated Durva page
- Durva food/nutrition Q&A
- Durva task creation
- Dashboard task completion
- Server-side Gemini and Supabase secrets

Payments are intentionally not enabled in V1. The 9th scan shows an upgrade state instead.
