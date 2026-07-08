# Leadey — Pricing & Packaging Analysis

> A from-scratch pricing strategy grounded in a full inventory of what Leadey
> does and what it costs to run. Three levers: **per-seat plan price (× 3
> tiers)**, **usage markup on Twilio (currently 2×)**, and the **action-credit
> system (1 credit = $0.01, considered final)**.
>
> Source of truth for the numbers below: `src/lib/credits.ts`, `src/lib/stripe.ts`,
> `src/routes/admin.ts`, `src/routes/billing.ts`. Anything marked **VERIFY** is
> not encoded in the codebase and must be confirmed against the live provider.

---

## 0. Confirmed facts (from code)

| Thing | Value | Source |
|---|---|---|
| Credit unit price | **$0.01 / credit** (strict, no bonus) — *final* | `lib/credits.ts:18`, `lib/stripe.ts` |
| Phone enrichment | **33 credits = $0.33** | `lib/credits.ts:10-15` |
| Email enrichment | **3 credits = $0.03** | `lib/credits.ts` |
| Company enrichment | **3 credits = $0.03** | `lib/credits.ts` |
| Job scrape | **1 credit = $0.01** | `lib/credits.ts` |
| Top-up packs | 1k / 5k / 10k / 25k / 50k credits (min 500) at 1¢ | `routes/credits.ts` |
| Twilio markup | **2×** on voice, SMS, number rental (admin-overridable 1–10×) | `routes/admin.ts:2707` |
| Telephony buffer | **+20%** prepaid float | `organizations.telephony_buffer_pct` |
| Transcription bill | **$0.02 / min flat** (not ×2) | `routes/admin.ts:2711` |
| Number rental base | ~$1.15/mo (live-synced) → **~$2.30 billed** | `routes/calls.ts`, `lib/twilio-cost-sync.ts` |
| Current seat prices | Starter **£49** · Growth **£69** · Scale **£99** /seat/mo (repriced Jul 8 2026; was 49/79/139) | `routes/admin.ts:53-57`, `routes/billing.ts:101-105` |
| Trial | **60 days** | `routes/webhooks.ts` (org.created) |

**Enforcement reality today:** seat limits (invite path) and the credit wallet
are *actually enforced*. Plan feature-gates (funnels/phone-lines/recording/AI)
are **displayed but never checked**, and `planGuard` is mounted on only 2 of
~30 routers. The packaging in this doc is a **product/pricing decision**;
making it technically enforced is the separate work list in §9.

---

## 1. Full feature inventory (what we're pricing)

**Core CRM & data** — leads, universal company profiles, cross-source
contact/person identity, smart views / saved filters, custom fields, lead
statuses & tags, tasks + reminders, lead documents, CSV import. (Org data
capped at 20k rows in the company/lead master queries.)

**Outreach channels** — Email (connect Gmail / Outlook / SMTP, sending domains
& mailboxes, inbound polling, open tracking, templates with links +
attachments, composer), SMS (Twilio), WhatsApp (Meta Cloud API), LinkedIn
automation (Unipile — connection requests + messages, rate-limited), and a
unified multi-channel **Inbox**.

**Calling / telephony** — phone-line provisioning (+ regulatory bundles),
inbound/outbound calling, **power dialer** (sessions, dispositions with funnel
actions, voicemail drop, answering-machine detection, per-step disposition
rules), **call recording**, **local presence** (auto area-code-matched caller
ID), recordings library.

**Automation** — multi-step campaigns/sequences and a **visual workflow builder
+ engine** (nodes: email / SMS / WhatsApp / LinkedIn / call, wait, wait-for-
event, condition, A/B split, change status, add/remove tag, update field,
assign owner round-robin, **webhook**, goal/exit).

**Pipeline** — opportunities kanban + list, multiple configurable
pipelines/stages, win/lost, owner assignment, drag-reorder, forecast values.

**Lead discovery & enrichment** — job/hiring scrapers (TheirStack, LinkedIn,
Indeed, Glassdoor, Greenhouse, Lever), buying **signals** + relevance scoring,
**ICPs**, DNC suppression, **enrichment** (phone / email / company via
BetterContact) — all credit-metered.

**AI** — call transcription (AssemblyAI), AI call summaries + outcome
classification + speaker inference (OpenAI gpt-4o-mini), **AI assistant**
(gpt-4o with org tools + web search), signal scoring, call scripts.

**Team & governance** — invite/remove members, built-in roles
(admin/manager/member/viewer) + **custom roles with per-capability & per-user
overrides**, departments, granular RBAC, org-membership enforcement.

**Platform** — **public REST API (/v1) + API keys** (leads/companies/contacts/
campaigns), **webhooks**, Mintlify developer docs, integrations (Calendly,
calendar sync, LinkedIn/Unipile).

**Analytics** — cockpit dashboard, campaign analytics, email performance,
**team analytics** (own vs all scope), exports.

Plus **knowledge base**, **notifications** (email/Slack alerts), and an internal
**admin panel** (ops/invoicing — not a customer tier).

**Natural tier signals (upsell levers):** power dialer · call recording + AI
summaries/transcription · workflow automation + webhooks · WhatsApp/LinkedIn
channels · local presence + multi-number · team analytics · custom roles/RBAC ·
public API + webhooks · enrichment volume (credits) · funnel/pipeline/seat
counts · export.

---

## 2. Cost basis (our unit economics)

| Cost item | Our cost | Billed to customer | Gross margin |
|---|---|---|---|
| Action credit (enrichment/scrape) | provider cost **VERIFY** (BetterContact / TheirStack) | $0.01/credit → phone $0.33, email $0.03, company $0.03, job $0.01 | Healthy on phone if provider < ~$0.15; **email/job are thin** |
| Voice (per min) | real Twilio price (fallback $0.014/min) | **2×** | ~50% |
| SMS (per msg) | real Twilio price (fallback $0.0079) | **2×** | ~50% |
| Phone number / mo | ~$1.15 base (live-synced) | **2×** ≈ $2.30 | ~50% |
| Transcription / min | ~$0.007/min (AssemblyAI, 2 channels) | **$0.02/min flat** | ~65% |
| AI summary / call | ~$0.0015 (gpt-4o-mini) | bundled | absorbed |
| Recording storage | ~$0.0005/min/mo | bundled | absorbed |
| Seat (software) | ~fixed infra | £49–£149/seat | high |

**VERIFY before finalising** (no cost model in code): BetterContact per-lookup,
TheirStack per-job, Unipile per connected account (LinkedIn), Meta WhatsApp
per-conversation, Resend email, Cloudflare R2 $/GB. The credit prices are the
**customer price, not our cost** — confirm provider costs to lock margin,
especially **email enrichment ($0.03)** and **job scrape ($0.01)**.

---

## 3. Competitive benchmark (per seat/mo)

- **Close** ~$99–$139 (dialer + CRM) · **Outreach / Salesloft** ~$100–$165 ·
  **Apollo** $49–$99 (data-led) · **HubSpot Sales** $90–$150 ·
  **lemlist / Instantly** $30–$60 (email-only).
- Leadey spans **all of these** (multichannel outreach + dialer + AI +
  enrichment + CRM + automation). Position the flagship tier in the
  Close/Outreach band, with an email-first entry tier competing with
  lemlist/Apollo.

---

## 4. Recommended model

**Price = per-seat plan (software) + usage passthrough (telephony at 2×) +
prepaid credits ($0.01) for data/enrichment.** Keeping the three levers separate
lets the seat price stay competitive while usage and enrichment scale with
consumption (enrichment-heavy customers self-fund).

- Billing: monthly or **annual = 2 months free** (pay 10).
- Min seats: Starter 1 · Growth 1 · Scale 3.
- Currency: **GBP** primary (UK org); telephony already bills in USD (≈ ×1.27).

### 4.1 Seat price (× 3 tiers)

| Tier | Recommended | Current | Rationale |
|---|---|---|---|
| **Starter** | **£49** /seat/mo | £49 | Email/SMS-light outreach + CRM. Accessible entry vs lemlist/Apollo. Keep. |
| **Growth** | **£89** /seat/mo | £79 | Flagship — adds dialer, calling, AI, WhatsApp/LinkedIn, workflows, pipelines, team analytics. Close/Outreach-class value below their price. |
| **Scale** | **£149** /seat/mo | £139 | Everything + API/webhooks, custom roles/RBAC, local presence, unlimited funnels/pipelines, advanced analytics/exports, priority support. |

> If you'd rather not change prices, keep **£49 / £79 / £139** and adopt only
> the packaging (§5) + enforcement (§9) — the packaging is the bigger win. The
> £10 Growth/Scale uplift is optional but well-supported by the bundled dialer
> + AI.

### 4.2 Included monthly credits & phone lines (per seat)

| | Starter | Growth | Scale |
|---|---|---|---|
| Included credits/seat/mo | 200 *(consider 300)* | 1,000 | 3,000 |
| Phone lines | 0 (no calling) | up to 5 | unlimited + local presence |

(Matches the current per-plan grants in `lib/stripe.ts`.)

---

## 5. Feature-by-plan matrix

| Capability | Starter £49 | Growth £89 | Scale £149 |
|---|:--:|:--:|:--:|
| Leads / companies / contacts, smart views, custom fields, tasks, CSV import | ✅ | ✅ | ✅ |
| Email (Gmail/Outlook/SMTP, templates + links + attachments, open tracking, inbox) | ✅ (2 accts) | ✅ (5 accts) | ✅ (unlimited) |
| Campaigns / sequences | ✅ (3) | ✅ (10) | ✅ (unlimited) |
| SMS | — | ✅ | ✅ |
| WhatsApp (Meta) | — | ✅ | ✅ |
| LinkedIn automation (Unipile) | — | ✅ | ✅ |
| Power dialer (dispositions, voicemail drop, AMD) | — | ✅ | ✅ |
| Phone lines / calling | — | ✅ (≤5) | ✅ (unlimited) |
| Call recording | — | ✅ | ✅ |
| AI transcription + summaries | — | ✅ | ✅ |
| Local presence (area-code caller ID) | — | — | ✅ |
| Opportunities pipeline | ✅ (1) | ✅ (multiple) | ✅ (unlimited) |
| Workflow automation (branching, delays) | — | ✅ | ✅ |
| Webhooks (in / out) | — | — | ✅ |
| Lead discovery / scrapers / signals / ICPs | — (enrich only) | ✅ | ✅ |
| Enrichment (phone / email / company) — credit-metered | ✅ | ✅ | ✅ |
| Analytics | own only | team-wide | advanced + exports |
| Roles | built-in | built-in | **custom roles / RBAC + departments** |
| Public API + API keys | — | — | ✅ |
| AI assistant | — | ✅ | ✅ |
| Knowledge base | ✅ | ✅ | ✅ |
| Support | email | priority | dedicated CSM + onboarding |
| Included credits / seat / mo | 200 | 1,000 | 3,000 |
| Min seats | 1 | 1 | 3 |

**Why the splits fall where they do**
- **Growth gate = calling + AI.** The dialer, telephony, recording and AI are
  the expensive, differentiated engine — and this matches the current config
  (Starter already ships with 0 phone lines, no recording, no AI). Starter is a
  clean email-first outreach + CRM tier.
- **Scale gate = platform & governance.** Public API + webhooks, custom
  roles/RBAC, local presence, unlimited funnels/pipelines and advanced
  analytics are the classic scale/enterprise levers.

---

## 6. Usage markup — Twilio (currently 2×)

- **Recommendation: keep 2× passthrough** on voice, SMS and number rental — a
  standard reseller telephony margin (peers run 1.5–3×), ~50% gross, fair as
  pure passthrough. Keep the **20% prepaid buffer** and the **flat $0.02/min
  transcription** (~65% margin — good).
- **Optional refinement:** on Growth/Scale, bundle a monthly minute/SMS
  allotment per seat (e.g. Growth 500 mins, Scale 2,000 mins) then 2× overage —
  bundling reads as more premium and smooths the bill. Pure 2× is simpler; both
  are defensible.
- **Watch-outs:** WhatsApp (Meta charges per 24-hour conversation) and
  LinkedIn/Unipile (per connected account) have **no cost model in code** —
  before scaling either channel, add a markup/credit line or fold the cost into
  the seat price, or margin leaks.

---

## 7. Credits system ($0.01/credit — final)

- **Keep 1 credit = $0.01** and the **33 / 3 / 3 / 1** action costs — clean and
  finalised. Grants scale per seat (200 / 1,000 / 3,000). Top-ups stay 1k–50k at
  1¢.
- **Margin safety action:** confirm real provider costs. Phone at $0.33 is
  comfortable if BetterContact < ~$0.15/lookup; **email ($0.03) and job ($0.01)
  are thin** — verify they cover provider cost + overhead, and if not, bump the
  **credit count** (not the $/credit), e.g. email 3 → 5 credits.
- Position credits as "usage fuel" separate from seats.

---

## 8. Example monthly bill (illustration)

**3-seat Growth team, moderate usage:**
- Seats: 3 × £89 = **£267**
- Telephony: ~2,000 outbound mins @ ~$0.028 (2×) ≈ $56 + 3 numbers ≈ $7 + 20%
  buffer ≈ **~$76**
- Credits: 3,000 included (3 × 1,000) + a 5,000 top-up = **$50**
- **≈ £267 + ~£100 usage/credits.** Predictable seat base; consumption scales
  with the customer.

---

## 9. What must be built to enforce this (packaging is cosmetic today)

Only seats + the credit wallet are enforced now. To make the matrix real:

1. **Centralise entitlements** in `src/lib/stripe.ts` `PLANS` — extend with the
   booleans in §5 (sms, whatsapp, linkedin, dialer, recording, aiSummaries,
   workflows, webhooks, localPresence, api, customRoles, scrapers,
   teamAnalytics, emailAccounts cap, pipelines cap).
2. **Enforce at the routers** (net-new): dialer/calling, phone-line
   provisioning cap, workflows, scrapers, API-key creation, custom-roles editor,
   funnel/pipeline/email-account caps — return a clear "upgrade" error (mirror
   the 403 pattern in `routes/team.ts` invite + `lib/plan-guard.ts`).
3. **Mount `planGuard()` on all write routers** (today only contacts +
   templates) so trial-expired / past-due / cancelled actually blocks writes.
4. **Reconcile copy:** 60-day trial (backend) vs "14-day"/"Free" (UI); DB
   `seatsIncluded` default 5 vs plan configs (1/1/1/3).
5. **Update the frontend** plans grid + `BillingInfo` to the new matrix; keep
   the Stripe per-seat `quantity` model (already wired).

---

## 10. Open decisions

- **Prices: DECIDED Jul 8 2026 — £49 / £69 / £99 shipped** (the owner chose a
  markdown rather than this doc's proposed uplift). The remaining open items
  below still stand. ~~Adopt the **£49 / £89 / £149** uplift, or keep £49/£79/£139 and~~
  change only packaging? *(Recommend the uplift for Growth/Scale.)*
- **Currency:** seats in **GBP** (current) vs USD.
- **Calling in Starter?** *(Recommend no — Growth gate; matches current config.)*
- **Bundled minutes** vs pure 2× passthrough on Growth/Scale.
- **Verify provider costs** (BetterContact / TheirStack / Unipile / Meta) to
  lock credit + channel margins.
