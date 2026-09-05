# OrderPing — server

Acesta e codul serverului real pentru OrderPing (nu mai e demo-ul din Claude).

## Ce e în acest folder

- `server.js` — „creierul" aplicației: ține minte comenzile și trimite notificările.
- `package.json` — spune ce „unelte" (librării) are nevoie serverul ca să funcționeze.
- `public/index.html` — pagina web (panoul de bucătărie + ecranul clientului).
- `public/sw.js` — codul care rulează în fundal pe telefon, ca notificarea să ajungă și cu ecranul blocat.

## Cum se pune online (pe scurt)

1. Aceste fișiere se încarcă într-un repository nou pe GitHub.
2. Contul de pe [render.com](https://render.com) se conectează la acel repository.
3. Render instalează automat ce e nevoie (`npm install`) și pornește serverul (`npm start`).
4. Render dă o adresă publică de tipul `https://orderping-xxxx.onrender.com`.

Pași detaliați, ghidați — direct în conversația cu Claude.
