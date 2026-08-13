# Arch Audit-log — autoglassgrossisten
## 2026-08-13 — scaffold
- **Aktør:** Hermes (Project Factory v2.1)
- **Hendelse:** .arch/ + struktur scaffoldet. Ekstern oppsett: ikke utført (krever --approve).

## 2026-08-14 — full onboarding (Project Factory lifecycle)
- **Aktør:** Hermes (Project Factory v2.1), godkjent av Tom (ARC-team-beslutning)
- **Hendelse:** analyze → proposal → Tom-godkjenning → init
- **Endringer:** .arch/ Control Plane scaffoldet i klon (`~/Developer/autoglassgrossisten`), project.yaml beriket (customer: Autoglass AS, ARC-team), environments.yaml fylt (prod: auto-glass.no, worker autoglass-glass-sok, D1 glass-catalog-db)
- **Beskyttet:** 16 eksisterende GitHub Actions-workflows intakt (deploy.yml gjenopprettet fra backup etter init-mal-overskriving)
- **Registry:** registrert i Arch Project Registry (SSoT) — projects.json + projects.yaml, `autoglassgrossisten`, visibility customer, status live, linear_team ARC
- **Knowledge:** 12 lessons arvet fra Arch Knowledge Graph → `.arch/inherited-lessons.md`
- **Ekstern:** ingen Linear-team opprettet (vedtak: ARC-teamet brukes for Autoglass-arbeid)
