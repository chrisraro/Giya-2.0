# 03 — Loyalty benchmarks: what to copy, what to avoid

**Date:** 2026-08-01
**Method:** four parallel research streams (screen IA, user flows, PH market, complaints), ~30 sources, primary-source-first. Findings then checked against this repo's actual code.
**Angle:** what Giya can copy now, not a faithful teardown.

## Executive Summary

McDonald's is the wrong primary benchmark and the right secondary one. Its screen craft is worth stealing outright; its *architecture* is the source of its most-hated failures, and Giya has already avoided the worst of them by accident of design. The real competitor is **ZAP**, a PH loyalty incumbent since 2013 that has anchored merchant-funded SME loyalty at 5 to 20 percent cashback, with no consumer app at all.

Three findings change what we should build next. First, **Giya already solves McDonald's single most damaging bug** — points debited on intent and never returned — because `claim_reward` reserves and `expire_claims` reverses. Second, **Giya has imported McDonald's single worst operational failure**: redemption requires both parties online, and PH SME connectivity is worse than a US McDonald's. Third, **the rewards screen does not read the consumer's balance at all**, so an unaffordable reward looks tappable and fails on tap, which is worse than the app we are learning from.

The contrarian evidence is serious and should shape the pitch rather than be dismissed: peer-reviewed work going back to Dowling and Uncles (1997) and Ehrenberg-Bass's Double Jeopardy law says loyalty is an *output* of market share, not an input a small merchant can manufacture. Points probably do not create loyalty at SME scale. That does not kill the product, but it means the thesis must rest on something else.

## Key Findings

### 1. We already beat McDonald's on their worst bug, but only halfway

McDonald's debits points when a customer *attaches* a reward, not when they receive it. Every downstream failure — frozen app, broken machine, cancelled order — takes the points and delivers nothing, and their support's ledger frequently disagrees with the customer's screen. This produces the word "scam" in roughly 9 to 10 percent of loyalty-mentioning low-star reviews across all three storefronts examined, the most consistent cross-market signal in a 2,583-review corpus.

`claim_reward` (0013) debits at claim time and `expire_claims` (0016) writes a `reversal` row restoring both the balance and the inventory. So the reserve-and-release semantic exists.

**The gap:** release only happens on the expiry sweep. There is no consumer-facing cancel. A mis-tapped claim locks those points for the full claim window. Fix: let a consumer release an unredeemed claim, reusing the existing reversal path rather than writing a second one.

### 2. Online-only redemption is our biggest inherited risk

The most common complaint in the corpus is not a loyalty mechanic at all. It is that the app fails *at the counter*: 14 percent of low-star reviews describe failure specifically in-store, in the drive-thru, or in line. One UK reviewer diagnosed the fix unprompted: *"Why not use a static code like most loyalty companies?"*

Giya's `token.ts` mints a redemption jti in Redis and `validate_redemption` checks it server-side. Both parties must be online, at a counter, with a queue behind them, in a market where prepaid data is roughly 92 percent of the SIM base.

This was the right call for replay safety and is documented as deliberately fail-closed. But it means our redemption inherits the exact failure that dominates McDonald's complaints, in a harsher environment. Worth designing an offline-verifiable path: a signed token the phone can display without connectivity, reconciled when the merchant's device reconnects.

### 3. The rewards screen does not know what the consumer can afford

`/rewards` calls `listClaimableRewards()` and `listMyClaims()` and never reads a balance. `reward-card.tsx` disables only on `claimed || outOfStock`. So a reward the consumer cannot afford renders identically to one they can, invites a tap, and fails with `POINTS_INSUFFICIENT`.

McDonald's handles this better and their pattern transfers directly:

- **Show the whole catalogue, greyed, never hidden.** The catalogue is the motivation. Most of our users will spend most of their time unable to afford anything, so this screen's job is to make saving feel worthwhile.
- **Lock and cost on the group header, not per card** (`🔒 1500 pts` governing a row). Scannable, and it scales.
- **State the shortfall numerically.** McDonald's says "Not enough points" and truncates it. We should say "1,222 points to go", because the number is the motivation and the qualitative version is just a refusal.

One thing to avoid: their progress rail is anchored to the *top* tier, so a user with 278 of 6,000 points sees a 4 percent bar. It was publicly mocked. **Anchor progress to the next reachable reward, not the maximum.**

### 4. Launch stingy: McDonald's PH devalued 25 to 50 percent within a year

| Reward | Aug 2025 | Aug 2026 | Change |
|---|---|---|---|
| Medium Fries | 100 | 150 | +50% |
| 1-pc Chicken McDo | 150 | 200 | +33% |
| Big Mac | 200 | 250 | +25% |

The best-capitalised QSR in the country mispriced its launch generosity and clawed it back within twelve months, drawing real backlash. The US and UK ran parallel devaluations in 2026.

PH earn-rate benchmarks: mass-market retail sits at 0.5 to 2 percent (SM Advantage ~0.5%, CLiQQ ~1%, Globe ~2%); food and beverage at 5 to 8 percent (Starbucks PH ~7-8%, McDonald's PH ~5-8%); **ZAP, our closest structural analogue, anchors merchant-funded SME loyalty at 5 to 20 percent**.

The seeded demo shop was configured at 2 points per peso against a PHP 145 reward costing PHP 125 of spend — a loss on every redemption. The implied-spend sentence now on the reward form exists to make that visible, but the default the product *suggests* should sit near 5 percent, not above it.

### 5. Expiry must be checked against the median customer, not the policy

McDonald's gets away with 6-month expiry and a 1,500-point floor because people visit weekly. Their own users still hit the trap: *"makes your points expire, even when you don't have enough points to redeem a reward."*

Our 12-month policy matches PH norms exactly (McDonald's PH 12 months, Shopee 3 months, Globe an annual cliff, GrabCoins 6 months) and is more generous than McDonald's US. But the arithmetic that matters is: **can a median customer, at their real visit frequency, reach the cheapest reward before their earliest points expire?** If not, the programme is mathematically a trap and users will use the word scam. That calculation needs real merchant data before enforcement ships.

Also worth stealing: the UK app shows **per-lot expiry dates in a history view**, and UK expiry complaints run roughly a tenth of the US rate. Our wallet shows a balance; it should be able to show what expires when.

### 6. The market gap is real, and so is the reason it is empty

No one in the Philippines does receipt-photo loyalty for SMEs. The four SME platforms — ZAP, GoBalik, StampBayan, RUSH — all use merchant-side capture, and compete explicitly on counter friction and "no app download required". The only PH receipt-scanning app at scale is **Snapcart** (1M+ installs), which is a market-research company selling FMCG shopper data, and which **explicitly rejects handwritten receipts** and limits to groceries, pharmacies and department stores.

Its reviews name our opening directly: *"a lot keeps getting rejected because it is 'not from a grocery, pharmacy or department store'."*

Two reasons the gap exists, and both are ours to solve:

- **Handwritten BIR booklets.** Accepting them is simultaneously the moat against Snapcart and the hardest OCR and fraud problem we have.
- **The industry believes requiring a consumer app download is fatal.** Every competitor optimises for no-install. We require both an install and a photograph.

Also: **Jollibee killed its cross-brand points programme in October 2024 and has not replaced it.** `jollibee.com.ph/rewards` is a 404. The largest QSR group in the country has vacated loyalty.

### 7. The BIR threshold is the biggest un-validated risk

The EOPT Act and RR 7-2024 made the Invoice the primary sales document from April 2024. Critically, **non-VAT sellers are only required to issue one for single transactions over PHP 500**, or on request.

A PHP 120 carinderia meal or a PHP 90 milk tea may legally come with no document at all. That is precisely our target basket size. **This is a bigger risk to the model than OCR accuracy, and it is a field question, not an engineering one.**

Timing is otherwise favourable: the BIR e-invoicing mandate covers large taxpayers only, with a 31 December 2026 deadline, so paper stays the norm for our segment for years.

## Detailed Analysis

### Flow patterns worth copying, none of which need POS integration

1. **Two representations of one token: a QR *and* a short typed code.** McDonald's documents the spoken code as an official fallback, not a hack. For a shop with a cracked phone camera this will be the primary path more often than expected — design it first.
2. **Select the reward before reaching the counter.** Never let browsing happen in the queue. Giya already does this.
3. **One token does everything** — identity, earning, redemption.
4. **The merchant sees only what they must act on**, never the balance. McDonald's states twice in crew training that crew cannot see points, specifically to kill counter disputes. Giya's `validate_redemption` already returns just the reward and consumer name.
5. **Two-register expiry copy**: relative when imminent ("Expires today"), absolute when distant ("Expires 21/10/2025"). Grey, last line, smallest type. Urgency without pressure.
6. **Deal rows omit price and CTA** — thumbnail, category eyebrow, clamped title, constraint, expiry. Decision detail lives in the sheet.
7. **Design the card to survive a bad photo or none at all.** Independent shops have no studio photography. A European McDonald's build proves flat illustration plus title reads fine.

### The receipt-claim abuse controls are a free playbook

Two independent operators converged on nearly identical throttles, which is strong evidence they are load-bearing rather than arbitrary:

| Control | McDonald's US | Snapcart PH |
|---|---|---|
| Submission window | 7 days | 3 days |
| Rate cap | 1 receipt / 30 days | 5 receipts / day |
| Duplicates | one receipt, one claim | first uploader wins globally |
| Format | physical receipts only | printed only, handwritten rejected |
| Processing | 1 to 6 days, manual | manual review |

Giya's freshness window is 3 days, matching Snapcart. Note **Canada removed self-serve receipt claiming entirely and replaced it with a phone line** — strong evidence this path gets abused at scale, and a warning about where we are heading.

McDonald's also shows an **annotated receipt photo teaching users where each field is**. We need that more than they do.

### Staff turnover makes trained behaviour worthless

US fast-food turnover runs about 150 percent. Any redemption flow requiring crew *knowledge* decays to nothing within a year, and PH SME retail is no better. **Design so the correct action is the only available action, not the trained one.**

### PH structural constraints a US-shaped design would get wrong

A fifth research stream on PH mobile reality returned findings that change build decisions, not just copy.

**SMS links are effectively banned.** The NTC ordered telcos in September 2022, broadened September 2023, to block text messages containing clickable domains, URLs, shortener links and QR codes. Twilio's PH operator guidance states plainly that URLs are not permitted from domestic longcodes, shortened URLs are strictly not allowed, and unregistered sender IDs have been blocked since April 2025. Even a plain 6-digit OTP needs roughly two weeks of per-operator sender-ID registration with SEC/DTI documents and pre-approved templates.

**This does not bite us today** because Giya authenticates by email and OAuth, not SMS. It does mean SMS must never become the recovery path, and that the market has already moved elsewhere: GCash switched to in-app push OTP in June 2026 under BSP Circular 1213, which phases out SMS OTP for high-risk financial transactions by June 2026. Our users are being trained on push, not SMS.

**Phone numbers are unstable identifiers.** 54 million SIMs were deactivated in a single day in July 2023 when the SIM Registration Act grace period lapsed, and Filipinos carry roughly 1.67 SIMs each, swapping for promos. Never key identity on a phone number.

**The device floor is far lower than a Western baseline.** Transsion (Tecno, Infinix, itel) is the number one brand at about 36.6 percent of 2025 share, more than half of 2024 shipments were priced under 100 US dollars, and the average selling price fell to 179 dollars. The modal target device is a 3 to 4 GB RAM Unisoc or Helio phone, many on Android Go Edition, which caps background processes and ships a stripped WebView. Roughly a quarter of PH Android devices run Android 12 or older. Filipinos also self-select into Lite apps: **Facebook Lite is the number one social app in the Philippines**, ahead of full Facebook.

For a PWA this is the single most important engineering constraint on the consumer side. Bundle size and image handling are not optimisations here, they are adoption.

**Connectivity at the counter is worse than assumed, and malls are the worst case.** Malls reportedly run point-of-sale on 2G/3G and charge telcos prohibitive fees for in-building equipment or refuse it outright. 61 percent of digitally-active PH MSMEs cite poor or no internet as their most frequent difficulty with digital tools. Add roughly 20 tropical cyclones a year and current rotating brownouts affecting hundreds of thousands of Meralco customers.

This compounds finding 2: our redemption requires both parties online, at a counter, in the venue where connectivity is worst.

**Cash still dominates the counter, which validates the whole thesis.** Digital is 57.4 percent of PH retail payments by volume, but only **29 percent of point-of-sale payments**. The digital majority comes from P2P transfers and bills, not counter transactions. Every competitor that rides a payment rail or a POS terminal is structurally blind to the majority of transactions at a carinderia. Receipt capture is the only mechanism that sees cash.

**Randomness triggers a DTI permit.** Pure points-for-purchase may be exempt, but anything with an element of chance, a spin-to-win, a mystery reward, a raffle, requires a sales promotion permit filed at least 15 days ahead, capped at one year, with a DTI representative witnessing draws. That rules out the single most habit-forming pattern in PH consumer apps (Shopee and Lazada spin wheels and daily streaks) unless we take on per-campaign, per-merchant filings.

## Contrarian Views And Risks

Stated at full strength, because it targets this product specifically.

**Double Jeopardy.** Ehrenberg-Bass finds a brand's loyalty is a near-deterministic function of market share: small brands have fewer buyers *and* those buyers are less loyal. Loyalty is downstream of penetration. On this account a loyalty programme cannot lift a small merchant into big-brand loyalty metrics.

**Loyalty programmes recruit the already-loyal.** Dowling and Uncles (*Sloan Management Review*, 1997) concluded such schemes "do not fundamentally alter market structure and instead increase market expenditures without really creating any extra brand loyalty", and are "surprisingly ineffective" given their popularity. Peer-reviewed, long-standing, not overturned. The widely-quoted vendor statistics on the other side ("members spend 38% more") have an obvious fatal flaw: members are recruited *from* heavy buyers, so the comparison cannot establish causation.

**Gamification evidence does not transfer.** Meta-analytic effects come overwhelmingly from education and health, not commercial transactions, and attenuate past a semester as novelty decays.

**Even the celebrated positive result is mostly abandonment.** Nunes and Drèze's endowed-progress car-wash study hit 34 percent completion against a 19 percent control. The famous win means 66 to 81 percent of cards were abandoned.

**What must hold for this to be worth building:**

1. The category must have genuinely high purchase frequency. Coffee and carinderia, not furniture.
2. The cheapest reward must be reachable inside the expiry window by the *median* customer, not the top decile.
3. The merchant must get something their customers' habits do not already give them: data, a reactivation channel, or basket lift.
4. Redemption must not fail. Which returns to finding 2.

**The fair rebuttal:** these critiques target loyalty programmes as *growth* mechanisms for established brands. An SME platform may be selling payment-adjacent rails, customer records, a reactivation channel, and DTI-compliant promo infrastructure, with points as the user-facing wrapper. That is legitimate — but **the product thesis should not rest on "points create loyalty", because the best evidence says they mostly do not.**

## Open Questions

- **Do our target merchants reliably issue receipts at all?** The PHP 500 non-VAT threshold means our typical transaction may legally produce nothing. Field validation, not engineering.
- **Do we accept handwritten BIR booklets?** Simultaneously the moat and the hardest fraud problem.
- **RESOLVED: points expiry is legal.** RA 10962 (Gift Check Act 2017) bans expiry dates on gift checks but **explicitly excludes** "those under loyalty, rewards, or promotional programs, as determined by DTI" (Supreme Court E-Library; DTI DAO 19-03 s.2019). Our 12-month policy is on solid ground. Caveat: if we ever issue anything resembling stored value OUTSIDE a loyalty programme, no-expiry applies and penalties run PHP 500,000 to 1,000,000.
- **Does a perpetual loyalty programme need a DTI sales promotion permit?** The framework's 30-days-before-start structure implies defined periods and the sources reached do not address ongoing programmes. McDonald's PH cites permit numbers on its rewards pages. **Needs counsel, and if a permit is required per merchant, it belongs in the onboarding flow.**
- **Real PH basket sizes** for carinderias and cafes. Only forum-grade figures found; likely skewed high.
- **PH smartphone and data reality** — dominant devices, whether uploads are deferred to free WiFi. Gates the camera and upload design.
- **Any published PH loyalty adoption or redemption rates.** Genuine evidence gap; treat any such claim with suspicion.

## Sources

Full source lists with per-claim confidence are in the four research streams. Principal primaries:

- McDonald's crew training PDF (learningwebhost.mcd.com) — in-store sequence, crew cannot see balances
- McDonald's US Deals FAQ and Rewards FAQ — 15-minute code window, one reward per order, receipt recovery rules
- McDonald's UK rewards terms — per-batch expiry, reserve/commit semantics, rate caps
- mcdonalds.com.ph terms and app FAQ — PH earn rate, 12-month expiry, two-app split, DTI permit numbers
- Apple review RSS, 2,583 reviews across US/UK/PH storefronts — complaint frequencies
- BIR RMC 77-2024 and RR 7-2024 — invoice rules, PHP 500 threshold, required fields
- BSP 2024 E-Payments Measurement Report — 57.4% digital by volume
- zap.com.ph, gobalik.com, stampbayan.com — PH SME loyalty competitive set
- Snapcart help centre — receipt acceptance rules
- Dowling & Uncles, *Sloan Management Review* 1997; Ehrenberg-Bass Double Jeopardy; Nunes & Drèze endowed progress

**Explicitly unreliable:** a widely-ranking 2026 SEO listicle giving clean complaint percentages contradicts McDonald's own FAQ on how expiry works and reports figures roughly ten times what a 2,024-review sample shows. Not cited.

**Coverage gaps:** Reddit and Google Play were unscrapeable, so crew-side evidence is snippet-level and the PH picture skews to iPhone owners, likely understating performance complaints.

## Rerun Inputs

```
workflow: firecrawl-deep-research
topic: McDonald's app Deals and Rewards screens and flows, benchmarked for a PH SME receipt-scanning loyalty app
depth: thorough
output: markdown
```
