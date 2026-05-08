# Adler — Product Sheet

## What it is

Adler is a Solana-native marketplace for **user-generated content**. Creators
list short-form video services (TikTok hooks, testimonial sets, product b-roll,
etc.) and brands either buy those services off the shelf or post **gigs** —
custom briefs that creators apply to. Money moves in SOL; identity, reputation,
and dispute history move with the wallet.

The web app is the MVP surface. It is **desktop-only** (`app/(app)/*`, gated
below 1024 px by `MobileGate`); a separate Expo client is on the runway for
mobile.

## How it's structured

A single user account can wear two hats. The same profile can have a
`creatorProfile` *and* a `brandProfile`, and the sidebar exposes a mode toggle
between the two views. Roles are independent flags on the profile, not separate
accounts.

- **Creator mode** — sell services, apply to gigs, deliver work, receive SOL.
- **Brand mode** — post gigs, review applicants, buy services, spend SOL.

A user can be both at once; they can also be neither (gated by `ProfileGate`
overlays until at least one side is set up).

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router, RSC where possible) on React 19 |
| Styling | Tailwind v4 (CSS-first via `@theme`/`@utility`); shadcn New-York primitives |
| Identity | Privy (Google OAuth login → embedded Solana wallet) |
| Auth bridge | Privy access token → Cloud Function `mintFirebaseToken` → Firebase custom token |
| Data | Firestore (`emptea-adler` project, shared with the paused mobile app) |
| Storage | Firebase Storage (avatars, listing media, message attachments) |
| Server | Firebase Cloud Functions (auth bridge, Solana RPC proxy, notification fan-out, account deletion) |
| State | TanStack Query (`QueryProvider`, keys in `lib/constants/queryKeys.ts`) |
| Chain | Solana web3.js + Privy `signAndSendTransaction`. Devnet today, mainnet on escrow ship |
| Motion | Framer Motion (`PageMount`, `FadeIn`, `Stagger`, `ModeSwitchOverlay`) |
| Toasts | Sonner |

Infrastructure (`firestore.rules`, `firestore.indexes.json`, `storage.rules`,
Cloud Functions) lives in the sibling repo `../adler-app`. This repo is a
client only.

## Route map

```
app/
├── page.tsx                            Marketing landing (always light theme)
├── whitepaper/page.tsx                 v0.1 whitepaper, 15 sections
└── (app)/
    ├── app/page.tsx                    Entry router → /sign-in | /intro | /browse
    ├── (auth)/                         Privy + Firebase resolved here
    │   ├── intro/page.tsx              3-slide first-run onboarding
    │   └── sign-in/page.tsx            Google-only OAuth via Privy
    └── (home)/                         ThemeProvider + AppSidebar; gated to ≥ lg
        ├── browse/page.tsx             Default landing — services (brand) or gigs (creator)
        ├── creators/                   Brand-side directory
        │   ├── page.tsx                Directory grid, niche filter
        │   └── [handle]/page.tsx       Public creator profile
        ├── brands/                     Creator-side directory
        │   ├── page.tsx                Directory grid, industry filter
        │   └── [handle]/page.tsx       Public brand profile
        ├── services/
        │   ├── page.tsx                Creator's own storefront (list + dialog create)
        │   ├── new/page.tsx            Redirect to /services?new=1 (legacy)
        │   ├── [id]/page.tsx           Service detail (Buy CTA for brands)
        │   └── [id]/edit/page.tsx      Edit form, owner-only
        ├── gigs/
        │   ├── page.tsx                Dual-role: brand → My gigs, creator → My applications
        │   ├── new/page.tsx            Brand-only gig authoring
        │   ├── [id]/page.tsx           Gig detail (Apply CTA for creators)
        │   └── [id]/edit/page.tsx      Edit form, owner-only
        ├── applicants/page.tsx         Brand-only — applications inbox across own gigs
        ├── applications/page.tsx       Creator-only — pitches I've sent
        ├── inbox/                      Application + order threads
        │   ├── page.tsx                Thread list, unread counts
        │   └── [threadId]/page.tsx     Full conversation with order/dispute/rating CTAs
        ├── notifications/page.tsx      Long-form notification feed
        ├── wallet/                     Creator-only
        │   ├── page.tsx                Balance, send/receive, recent activity, sales/purchases summary
        │   ├── sales/page.tsx          Orders against my services
        │   └── purchases/page.tsx      Services I've bought
        ├── spend/page.tsx              Brand-only — spend dashboard (totals, last-30, in-flight)
        ├── admin/disputes/             Arbiter-only via roles/{uid}
        │   ├── page.tsx                Open + resolved disputes list
        │   └── [id]/page.tsx           Per-dispute detail, message log, decide outcome
        └── settings/                   Tab-rail layout
            ├── page.tsx                Redirect → /settings/profile
            ├── profile/page.tsx        Edit basics + creator + brand sections
            ├── notifications/page.tsx  Per-kind notification toggles
            ├── account/page.tsx        Identity readout, sign-out, delete account
            └── billing/page.tsx        Protocol-fee history
```

## Features

### Auth & identity
- **Privy login** — Google OAuth only, with an embedded Solana wallet
  provisioned for new accounts (`createOnLogin: "users-without-wallets"`,
  `walletChainType: "solana-only"`). Native client-id is intentionally not
  passed; web only needs `appId`.
- **Privy → Firebase bridge** — Privy access token is exchanged for a
  Firebase custom token by the `mintFirebaseToken` Cloud Function, then signed
  in via `signInWithCustomToken`. Firestore rules authenticate the same uid
  on both sides (`lib/services/privyAuthService.ts`).
- **Idempotent profile bootstrap** — first sign-in writes
  `profiles/{uid}` + reserves a `usernames/{slug}` slug atomically in a
  transaction. Generated handles are `${adjective}${noun}${idTail}` so
  collisions in the reservation collection are essentially zero.
- **Online/offline guard** — `useAuth().runIfOnline` short-circuits writes
  when `navigator.onLine` is false and toasts the user.
- **Mobile gate** — every authenticated route is wrapped in `MobileGate`,
  which renders a friendly "use a bigger screen" panel below `lg` (1024 px).
- **Profile gate** — role-specific routes (`/services`, `/wallet`,
  `/applicants`, `/spend`, `/applications`) are gated by `ProfileGate`, which
  blurs the page behind an inline setup dialog until the matching
  sub-profile exists. The sidebar stays interactive so users can sign out or
  navigate elsewhere while gated.
- **First-run intro** — three-slide carousel at `/intro` (Welcome / Your
  wallet / Devnet test SOL), persisted via the `onboarding_seen`
  localStorage flag.
- **App entry router** — `/app` reads the Firebase session and the intro flag,
  then redirects to `/sign-in`, `/intro`, or `/browse` accordingly.
- **Account deletion** — `/settings/account` opens a typed-confirmation dialog
  (must type `@username` exactly), then calls `deleteUserAccount` Cloud
  Function which revokes Privy + Firebase identities; orders, applications,
  and reviews are retained for counterparty integrity.

### Profiles
- **Single document shape** mirrors the (paused) mobile app's
  `profiles/{uid}` schema (`lib/types/profile.ts`).
- **Creator sub-profile** — niches (1–6, max 24 chars each, lowercase
  normalized), portfolio URL, multiple social links per platform
  (Instagram / YouTube / TikTok / Twitter, deduped on write), opt-in DM
  contact (email / Telegram / phone, each independently nullable; collapses
  to `null` if every channel is blank).
- **Brand sub-profile** — required `companyName`, optional `industry` from a
  curated 15-group color-coded picker (`lib/utils/industries.ts`),
  `websiteUrl`, opt-in DM contact (same shape as creator).
- **Identity basics** — `displayName`, `bio`, `avatarUrl`, `country`
  (ISO-3166-1 alpha-2 or `null` for "Global"), `walletAddress` (synced from
  Privy on first sign-in).
- **Denormalized role flags** — `isCreator` and `isBrand` mirror
  `creatorProfile != null` / `brandProfile != null`; written in lockstep with
  the sub-profile and used by directory queries (Firestore can't `!=` a map).
- **Avatar pipeline** — upload → square crop dialog (`AvatarCropDialog` via
  `react-easy-crop`) → JPEG blob → `imageUploadService.uploadProfilePicture`
  → `getDownloadURL`. Path is `profilePictures/{uid}.jpg`.
- **Public directory pages** — `/creators/[handle]` and `/brands/[handle]`
  resolve through the `usernames/` reservation, then render the public
  view (avatar, niches/industry, portfolio + socials, bio, contact channels,
  reputation block, dispute outcomes).
- **Dirty-form guard** — `DirtyFormsContext` warns on unsaved edits when the
  user clicks a sidebar link or signs out.
- **Username editing is intentionally not exposed** — renaming requires a
  transactional `usernames/{slug}` migration that's out of scope for v1.

### Listings — Services
A creator's storefront entries (`services/{id}`).
- Title, description, **category** (beauty, fitness, health, education, food,
  lifestyle, general), price in SOL.
- Up to **5 media attachments** (images + short-form video; JPG/PNG/WEBP +
  MP4/WEBM/MOV; 50 MB cap per file enforced in `storage.rules`).
- Status state machine: `active → paused | sold` (sold reserved for the
  escrow integration; `paused` is what "delete from dashboard" maps to —
  hard delete is forbidden by the rules).
- Owner snapshot (handle / display name / avatar) is denormalized at create
  time; the marketplace feed renders without a profile join.
- Authoring lives as a dialog on the dashboard (`/services?new=1` URL-bound);
  detail at `/services/[id]`; edit at `/services/[id]/edit`.

### Listings — Gigs
A brand's open call for work (`gigs/{id}`).
- Title, description, **requirements**, category, **budget in SOL**, up to
  5 media attachments (same content-type and size rules as services).
- Status state machine: `open → awarded | closed`.
- Authoring at `/gigs/new`; detail at `/gigs/[id]`; edit at `/gigs/[id]/edit`.

### Applications
Creators apply to gigs (`gigApplications/{id}`, deterministic id
`${gigId}_${creatorId}` so double-applies are rejected by the rule).
- Pitch message + sample URLs.
- Brand snapshot + creator snapshot denormalized at create time for fast
  inbox-style rendering.
- Status state machine driven by the brand:
  `pending → shortlisted | awarded | rejected` (`pending` is unreachable
  after the first transition).
- Brands triage at `/applicants` with status-tab filtering (`all` | pending
  | shortlisted | awarded | rejected) and counts.
- Creators track their own pitches at `/applications` with the same filter
  strip.
- Applying creates an **application thread** seeded with the pitch as the
  first message (best-effort; if the thread create fails, the application
  doc still stands).

### Messaging — application + order threads
Top-level threads (`threads/{id}`) keyed deterministically by `${kind}_${parentId}`
so re-creating a thread for the same parent is a no-op.
- **Two kinds**: `application` (creator ↔ brand, parent = `gigApplications/{id}`)
  and `order` (buyer ↔ seller, parent = `orders/{id}`).
- **Thread doc** — participants array (always exactly 2 uids), per-uid
  participant snapshot (handle/display/avatar), denormalized parent title,
  last message preview + sender + timestamp, per-uid unread counter
  maintained by an `onMessageCreate` Cloud Function.
- **Messages subcollection** (`threads/{id}/messages/{messageId}`) — body
  (≤ 2000 chars), kind (`text` | `deliverable` | `revision_request` |
  `approval` | `system`), up to 5 attachments per message (images + short
  video, 25 MB cap each, paths under `threads/{threadId}/{messageId}/`).
- **Inbox** (`/inbox`) — single `participants array-contains` query
  ordered by `lastMessageAt`; unread badges per row and a global badge in
  the sidebar nav.
- **Self-zero unreads** — landing on a thread updates only your own
  `unreadCount` entry (the rule allows exactly that mutation; the Cloud
  Function bumps the counterparty's count back up on each new message).
- **Composer** — Enter to send, Shift+Enter for newline.
- **Deliverable submission** (seller, on `paid` orders) — opens
  `DeliverableDialog` (text + ≤ 5 attachments), posts a `deliverable`
  message, flips order to `delivered`.
- **Revision requests** (buyer, on `delivered` orders) — capped at 2
  (`REVISION_CAP`); the third click swaps the CTA to "Open dispute".
- **Approval** (buyer, on `delivered` orders) — `ConfirmDialog` →
  `approval` message → order flips to `complete` → automatic chain into
  the rating prompt for the buyer.

### Reputation — four-axis ratings
Reviews live in `reviews/{orderId}_{reviewerId}` with a deterministic id, so
each (order, reviewer) pair has at most one document. The rule pins
`amountSol` and `listingId` from the parent order, so aggregates run on the
reviews collection alone.
- **Four axes** (whitepaper §7): `scope`, `communication`, `timeliness`,
  `quality`; 1–5 each via `RatingStars` selector in `RatingDialog`. Optional
  comment ≤ 500 chars.
- **Both sides rate** — buyer rates seller, seller rates buyer. The buyer's
  prompt fires automatically on approval; the seller picks it up via the
  persistent "Rate buyer" CTA on the thread.
- **Aggregate** — `Σ(meanOfAxes × amountSol) / Σ(amountSol)` overall, plus
  per-axis weighted averages. Weighting by deal size means a single
  high-value contract counts more than a flurry of small ones.
- **Where it surfaces** — the public profile pages
  (`ReputationSection`: overall score, per-axis breakdown, last 5 reviews,
  total settled SOL) and inline on the listing detail page (per-listing
  aggregate).
- Reviews are gated to `order.status === "complete"` and
  `revieweeId !== reviewerId`, both at the rule level and in the service.

### Disputes
One dispute per order (`disputes/{orderId}` — deterministic id, double-filing
is rejected by the rule's create branch).
- **File from the thread** — buyer or seller, gated by order status (`paid`
  or `delivered`); seller can only file on `delivered`. `DisputeDialog`
  collects a free-text reason (≤ 2000 chars).
- **Effects** — order remains in its current status; deliveries, approvals,
  and revisions are blocked from the UI while the dispute is open. Banner
  shown on the thread.
- **Arbitration panel** (`/admin/disputes`) — gated by
  `roles/{uid}.role === "arbiter"`; the `ArbiterGate` component shows a
  loading skeleton, a 403 card, or the panel based on the tri-state hook.
  Provisioning arbiters is admin-only via firebase-cli
  (`firebase firestore:set roles/<uid> '{"role":"arbiter"}'`).
- **Decision dialog** (`OutcomeDecisionDialog`) — three outcomes
  (`release_to_creator`, `refund_to_brand`, `split` with a 0–100 % creator
  share slider) plus a required arbiter note (≤ 2000 chars).
- **Resolved state** — banner switches green on the thread; dispute summary
  appears in `DisputeOutcomesSection` on both parties' public profiles.
- **Pending settlement flag** — outcomes that need fund movement
  (`refund_to_brand`, `split`) display "Settlement pending the on-chain
  escrow program" until the Anchor program in `../adler-program` ships.

### Notifications
Server-only writers (Cloud Functions); clients can read their own and flip
`read: true`. Source: `notifications/{id}` keyed off
`recipientId == auth.uid`.
- **Kinds** — `application_received`, `application_decided`, `order_state`,
  `thread_message`, `dispute_filed`, `dispute_resolved`, `system`.
- **Surfaces** —
  - `/notifications` long-form list with mark-all-read.
  - Sidebar **bell** popover (`NotificationsBellButton`) — last 8, unread
    count badge, mark-all-read button, link to the long-form view.
  - Sidebar inbox row carries a separate unread-thread badge.
- **Email** — `onNotificationCreateEmail` Cloud Function watches
  `/notifications/{id}` creates, resolves recipient email through Privy
  admin, and writes `/mail/{auto}` for the
  `firebase/firestore-send-email` extension to dispatch via SMTP. Per-kind
  templates with subject + CTA; gated on `preferences/{uid}.notifications[kind]`.
- **Per-kind preferences** at `/settings/notifications`
  (`preferences/{uid}` doc with a boolean per kind; missing doc =
  everything on). Optimistic UI on toggle.

### Wallet (creator-only page)
- **Embedded Solana wallet** auto-provisioned by Privy on first sign-in.
  `walletAddress` is mirrored onto the profile so other users can pay it.
  Fallback `CreateSolanaWalletButton` for accounts that signed up before
  the embedded-wallet flag was enabled.
- **Balance card** — live SOL balance via `getSolBalance`, refetch on focus,
  staleTime 30 s.
- **USD price** — CoinGecko `/simple/price?ids=solana&vs_currencies=usd`,
  staleTime 60 s. Shown alongside SOL balance.
- **Send** — `SendDialog` collects address (validated via `new PublicKey()`)
  and amount, reserves a `0.001 SOL` rent + fee buffer, then `transferSol`
  builds a `SystemProgram.transfer` and routes it through Privy's
  `signAndSendTransaction` against the Wallet Standard chain
  (`solana:devnet` / `solana:mainnet`).
- **Receive** — `ReceiveDialog` shows the address with copy button + a QR
  code rendered by `qrcode.react`.
- **Recent transactions** (`WalletActivityList`) — last 20 sigs from
  `getSignaturesForAddress`, parsed for net SOL delta + counterparty +
  fee + status; rows link to Solana Explorer (`txExplorerUrl` cluster-aware).
- **Devnet airdrop** (`requestAirdrop`) — only enabled on devnet/testnet;
  surfaces the signature even if confirmation times out so the user can
  check Explorer.
- **Sales / Purchases summary** cards on the wallet page link to dedicated
  history views.

### Sales (creator-only)
`/wallet/sales` — orders placed against the user's services. Each row shows
status, amount, counterparty, and a primary CTA that routes into the order
thread:
- `paid` → "Open thread to deliver"
- `delivered` → "Open thread to approve" (buyer side, but seller can still
  see waiting state)
- `complete` + no review yet → "Rate buyer"

### Purchases (creator-only — buyers can be on either side)
`/wallet/purchases` — services the user has bought. Same row pattern:
- `paid` → waiting on seller to deliver
- `delivered` → "Open thread to approve"
- `complete` + no review yet → "Rate seller"

### Spend (brand-only)
`/spend` — KPI dashboard for brand purchases.
- **Three stat cards**: total settled (SOL + count), last 30 days, in-flight
  (paid + delivered, awaiting approval).
- **Recent purchases** (last 5) with link to full `/wallet/purchases`.
- Awarded gigs will roll up here once gig escrow ships.

### Order state machine
Source of truth: `match /orders/{orderId}` block in `firestore.rules`.

```
pending → paid       (buyer claims payment, provides txSignature)
pending → failed     (buyer aborts after createOrder)
paid    → delivered  (seller submits deliverable)
delivered → complete (buyer approves)
```
- `txSignature` is append-only — once set, it cannot change.
- `feeSol` is recorded on the order at create time so billing roll-ups
  don't need a second join.
- Denormalized buyer/seller snapshots and listing snapshot are written at
  create time; updates can only mutate `status`, `txSignature`, and
  `updatedAt` (rule-enforced).

### Buy flow (interim, pre-escrow)
1. Brand opens a service, clicks **Buy**.
2. `createOrder` writes `orders/{id}` in `pending`, with computed `feeSol`.
3. `transferSolWithFee` builds **a single transaction** with two
   `SystemProgram.transfer` instructions:
   - 99.5 % to seller wallet,
   - 0.5 % (50 bps) to `FEE_TREASURY_ADDRESS` (`44B9k…iS3` or env override).
   Fee is computed in lamports with floor rounding.
4. Privy signs and sends; `markOrderPaid(orderId, txSignature)` flips the
   doc to `paid`.
5. `createOrderThread` opens the order thread (best-effort; recoverable
   from the order doc later if it fails).
6. Toast offers "Open thread" or "View tx" on Explorer.
7. On any throw, `markOrderFailed` flips the doc to `failed` so it doesn't
   sit pending.

This direct-transfer-with-fee will be replaced by an Anchor escrow program
(see [`../adler-program/TODO.md`](../adler-program/TODO.md)) — the program
holds the budget for the duration of the contract and releases on approval
or auto-timeout.

### Settings
Tab-rail layout (`Profile` | `Notifications` | `Account` | `Billing`).
- **`/settings/profile`** — basics (display name, bio, avatar, country),
  Creator section (niches, portfolio, socials, DM contact), Brand section
  (company name, industry, website, DM contact). Sticky `SaveBar` at the
  bottom; `DirtyFormsContext` blocks navigation away from unsaved changes.
- **`/settings/notifications`** — per-kind toggles grouped into Orders,
  Messages, Applications, Disputes, System. Optimistic mutation, dotted-path
  Firestore writes (`notifications.<kind>: bool`).
- **`/settings/account`** — read-only identity card (username, email,
  wallet address), sign-out section, danger-zone delete-account section
  with `DeleteAccountDialog` (typed-name confirmation, chains into signOut
  and `/sign-in` on success).
- **`/settings/billing`** — protocol-fee history powered by
  `feeHistoryStats(buyerOrders, sellerOrders)`:
  - Total fees (SOL + count of settled orders),
  - Last 30 days,
  - Total contract volume across both roles,
  - Up to 20 most recent settled orders with per-order fee, role, and link
    to the order thread.
  Copy explicitly anchors on whitepaper §6/§8: 0.5 % per settled contract,
  no subscriptions, no listing fees.

### Marketing
- **Landing page** (`app/page.tsx`) — `IntroLoader` + `Nav` + sections
  (`Hero`, `HowItWorks`, `ForCreators`, `ForBrands`, `Reputation`, `FAQ`,
  `FooterCTA`) + `Footer`.
- **Waitlist email capture** (`WaitlistForm`) — writes to a Firestore
  collection via the public Firebase client.
- **Whitepaper** (`/whitepaper`) — 15-section v0.1 doc (Summary, Problem,
  Solution, How it works, Architecture, Payments, Reputation, Economics,
  Disputes, Market, Why Solana, Competition, Roadmap, Risks, Contact).
  Targets investors. Anchor links from in-app billing and dispute copy
  point into the relevant whitepaper sections.

### Theme
- Light / Dark / System toggle (`next-themes`), scoped to
  `app/(app)/(home)/*`. Marketing landing, auth screens, and the mobile
  gate always render light.
- Dark mode flips Tailwind's `neutral-*` palette via a CSS cascade in
  `globals.css` — `--color-neutral-50` becomes the value of
  `--color-neutral-950` and vice versa, with `neutral-500` as the unchanged
  midpoint. Brand accents (`accent-pink`, `accent-cyan`, `accent-lime`,
  `accent-orange`, `status-error`) stay constant.

## Data model (Firestore collections)

| Collection | Doc id | Description |
|---|---|---|
| `profiles/{uid}` | uid | Identity + creator/brand sub-profiles + denorm role flags |
| `usernames/{slug}` | slug | Reservation pointing to `userId` (lowercased handle) |
| `services/{id}` | auto | Service listings (creator-owned) |
| `gigs/{id}` | auto | Gig listings (brand-owned) |
| `gigApplications/{id}` | `${gigId}_${creatorId}` | One application per (gig, creator) |
| `orders/{id}` | auto | Brand→creator service orders, with txSignature + feeSol |
| `threads/{id}` | `${kind}_${parentId}` | Application or order conversations |
| `threads/{id}/messages/{messageId}` | auto | Thread messages (text, deliverable, revision_request, approval, system) |
| `reviews/{id}` | `${orderId}_${reviewerId}` | Four-axis ratings, one per (order, reviewer) |
| `disputes/{id}` | `${orderId}` | One dispute per order, deterministic id |
| `notifications/{id}` | auto | Per-recipient feed, server-write only |
| `preferences/{uid}` | uid | Per-kind notification toggles |
| `roles/{uid}` | uid | Arbiter provisioning (admin-write only) |
| `mail/{auto}` | auto | Outbox for the `firestore-send-email` extension |

Document shapes are mirrored verbatim in `lib/types/*.ts`; each type file
points back at the canonical rule range in
`../adler-app/firestore.rules`. Components never touch Firestore SDK
directly — every read/write goes through `lib/services/*Service.ts`.

## End-to-end flow

1. **Sign up** at `/sign-in` via Google OAuth (Privy). Embedded Solana
   wallet provisioned automatically.
2. **Bridge** to Firebase Auth — `mintFirebaseToken` Cloud Function returns
   a custom token with `uid === privyUserId`. `ensureProfileExists` runs
   transactionally to seed `profiles/{uid}` and reserve the username slug.
3. **Onboarding** — first-time users see the 3-slide intro at `/intro`
   (Welcome / Wallet / Devnet); Skip is allowed.
4. **Profile setup** — `/browse` opens with `ProfileGate` overlays the
   inline setup dialog if neither Creator nor Brand sub-profile is filled
   in. Other role-locked routes do the same.
5. **List or search** —
   - Creators publish services via the dialog on `/services` and apply to
     gigs they discover on `/browse`.
   - Brands publish gigs on `/gigs/new` and browse the creator directory
     at `/creators` (cold DM via published channels).
6. **Match** —
   - Service path: brand opens a creator's listing, clicks Buy → atomic
     99.5 / 0.5 split transfer → `paid` order + order thread.
   - Gig path: creator applies → `gigApplications` doc + application
     thread seeded with pitch → brand reviews `/applicants`, advances
     `pending → shortlisted → awarded` (or `rejected`).
7. **Deliver** — seller posts a `deliverable` message in the order thread
   with up to 5 attachments → order flips `paid → delivered`.
8. **Approve / revise / dispute** —
   - Approve: buyer confirms → order flips `delivered → complete` →
     auto-prompt rating dialog.
   - Revise: buyer fires `revision_request` (max 2). Third click reroutes
     to the dispute path.
   - Dispute: either side files via `DisputeDialog`; buyer or seller. UI
     locks deliveries/approvals/revisions until an arbiter resolves.
9. **Rate** — both sides post four-axis ratings (scope, communication,
   timeliness, quality) plus an optional comment. Aggregates surface on
   the public profile and (per-listing) on the listing detail.
10. **Settle the books** — `/settings/billing` shows protocol-fee history;
    `/wallet`, `/wallet/sales`, `/wallet/purchases`, and `/spend` show the
    on-chain side per role.

## What role Solana plays

Solana is **the settlement layer and the (eventual) identity layer**.

### Today (shipped)
- **Wallet** — every Adler account gets a Privy-managed embedded Solana
  wallet. No browser-extension install, no seed phrases. Address is on
  the profile so other users can discover and pay it.
- **Native SOL payments** — send and receive from the in-app wallet page,
  signed by the Privy wallet via `signAndSendTransaction` against the
  Wallet Standard chain (`solana:devnet` / `solana:mainnet`).
- **Service buys with protocol-fee split** — `transferSolWithFee` packs
  seller transfer (99.5 %) and treasury transfer (0.5 %) into one atomic
  transaction. `Order.feeSol` records the lamport-floor split so the
  billing roll-up is exact.
- **RPC routing** — reads and writes go through Firebase Cloud Functions
  RPC proxies (`solanaRpcProxyDevnet` / `solanaRpcProxyMainnet`) so we
  don't leak a third-party RPC key to the client. Network is selected via
  `NEXT_PUBLIC_SOLANA_NETWORK` (defaults to `devnet`); `testnet` is also
  recognised.
- **Service prices and gig budgets are denominated in SOL** at the
  data-model level (`priceSol`, `budgetSol`) — fiat is not a first-class
  unit anywhere in the schema. The wallet page enriches the SOL display
  with USD via CoinGecko purely for legibility.
- **Explorer integration** for transaction signatures and addresses (cluster
  aware) so any payment is independently verifiable.
- **Devnet airdrop helper** for testing.

### Next (whitepaper, not yet on-chain)
- **Escrow program** (in sibling `../adler-program`). A Solana program holds
  the brand's budget for the duration of a contract. Funds release on
  brand approval or auto-timeout — replacing today's direct transfer with
  trust-minimized settlement and unlocking dispute outcomes that require
  fund movement (refund, split).
- **On-chain reputation** — post-settlement four-axis ratings written to
  Solana so scores are portable (any other marketplace on the same graph
  can read them), tamper-proof (no review-bombing), and not held hostage
  by Adler. Mintable only after a settled contract — that's what makes the
  score meaningful.
- **Mainnet cutover** — devnet today; mainnet-beta when escrow + reputation
  ship. Network is a single env flag flip.

### Why Solana specifically
- **~400 ms finality** — payment clears before the follow-up email would
  send.
- **Sub-cent fees** — micro-briefs and tip-level amounts are economically
  viable, which they are not on EVM L1s or card rails.
- **Wallet Standard + Privy embedded wallets** — non-custodial UX without
  forcing a Phantom install on every creator.

The thesis: a UGC marketplace only works if creators can be paid the moment
work is approved, brands can verify what they're paying for, and reputation
follows the person rather than the platform. Solana's latency, fees, and
wallet ergonomics are what make all three of those viable in one product.
