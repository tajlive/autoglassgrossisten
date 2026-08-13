# Arvet kunnskap (fra Arch Knowledge Graph)

Prosjekt autoglassgrossisten arver 12 lessons fra Arch sin kunnskapsbase.
Kilde: tajlive/KP .arch/knowledge/lessons/ · generert 2026-08-13.

---

# Lesson: Skannere må være språk-agnostiske og fixture-bevisste

**Regel:** Enhver Arch-detektor (stack, health, secret, CI-match) MÅ (1) gjenkjenne
manifest/test-runner på tvers av språk (pyproject.toml/pytest/Cargo.toml/go.mod — ikke bare
package.json/vitest/jest), og (2) klassifisere credential-lignende treff i test/eksempel/
fixture-filer og avkortede placeholders («...») som NOTE, ikke lekkasje.

**Hvorfor:** Generality-test på fastapi ga false «JavaScript / ingen test-runner / 6 critical
leaks». Se failure: `audit-v1-node-centric.md`.

**Sjekkliste:**
1. Språk: pyproject.toml/setup.py/requirements.txt (Python), Cargo.toml (Rust), go.mod (Go), ...
2. Test-runner: pytest/tox/conftest.py (Python), cargo test, go test — ikke bare vitest/jest/playwright.
3. Secret-scan: test/eksempel/fixture-stier + «...»-placeholders = note; aldri rapporter som lekkasje.
4. .env-gitignoret = N/A når prosjektet verken har .env-filer eller er Arch-styrt.
5. Verifiser på et reelt fremmedspråklig repo FØR det kalles «språk-agnostisk».

---

# Lesson: Multi-package + eksterne prosjekter er førsteklasse i alle Arch-skannere

**Regel:** Enhver scanner/detektor i Arch (stack, CI-match, health, secret) MÅ være
rekursiv over ALLE `package.json`/konfig-filer (med `node_modules`/`.git`/`.venv`/
`.wrangler`/`dist`/`allure-*` ekskludert), og MÅ behandle «ikke Arch-styrt prosjekt» som
NOT_APPLICABLE — ikke FAIL.

**Hvorfor:** Første eksterne kundeaudit ga false funn fordi skannerne var root-only og
Klarpakke/Arch-sentriske. Se failure: `audit-v1-root-only-scanning.md`.

**Sjekkliste ved ny skanner:**
1. Rekursiv over sub-kataloger (skip `node_modules`, `.git`, `.venv`, `dist`, `allure-*`).
2. `.arch/*`-sjekker = NOT_APPLICABLE for prosjekter uten `.arch/project.yaml`.
3. Totalscore aldri tvunget 0 for eksterne prosjekter — beregn over aktive kategorier.
4. Test-konfig: inkluder `playwright.config.*` (ikke bare vitest/jest) og sub-kataloger.
5. CI verktøy-match: respekter `working-directory` og sub-pakkenes `package.json`.

---

# Lærdom: skille B2B-grossist fra B2C-montør i website-audit

**Dato:** 2026-08-13
**Kontekst:** Full website-audit av auto-glass.no benchmarket mot carglass.no og bilglassgruppen.no

## Lærdom

**En nettbutikk-audit er ikke rettferdig uten å klassifisere forretningsmodellen først. B2B-grossist og B2C-montør-kjede har ulik suksessmålestokk og må ikke scores på samme akse uten forbehold.**

Auto-glass.no er en B2B-grossist (selger glass til verksteder, monterer ikke) — det samme er Bilglassgruppen (bilglassgruppen.no). Carglass.no og Riis Bilglass (bilglass.no) er montør-kjeder som selger til sluttkunde. Å sette alle i samme poengtabell og la Carglass «vinne» på booking-UX/SEO er misvisende: grossistene konkurrerer mot hverandre (auto-glass 69 vs bilglassgruppen 60) på rask, presis glass-identifikasjon og B2B-ordreflyt — ikke mot montørene på pen forbruker-booking.

## Konkrete grep

1. **Klassifiser før du scorer:** legg inn `forretningsmodell` (B2B-grossist / B2C-montør / B2C-tjeneste / produsent-distributør) som et eksplisitt felt i audit-konteksten FØR funn vurderes.
2. **Benchmark kun innenfor samme segment** — eller merk kryss-segment-sammenligninger eksplisitt («ikke direkte konkurrenter, ulik målestokk»).
3. **Vekt funnene etter modell:** for en grossist teller søk-/ordre-flyt og lager-status tyngre enn forbruker-UX; for en montør teller booking- og betalingsflyt tyngre.
4. **Rapporter til kunden med forbeholdet innebygd** — så kunden ikke leser «69 vs 81» som «vi taper mot Carglass», men som «vi er best i vårt segment på X, men henger etter teknisk på Y».
5. **Kartlegg hele verdikjeden:** produsent/distributør (Saint-Gobain Sekurit, Pilkington, AGC, Xinyi Glass, Fuyao Group — originalglass/ettermarked B2B) → grossist (Autoglass, Bilglassgruppen) → montør (Carglass, Riis Bilglass, Glassdrive). Å vite hvilket ledd kunden er i, avgjør hva som er «riktig» målestokk.

## Pitfall som ble fanget

- I første rapportutkast ble de tre satt i samme tabell uten segment-forbehold — «Carglass best (81), auto-glass i midten (69)». Tom korrigerte: «man må skille mellom b2b bilglassgrossist og Bilglassfirma som monterer bilglass.» Fikset ved å legge inn klassifiserings-tabellen og nyansere bunnlinjen.

## Når dette gjelder

Når Arch benchmarker eller auditerer nettbutikker på tvers av segmenter (grossist vs. tjenesteyter vs. forbruker) — klassifiser forretningsmodellen først, og aldri presenter rå-tall på tvers av segmenter uten forbehold.

---

# Lesson: Verifiser rendret DOM med Chrome --dump-dom

Ser du at `vision_analyze` feiler med `unknown variant "image_url"` → modellen er ikke
multimodal og kan ikke lese screenshots. Ikke kast bort tid på screenshots for egen
verifisering.

**Regel:** bruk headless Chrome `--dump-dom` + grep for å verifisere at JS faktisk rendret
korrekt DOM (navn, scores, tall). Screenshot brukes kun til leveranse til mennesker,
ikke som bevisgrunnlag for deg selv.

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --virtual-time-budget=3000 \
  --dump-dom "file:///sti/til/index.html" | grep '<selector>'
```

**Kilde:** F3.5 Arch Control Center-verifisering 2026-08-13. `browser_exec` kan også
feile (Browserbase uten CDP-endepunkt) — `--dump-dom` er alltid tilgjengelig lokalt.

---

# Lesson: Edge-runtime + Supabase = krasj

Ser du `runtime: "edge"` og `@supabase/supabase-js` i samme API-rute → det krasjer i
prod (500) fordi `process.version` mangler i V8 isolates.

Regel: supabase-js-ruter = `runtime: "nodejs"`. `Buffer` finnes heller ikke i edge.

Kilde: `failures/cf-edge-runtime-avvik.md`.

---

# Lesson: Governed deploy — verifiser verktøy FØR prosedyre dokumenteres

**Regel:** Før en operasjonell prosedyre (rollback, deploy, rotasjon) skrives
som standard, verifiser at (1) CLI-kommandoen faktisk finnes i gjeldende versjon,
(2) CI-workflowen matcher repoets verktøykjede. En dokumentert antakelse som ikke
er testet blir en «falsk standard» som svikter nøyaktig når den trengs.

**Hvorfor:** F3.6C fant to slike feil FØR de ble permanente Arch-standarder:
rollback-planen refererte en ikke-eksisterende wrangler-kommando, og deploy.yml var
en ødelagt stub som ga falsk rød CI. Begge ble fanget av Deploy Ready Gate + manuell
verifisering — bevis på at gaten beskytter, ikke bare dokumenterer.

**Arvet av:** Arch Audit v1 (F4) — hver audit-sjekk bærer `observed_at` + faktisk
verktøy-versjon, så «verifisert» betyr «testet mot faktisk runtime», ikke «antatt».

---

# Lesson: Kapital/P&L — kun aktive sesjoner

Alle summeringer av kapital, P&L, saldo og leaderboard MÅ filtrere
`status IN ('active','paused')`. Stoppede sesjoner er fryst historikk og genererer
fantom-data hvis de telles med.

`paper_accounts` er eneste fasit — aldri summer sesjoner inn i konto.

Kilde: `failures/paper-balance-inflasjon.md`.

---

# Lesson: Provenance — observed / declared / unknown

**Regel:** Et dashboard/rapport skal aldri vise en deklarert verdi som om den er live telemetri.
Hvert datapunkt må bære status: `observed` (hentet nå), `declared` (konfig/rolle),
`stale` (utgått), `unknown` (ikke verifisert) eller `error` (feil).

**Hvorfor:** «Hermes Active» var en hardkodet streng, ikke observasjon. En kunde kan ikke
skille løgn fra sannhet uten kilde + observasjonstidspunkt. Fail honestly: heller
`unknown` enn fabrikkert helse.

**Arvet av:** F3.6 data-adaptere (hvert datapunkt bærer `value/source/observed_at/status`).
Agent-status på dashboard: Hermes = unknown (ikke instrumentert) inntil det er observert;
Codex/Kimi = declared (roller, ikke kjørende agenter).

---

# Lesson: Registry som SSoT — ingen hardkodede stier i prod-kode

**Regel:** Prosjekter/ressurser registreres i en kanonisk Project Registry
(`packages/governance/projects.json`), ikke hardkodes i collector/adapters.
Lokale filsystemstier (`/Users/...`) er KUN lokal utviklingsmetadata (`dev_path`),
aldri prod-identifikator eller SSoT.

**Hvorfor:** `collect-dashboard-data.mjs` leste `/Users/taj/klarpakke` og
`/Users/taj/arch-dashboard` direkte — fungerte på én maskin, umulig på Cloudflare Pages/CI.

**Arvet av:** F3.6 — collector leser registry, adapters er parameterisert på repo/team-id.
Sanitert publikumsvisning stripper alle `dev_path`-felt.

---

# Lesson: Route handler → createServerClient(request, response)

I Next.js route handlers (ikke RSC): bruk `createServerClient(request, response)` fra
`src/lib/supabase/server.ts` (sync-varianten). `cookies()`-varianten uten args krasjer
i route-handler-context → 500 for innloggede.

Kilde: fiks av `/api/onboarding/events` 2026-08-10.

---

# Lærdom: outside-in website audit som salgs­trakt-førstesteg

**Dato:** 2026-08-13
**Kontekst:** F4.2B — Arch Website Audit v1

## Lærdom

**Laveste terskel inn i en teknisk salgs­trakt er en read-only, evidensbasert outside-in audit av noe kunden allerede eier offentlig — ikke en repo-tilgang.**

En potensiell kunde vil ikke gi kildekode-tilgang før de har sett verdi. Men nettsiden deres er allerede offentlig. Ved å bygge en audit som kun trenger `@url:https://kunde.no`, fjerner man **hele tillits-barrieren** som en repo-audit innebærer, samtidig som man beviser kvaliteten på arbeidet.

## Konkrete grep som gjorde det troverdig

1. **UNKNOWN ≠ PASS** — «frahold av bevis» ble aldri et negativt faktum. En sjekk vi ikke kunne gjøre (f.eks. responsiv-CSS uten å laste CSS) merkes `UNKNOWN`, ikke `FAIL`. Uten dette ville tool'en fabrikkere falske funn.
2. **Trackere/analytics = signal, ikke score-FAIL.** Å ha Google Analytics er ikke en sårbarhet — det er et *potensielt* privacy-concern. CMP-sjekken kjører kun hvis trackere faktisk finnes.
3. **Provenance på alt** (`evidence` + `confidence` per sjekk) — kunden kan spore hvert funn tilbake til en observerbar HTTP-respons.
4. **Gjenbruk det kommersielle laget** (4 bøtter, 5 felt, Build Proposal, consent-gate, isolasjon) i stedet for å bygge en one-off. Web-audit arver hele F4.1-laget.
5. **Crawl-sikkerhet som default** (max_pages, max_depth, delay, robots-respekt, same-origin) — en «audit» som crawler aggressivt er en skanner, ikke en audit.

## Pitfall som ble fanget

- **Render-blokkering-sjekk teller feil uten `type=module`/inline-håndtering.** Next.js emitterer `<script type="module">` (deferred av spec) og inline-skript (ingen nettverksressurs). Uten eksplisitt filtrering rapporterte klarpakke.no «71 blokkerende skript» — et falskt positivt for akkurat den profilen Tom jakter. Fikset ved å ekskludere `async`/`defer`/`type=module`/inline (uten `src`).

## Når dette gjelder

Når man bygger en salgs­trakt for tekniske tjenester der tillit er barrieren — start med det kunden allerede eksponerer offentlig, bevis kvaliteten der, og be deretter om dypere tilgang.

---

# Lesson: wrangler multi-env → --env ""

`wrangler.jsonc` med flere environments → alle `wrangler deploy`/`versions`-kommandoer
MÅ ha `--env ""` (tom streng) for å treffe default-prod. Uten det treffer du feil
environment eller feiler.

Kilde: KLA-278 wrangler `versions secret put` (versjon 4faac85d).
