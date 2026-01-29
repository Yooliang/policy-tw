# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

正見 (Zheng Jian) — A Taiwan policy tracking platform built with Vue 3 + TypeScript + Vite + Supabase. Tracks election promises and policy progress across different levels of government.

## Commands

```bash
# Development
pnpm dev              # Start dev server at http://localhost:3000

# Build & Deploy
pnpm build            # Type-check (vue-tsc) then build
npx firebase deploy --only hosting  # Deploy to Firebase Hosting

# Database
npx supabase db push  # Push migrations to remote Supabase
npx supabase link --project-ref <id>  # Link to Supabase project

# Type checking only
npx vue-tsc --noEmit
```

## Architecture

### Data Layer
- **Supabase PostgreSQL** — All data stored remotely (project: `wiiqoaytpqvegtknlbue`)
- **`composables/useSupabase.ts`** — Global state composable, fetches once and shares across components
- **`lib/supabase.ts`** — Supabase client initialization
- **Views used**: `policies_with_logs`, `politicians_with_elections`, `discussions_full` (JSON aggregation)

### Database Schema (12 tables)
Core: `elections`, `election_types`, `politicians`, `politician_elections`, `policies`, `tracking_logs`, `related_policies`, `discussions`, `discussion_comments`, `comment_replies`
Reference: `categories`, `locations`

ENUMs: `policy_status`, `political_party`, `election_type`, `politician_status`

### Frontend Structure
```
pages/                    # Route components (lazy-loaded)
├── Home.vue             # Dashboard with status overview
├── PolicyTracking.vue   # Filter/search policies
├── PolicyDetail.vue     # Single policy with timeline
├── PolicyAnalysis.vue   # AI analysis listing
├── PolicyDeepAnalysis.vue # Deep dive with timeline
├── ElectionPage.vue     # Generic election page (/election/:electionId)
├── PoliticianProfile.vue # Politician detail
├── Community.vue        # Discussion listing
├── DiscussionDetail.vue # Single discussion
└── election/            # Election sub-components
    ├── PoliticianGrid.vue
    ├── PoliticianDropdown.vue
    └── VerticalStack.vue

components/               # Shared components
├── Navbar.vue, Footer.vue
├── Hero.vue, PolicyCard.vue, StatusBadge.vue
```

### Type Definitions (`types.ts`)
- `PolicyStatus` enum: Proposed, In Progress, Achieved, Stalled, Failed, Campaign Pledge
- `PoliticalParty` enum: 國民黨, 民進黨, 民眾黨, 無黨籍
- `ElectionType` enum: 7 levels from 縣市長 to 村里長
- Interfaces: `Election`, `Politician`, `Policy`, `TrackingLog`, `Discussion`, etc.

### Data Flow Pattern
1. `useSupabase()` called → triggers `fetchAll()` on first use
2. Global `ref` state populated from Supabase views
3. Components use `computed()` for derived data (data is async)
4. snake_case (DB) → camelCase (frontend) mapping in composable

## Environment Variables

Required in `.env.local`:
```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
```

## Key Conventions

- All pages import data via `useSupabase()`, not from `constants.ts`
- `constants.ts` retained as reference only (not imported)
- RLS enabled on all tables with public read policies
- Migrations in `supabase/migrations/`, seed in `supabase/seed.sql`

## Edge Functions

Located in `supabase/functions/`:

- **`add-politician`** — Add new politician with optional policies
- **`add-policy`** — Add new policy to existing politician
- **`update-avatar`** — Batch update politician avatar URLs
- **`update-politician`** — Update any field of a politician (bio, slogan, etc.)


Deploy with: `npx supabase functions deploy <function-name>`

## Claude Skills

Located in `.claude/skills/`:

- **`/find-avatar [name]`** — Find politician avatar URLs from Wikipedia
  - Searches Wikipedia API for politician images
  - Supports batch queries and `--all` flag for missing avatars
  - Can update database via Edge Function
