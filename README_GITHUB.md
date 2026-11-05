# Vodafone Business Hunting CRM — GitHub

Acest repository conține backend-ul Cloudflare Worker (`src/index.js`) și interfața (`public/index.html`).

## Mediile sunt diferite

- **TEST**: `.github/workflows/deploy-manual.yml` folosește `wrangler.toml`, Worker `vodafone-business-hunting-crm-test`, bucket `vodafone-crm-docs-test` și secretele bazei Turso de test.
- **LIVE**: `.github/workflows/deploy-production.yml` folosește `wrangler.production.toml`, Worker `vodafone-business-hunting-crm`, bucket `vodafone-crm-docs` și secretele deja configurate în Worker-ul de producție.
- Workflow-ul LIVE cere confirmarea explicită `PUBLICA-LIVE`. Nu îl executa înainte să verifici backupul datelor și funcțiile din TEST.

Nu încărca `.env`, `.dev.vars`, tokenuri, parole, `node_modules`, `.wrangler` sau chei API. Nu rula scripturile vechi de inițializare în producție și nu schimba `PASSWORD_PEPPER` din Worker-ul LIVE.

Citește `README_ACTUALIZARE_2026-11-05.md` pentru modificări, testare și limitări.
