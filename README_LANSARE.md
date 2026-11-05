# Actualizare CRM — lansare controlată

Folosește GitHub Actions, nu scriptul vechi `LANSARE_WINDOWS.ps1`.

1. Verifică existența folderelor `src/`, `public/` și `.github/workflows/` în GitHub.
2. **TEST**: rulează manual `Publish CRM manually`, verifică logul, autentificarea, prospectarea, ofertarea mixtă, catalogul, contractarea, BackOffice, semnarea manuală, Turso/R2 și PDF-ul.
3. **LIVE**: exportă backup-ul datelor, verifică numele exact al Worker-ului și bucketului R2 de producție, apoi rulează `Publish CRM PRODUCTION` introducând `PUBLICA-LIVE`.
4. Testează login-ul existent în producție înainte de a închide orice sesiune, apoi toate fluxurile cu date de test.
5. Nu șterge mediul TEST până când versiunea LIVE funcționează și ai verificat datele și backupul.

**Atenție:** backend-ul este bazat pe un pachet anterior; dacă Worker-ul LIVE a primit ulterior corecții de autentificare, trebuie comparat `src/index.js` înainte de suprascriere. Nu există validare reală Turso/R2 sau test de 50 de agenți simultan din acest pachet.
