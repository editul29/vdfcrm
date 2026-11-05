# Actualizare candidat pentru GitHub — NU publica in productie fara testare

Arhiva este derivata din pachetul anterior si corectiile disponibile, NU din copia exacta a Worker-ului deja publicat.

Include reparatii partiale la Manager/Reguli comerciale, catalogul importat, portari restante, anulare si documente. Nu este verificata complet formula de plata KPI, toate combinatiile comercial-contractuale, PDF si fluxurile cu Turso/R2. Nu publica automat peste CRM-ul live.

Descarca/extrage, incarca continutul folderului in repo privat GitHub pastrand structura src/, public/, .github/ si package.json. Configurarea Github Actions necesita CLOUDFLARE_API_TOKEN si CLOUDFLARE_ACCOUNT_ID ca repository secrets. Nu incarca niciodata secrete Turso, Companero, SETUP_KEY sau PASSWORD_PEPPER.

Fa o copie a versiunii live si foloseste un Worker de test si o baza Turso separata, apoi verifica Manager, Agent, BO, reguli, target, anulare, portari si documente.
