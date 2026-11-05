# Vodafone Business Hunting CRM — ofertare mixtă și semnare BO

## Ce conține actualizarea

- Constructor de ofertă cu mai multe grupe de abonamente: SIMO sau Buget, tip activare/portare, plan Evolve/RED, nivel de preț intern, cantitate și luni gratuite pe grupă.
- Mai multe dispozitive, cu catalog căutabil, buton `+` la fiecare model, cantități și grupă de abonamente suport.
- Recomandare *orientativă* cu prețuri **Evolve** eligibile, calculată după numărul SIM-urilor Buget, portări, durata internă, luni de buget și avans. Se aplică explicit, numai după confirmarea agentului. Nu este aprobare Risk/credit.
- Oferta pentru client afișează **numărul total de activări**, fără descompunerea în portări, fără coduri D și fără perioada contractuală. Costurile sunt fără TVA. Aceleași excluderi sunt folosite în documentul PDF vectorial.
- Contractarea transformă fiecare grupă în linii SIM distincte și copiază toate dispozitivele în configurator.
- BackOffice/Manager: **Semnare manuală** după `Asteptare Semnare`, cu tip dovadă, observație și confirmare; verificare și audit în backend, apoi trecere la `Verificare Risk`. Fluxul SMS rămâne disponibil și primește verificare backend proprie.
- Avertizare despre bugetul insuficient în configurator; BackOffice poate continua evaluarea/solicita depozit. Drafturile incomplete se pot salva.
- Regulă Evolve3 D0-D3 și Evolve4 D0-D4 pentru telefoane peste 700 € păstrată.

## Livrare în GitHub

Înlocuiește fișierele **în calea lor exactă**, nu în root:

1. `public/index.html` — interfață, formular, PDF.
2. `src/index.js` — semnare manuală, confirmare SMS, verificări de rol.
3. `wrangler.toml` — **TEST ONLY**, Worker `vodafone-business-hunting-crm-test`, bucket `vodafone-crm-docs-test`.
4. `.github/workflows/deploy-manual.yml` — deploy manual pentru TEST.
5. `wrangler.production.toml` și `.github/workflows/deploy-production.yml` — folosesc Worker și R2 de PRODUCȚIE. **Nu rula producția până la verificarea bazei, backup și confirmare.**

## Ordinea de publicare

1. Manager -> Audit -> Descarcă backup JSON (în LIVE, înainte de orice deploy). Păstrează backupul privat și verifică fișierul.
2. Încarcă sursele în repository. Dacă repository-ul privat conține un `src/index.js` mai nou decât cel din arhivă, **nu îl suprascrie fără compararea diferențelor**; unele corecții anterioare de autentificare s-ar putea pierde.
3. Rulează **Publish CRM manually** numai către TEST și testează manager, agent, BackOffice, ofertare, documente R2 și semnare reală de test. Nu introduce date reale.
4. Compară comportamentul și setările de producție; verifică secretele existente (nu le copia în GitHub), numele Worker și bucketul R2.
5. Doar după aprobarea manuală, rulează **Publish CRM PRODUCTION** cu textul `PUBLICA-LIVE`. Nu executa setup/reset și nu roti `PASSWORD_PEPPER`.
6. După verificarea producției, poți șterge resursele de TEST (Worker, Turso, R2), dar NU înainte. Verifică întâi numele exact și păstrează backupul.

## Teste efectuate local

- Sintaxă JavaScript backend + frontend: PASS.
- Flux Playwright local: Manager de test -> Prospect -> grupă 2 SIM Evolve3 portări + grupă 3 SIM Evolve1 activări -> 2 dispozitive -> avans -> previzualizare -> contract cu 5 linii și 2 dispozitive: PASS.
- Excludere D/24/36 luni/descompunere portări din previzualizare: PASS.
- BackOffice local: Așteptare semnare -> semnare manuală -> Verificare Risk: PASS.
- Test izolat API de semnare: Agent blocat, dovadă invalidă blocată, BackOffice autorizat și audit, dublă semnare blocată: PASS.
- Protecție suplimentară în `/api/state/patch`: nu acceptă modificări directe ale câmpurilor de semnare, validarea înainte de semnare sau anularea fără ruta dedicată. Test izolat: 5 încercări de ocolire respinse, tranziții legitime acceptate (PASS).
- Eligibilitate telefon >700 €: Evolve4 D4 acceptat; Evolve3 D4 și Evolve2 respinse: PASS.

## Ce NU a fost verificat încă

- Tranzacții reale end-to-end în Turso, R2 și autentificarea pe conturile LIVE (nu avem acces la secretele lor).
- Validarea efectivă a unui PDF generat cu biblioteca jsPDF încărcată online (sintaxa JS și previzualizarea HTML sunt verificate; PDF-ul trebuie testat în TEST).
- Comportamentul sub 50 de agenți simultan și eventualele conflicte de editare a aceleiași înregistrări.
- Verificarea API Companero: se tratează în actualizarea separată, după release.

**Nu declara release-ul gata pentru producție fără aceste teste în mediul Cloudflare.**
