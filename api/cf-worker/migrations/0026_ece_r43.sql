-- 0026_ece_r43.sql — ECE R43-verifiseringskanal i B2B (speiler finnbilglass 0009)
-- ---------------------------------------------------------------------------
-- Kunden/verkstedet fotograferer 43R-godkjenningsmerket på det gamle glasset
-- (eller skriver nummeret manuelt) → /api/verify-glass leser nummeret →
-- oppslag i ece_r43 → bekreftet glass fra glass_catalog FØR bestilling.
--
-- ece_r43 = mapping 43R-nummer → eurokode/varenr (familie-nivå: ETT nummer kan
-- dekke FLERE koder). Bygges via kundeinnslag (crowdsourcing), varekort-scrape
-- og produsentkataloger. r43_nummer = kun sifrene (normalisert, f.eks. 004592).
-- ===========================================================================

-- Mapping: 43R-nummer → glass.
CREATE TABLE IF NOT EXISTS ece_r43 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  r43_nummer TEXT NOT NULL,          -- normalisert: kun sifrene (004592)
  landkode TEXT NOT NULL DEFAULT 'E1', -- E1=Tyskland, E2=Frankrike, E4=Nederland…
  eurokode TEXT,                     -- kobling mot glass_catalog.eurocode
  varenr TEXT,                       -- supplier_sku i glass_catalog
  merke TEXT,
  modell TEXT,
  kilde TEXT NOT NULL DEFAULT 'manual', -- manual|varekort|scrape|customer
  bekreftet INTEGER NOT NULL DEFAULT 0, -- 1 = verifisert av Autoglass
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (r43_nummer, eurokode)
);
CREATE INDEX IF NOT EXISTS idx_ece_r43_nummer ON ece_r43(r43_nummer);
CREATE INDEX IF NOT EXISTS idx_ece_r43_eurokode ON ece_r43(eurokode);

-- Søkelogg: sporbarhet for hver verifisering (kun nummeret lagres — bildet
-- prosesseres og slettes umiddelbart, GDPR).
CREATE TABLE IF NOT EXISTS r43_sok_logg (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  r43_nummer TEXT NOT NULL,
  treff INTEGER NOT NULL DEFAULT 0,
  kilde TEXT NOT NULL DEFAULT 'photo',
  query_ref TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_r43_sok_logg_nummer ON r43_sok_logg(r43_nummer);
CREATE INDEX IF NOT EXISTS idx_r43_sok_logg_created ON r43_sok_logg(created_at);
