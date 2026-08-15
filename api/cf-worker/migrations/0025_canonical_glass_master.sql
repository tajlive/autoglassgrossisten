-- 0025_canonical_glass_master.sql — Canonical glass master i B2B (KLA-311 F1B)
-- ---------------------------------------------------------------------------
-- Speiler finnbilglass migrasjon 0004_canonical_glass_master.sql EKSAKT på
-- kolonnenavn/rekkefølge, slik at det systemnøytrale snapshotet fra
-- scripts/export-canonical-master.mjs importeres idempotent (INSERT OR IGNORE)
-- med samme source_id + raw_fingerprint i begge systemer.
--
-- Regler (runbook):
--  - versjonert, ikke-destruktiv: endringer lager nye rader (version+1)
--  - pris/lager/ordre legges ALDRI her — B2B beholder egen autoritet i
--    glass_catalog / autoglass_prisliste
--  - ingen rader slettes — kun deaktiveres (is_current=0 / status)
-- ===========================================================================

PRAGMA defer_foreign_keys=TRUE;

-- Kilderegister: alle eksterne data MÅ ha provenance.
CREATE TABLE IF NOT EXISTS source_katalog (
  source_id TEXT PRIMARY KEY,                 -- 'pilkington-irl', 'glavista', …
  source TEXT NOT NULL,
  source_url TEXT,
  source_version TEXT,
  fetched_at TEXT NOT NULL,
  source_updated_at TEXT,
  license_ref TEXT NOT NULL,                  -- 'internal-autoglass' (egne data)
  raw_fingerprint TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  notes TEXT
);

-- Hovedenhet: ett glass (identitet, ikke features).
CREATE TABLE IF NOT EXISTS glass_master (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_key TEXT NOT NULL,                -- stabil nøkkel: 'EUR:'+normalisert eurocode
  eurocode TEXT,
  category TEXT NOT NULL DEFAULT 'frontrute',
  brand TEXT,
  market TEXT NOT NULL DEFAULT 'NO',
  lhd_rhd TEXT NOT NULL DEFAULT 'LHD',
  supersession_of TEXT,
  superseded_by TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  version INTEGER NOT NULL DEFAULT 1,
  is_current INTEGER NOT NULL DEFAULT 1,
  source_id TEXT REFERENCES source_katalog(source_id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (canonical_key, version)
);
CREATE INDEX IF NOT EXISTS idx_glass_master_eurocode ON glass_master(eurocode) WHERE is_current=1;
CREATE INDEX IF NOT EXISTS idx_glass_master_key ON glass_master(canonical_key);

-- Identifikatorer (flere per glass, alle typer).
CREATE TABLE IF NOT EXISTS glass_identifiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  glass_id INTEGER NOT NULL REFERENCES glass_master(id),
  id_type TEXT NOT NULL,                      -- EUROCODE/OEM/SUPPLIER/TRADE/GTIN_EAN/KTYPE/ARTICLE
  id_value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.8,
  is_current INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (glass_id, id_type, id_value)
);
CREATE INDEX IF NOT EXISTS idx_glass_idents_value ON glass_identifiers(id_type, id_value) WHERE is_current=1;

-- Features: én rad per feature per versjon — aldri innbakt i identitet/eurocode.
CREATE TABLE IF NOT EXISTS glass_features (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  glass_id INTEGER NOT NULL REFERENCES glass_master(id),
  feature TEXT NOT NULL,                      -- rain_sensor/heated/hud/camera/adas/antenna/…
  value TEXT NOT NULL,                        -- 'true'/'false'/'unknown'
  confidence REAL NOT NULL DEFAULT 0.5,
  evidence_ref TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  is_current INTEGER NOT NULL DEFAULT 1,
  source_id TEXT REFERENCES source_katalog(source_id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (glass_id, feature, version)
);
CREATE INDEX IF NOT EXISTS idx_glass_features_current ON glass_features(glass_id) WHERE is_current=1;

-- Kjøretøy-tilknytning: år, ktype, build codes, VIN-mønster, marked.
CREATE TABLE IF NOT EXISTS glass_vehicle_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  glass_id INTEGER NOT NULL REFERENCES glass_master(id),
  make TEXT NOT NULL,
  model TEXT,
  year_from INTEGER,
  year_to INTEGER,
  ktype TEXT,
  build_codes TEXT,
  vin_pattern TEXT,
  market TEXT NOT NULL DEFAULT 'NO',
  confidence REAL NOT NULL DEFAULT 0.5,
  is_current INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  source_id TEXT REFERENCES source_katalog(source_id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (glass_id, make, model, year_from, ktype, version)
);
CREATE INDEX IF NOT EXISTS idx_glass_vlinks_vehicle ON glass_vehicle_links(make, model) WHERE is_current=1;
CREATE INDEX IF NOT EXISTS idx_glass_vlinks_ktype ON glass_vehicle_links(ktype) WHERE is_current=1;
