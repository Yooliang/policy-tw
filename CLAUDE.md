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
- **`composables/useIndexedDB.ts`** — IndexedDB caching for politicians data (reduces API calls)
- **`composables/useGlobalState.ts`** — Shared state for region selection across pages
- **`lib/supabase.ts`** — Supabase client initialization
- **Views used**: `policies_with_logs`, `politicians_with_elections`, `discussions_full` (JSON aggregation)

### Database Schema (14 tables)
Core: `elections`, `election_types`, `politicians`, `politician_elections`, `policies`, `tracking_logs`, `related_policies`, `discussions`, `discussion_comments`, `comment_replies`
Reference: `categories`, `locations`, `regions`, `electoral_district_areas`

ENUMs: `policy_status`, `political_party`, `election_type`, `politician_status`

#### Electoral District Mapping
The `electoral_district_areas` table maps townships (鄉鎮市區) to electoral districts (選舉區) for councilor filtering:
- Structure: `region` (縣市) + `electoral_district` (第01選舉區) + `township` (茂林區) + `election_id` (year, e.g., 2022)
- When user selects a township, the system looks up the corresponding electoral district and filters councilors
- Data scraped from CEC API via AdminScraper page
- **Important**: `election_id` stores the **year** (2022), not the database election ID

### Frontend Structure
```
pages/                    # Route components (lazy-loaded)
├── Home.vue             # Dashboard with status overview
├── PolicyTracking.vue   # Filter/search policies
├── PolicyDetail.vue     # Single policy with timeline
├── PolicyAnalysis.vue   # AI analysis listing
├── PolicyDeepAnalysis.vue # Deep dive with timeline
├── ElectionPage.vue     # Generic election page (/election/:electionId) - uses KeepAlive
├── PoliticianProfile.vue # Politician detail
├── Community.vue        # Discussion listing
├── DiscussionDetail.vue # Single discussion
├── RegionalData.vue     # Regional statistics view
├── AdminScraper.vue     # CEC data scraper (electoral district mapping)
└── election/            # Election sub-components
    ├── PoliticianGrid.vue  # Collapsible politician grid
    ├── PoliticianDropdown.vue
    └── VerticalStack.vue

components/               # Shared components
├── Navbar.vue, Footer.vue
├── Hero.vue, PolicyCard.vue, StatusBadge.vue
├── GlobalRegionSelector.vue  # Shared region selector
```

### Type Definitions (`types.ts`)
- `PolicyStatus` enum: Proposed, In Progress, Achieved, Stalled, Failed, Campaign Pledge
- `PoliticalParty` enum: 國民黨, 民進黨, 民眾黨, 無黨籍
- `ElectionType` enum: 9 levels — 總統副總統, 立法委員, 縣市長, 縣市議員, 鄉鎮市長, 直轄市山地原住民區長, 鄉鎮市民代表, 直轄市山地原住民區民代表, 村里長
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
- `ElectionPage.vue` uses `<KeepAlive>` to preserve filter state during navigation
- Electoral district lookups use **election year** (2022), not database election ID

## Admin Tools

### AdminScraper (`/admin/scraper`)
Scrapes election data from CEC (Central Election Commission) API:
- **Politician scraping** — Fetches candidates by election type and region
- **Electoral district mapping** — Maps townships to electoral districts for councilor filtering
- Data source: `https://db.cec.gov.tw/ElecTable/Election/ElecTickets`

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
