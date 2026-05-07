// ════════════════════════════════════════════════════════════════════
//  SEOZ legal docs — privacy policy + terms of service.
//
//  Lazy-loaded by showLegalDoc() the first time the user opens the
//  Juridiskt section (or clicks a privacy/terms link). Keeping this
//  out of index.html saves ~30KB on every cold start since most
//  users never open these docs.
//
//  When updating: bump LEGAL_VERSION + the date string.
// ════════════════════════════════════════════════════════════════════
// eslint-disable-next-line no-unused-vars
window.LEGAL_VERSION = '2026-05-05.c'
window.LEGAL_UPDATED = '5 maj 2026'

window.LEGAL_DOCS = {
  privacy: {
    title: 'Integritetspolicy',
    body: `
<h1>Integritetspolicy för SEOZ</h1>
<div class="legal-meta">Senast uppdaterad: 2026-05-05</div>

<p>SEOZ är en webbläsare byggd med integritet i fokus. Den här policyn beskriver vilken data som lagras, var, och vem som har åtkomst.</p>

<h2>I korthet</h2>
<ul>
  <li><strong>All din data lagras lokalt på din enhet</strong> om inte annat uttryckligen anges.</li>
  <li><strong>Vi har ingen central server</strong> som samlar in din browsing-historik, dina lösenord, eller dina mail.</li>
  <li><strong>Vi spårar dig inte.</strong> Inga analytics, inga reklam-pixlar, ingen telemetri som standard.</li>
  <li><strong>Kraschrapporter är opt-in.</strong> Avstängda som default. Du aktiverar dem själv i Inställningar → Diagnostik om du vill hjälpa oss åtgärda buggar.</li>
</ul>

<h2>Data som lagras lokalt på din enhet</h2>
<p>Följande lagras i en användarmapp på din dator (Windows: <code>%APPDATA%\\seoz-browser</code>, macOS: <code>~/Library/Application Support/seoz-browser</code>, Linux: <code>~/.config/seoz-browser</code>):</p>
<table>
  <thead><tr><th>Data</th><th>Lagring</th></tr></thead>
  <tbody>
    <tr><td>Bokmärken, fliksessioner, historik</td><td>Klartext</td></tr>
    <tr><td>Sparade lösenord</td><td>Krypterad med ditt operativsystems nyckelförvaring (Windows DPAPI / macOS Keychain / Linux libsecret), skyddad av master-PIN</td></tr>
    <tr><td>Mail-kontouppgifter (IMAP/SMTP)</td><td>Krypterad samma sätt som lösenord</td></tr>
    <tr><td>Mail-innehåll</td><td>Hämtas från din IMAP-server vid behov, cachat lokalt</td></tr>
    <tr><td>API-nycklar (Anthropic, OpenAI, ElevenLabs)</td><td>Krypterad samma sätt som lösenord</td></tr>
    <tr><td>Inställningar och webbplatsbehörigheter</td><td>Klartext</td></tr>
  </tbody>
</table>
<p>Ingen av denna data lämnar din enhet utan att du själv begär det.</p>

<h2>Data som skickas till externa tjänster</h2>
<p>SEOZ kontaktar externa tjänster <em>endast</em> när du själv använder en funktion som kräver det:</p>

<h3>SEOZ-plattformen (seoz.io)</h3>
<p>Om du <strong>kopplar ditt SEOZ-konto</strong> synkar browsern klientdata, sökord och tasks till seoz.io var 30:e sekund. Synkningen är krypterad via HTTPS och autentiserad med din personliga API-nyckel. Du kan koppla från när som helst i Inställningar → Konto → Koppla från, vilket nollställer all synkad data lokalt.</p>
<p>Om du <em>inte</em> kopplar konto används ingen del av SEOZ-plattformen.</p>

<h3>AI-tjänster</h3>
<ul>
  <li><strong>Anthropic Claude</strong> används om du har en Claude-API-nyckel inmatad och använder Claude-chatten eller smart inbox. Texten skickas direkt från din browser till <code>api.anthropic.com</code> med din egen nyckel.</li>
  <li><strong>OpenAI</strong> (GPT-4 + Whisper) används för röstchatt och vissa AI-funktioner om du matat in din OpenAI-nyckel.</li>
  <li><strong>ElevenLabs</strong> används för text-till-tal om du matat in din ElevenLabs-nyckel.</li>
</ul>
<p>Vi vidarebefordrar aldrig dina AI-prompts till någon annan part — det är direktanrop från din browser. Anthropic, OpenAI och ElevenLabs har sina egna integritetspolicyer som gäller för deras hantering av denna data.</p>

<h3>Mail-servrar</h3>
<p>När du läser eller skickar mail kontaktar browsern direkt din IMAP/SMTP-server med uppgifterna du angett (Gmail, Zoho, eller annan provider). Inget mail-innehåll passerar SEOZ-servrar.</p>

<h3>Auto-uppdatering</h3>
<p>Browsern frågar <code>github.com/valdemarmattsson-beep/seoz-browser/releases</code> om det finns nya versioner. Endast version och OS-info skickas — ingen användardata.</p>
<p><strong>På macOS</strong> är auto-installation inaktiverad i denna early-access-version eftersom binären inte är kodsignerad. Browsern säger till när en ny version finns men du behöver ladda ner den nya <code>.dmg</code>-filen manuellt. Vid signering (planerad) blir flödet automatiskt även på Mac.</p>

<h3>Kraschrapporter (opt-in)</h3>
<p>Browsern loggar alla krascher lokalt på din enhet (i mappen <code>crash-reports</code> under användardatamappen). Detta sker alltid, men loggen lämnar aldrig din dator om du inte själv slår på "Skicka kraschrapporter" i Inställningar → Diagnostik.</p>
<p>När du aktiverar uppladdning skickas följande till SEOZ när browsern kraschar:</p>
<ul>
  <li>SEOZ-version, Electron-version, Chromium-version</li>
  <li>Operativsystem och arkitektur</li>
  <li>Felmeddelande och stack-trace</li>
  <li>En slumpmässigt genererad anonym <strong>installations-ID</strong> (16 hex-tecken) — gör att vi kan se om samma installation kraschar flera gånger, men vi kan inte koppla det till dig personligen</li>
  <li>Tidsstämpel</li>
</ul>
<p>Det skickas <strong>inte</strong>: URL:er du besökt, sidtitlar, cookies, formulärdata, lösenord, mail-innehåll, IP-adress (mer än vad HTTP-lagret naturligt avslöjar för servern), eller någon annan personidentifierande information.</p>
<p>Du kan när som helst stänga av uppladdning, granska de lokala loggarna eller rensa dem helt i Inställningar → Diagnostik.</p>

<h3>Webbsidor du besöker</h3>
<p>När du surfar pratar browsern med de webbplatser du själv navigerar till — precis som vilken annan browser. Cookies, formulärdata och webbplatslagring hanteras av Chromium på samma sätt som i Chrome.</p>

<h2>Cookies och webbplatsdata</h2>
<p>SEOZ lagrar cookies, localStorage och sessionStorage från webbplatser du besöker, i samma användarmapp som beskrivs ovan. Du kan radera detta via webbplatsens egna inställningar eller genom att radera SEOZ-mappen.</p>
<p>Den inbyggda annonsblockeraren (<strong>SEOZ Shield</strong>) stoppar kända reklamspårare innan de kontaktas. Cookie-banner-hanteraren (om aktiverad) klickar automatiskt accept/reject på sajter med kända CMP-system.</p>

<h2>Säkerhet</h2>
<ul>
  <li>Lösenord och credentials krypteras med din enhets nyckelförvaring (Windows DPAPI / macOS Keychain).</li>
  <li>Master-PIN hashar med PBKDF2-SHA256, 600 000 iterationer, per-PIN-salt.</li>
  <li>Felinmatning av master-PIN låser tillfälligt verifieringen (30s efter 5 fel, 5 min efter 10 fel).</li>
  <li>All extern kommunikation går över HTTPS/TLS.</li>
  <li>Kameran, mikrofonen och skärminspelning kräver per-sajt-godkännande från dig.</li>
</ul>

<h2>Dina rättigheter (GDPR/EU)</h2>
<p>Eftersom all data lagras lokalt har du fysisk kontroll över den. Specifikt:</p>
<ul>
  <li><strong>Åtkomst</strong>: alla data finns i SEOZ-mappen på din enhet.</li>
  <li><strong>Radering</strong>: avinstallera browsern eller radera mappen.</li>
  <li><strong>Portabilitet</strong>: bokmärken, lösenord, mail-konfiguration kan exporteras (planerad funktion).</li>
  <li><strong>Rättning</strong>: ändra direkt i appen.</li>
  <li><strong>Klagomål</strong>: kontakta oss på adressen nedan eller kontakta din nationella datatillsynsmyndighet (i Sverige: Integritetsskyddsmyndigheten, IMY).</li>
</ul>

<h2>Ändringar</h2>
<p>Vi kan komma att uppdatera denna policy. Senaste versionen finns alltid i SEOZ → Inställningar → Juridiskt.</p>

<h2>Kontakt</h2>
<p>Frågor om integritet eller data-rättigheter:<br><a href="mailto:hello@seoz.io" onclick="event.preventDefault();SE.openExternal('mailto:hello@seoz.io')">hello@seoz.io</a></p>
<p>Personuppgiftsansvarig: SEOZ.</p>
`,
  },

  terms: {
    title: 'Användarvillkor',
    body: `
<h1>Användarvillkor för SEOZ</h1>
<div class="legal-meta">Senast uppdaterad: 2026-05-05</div>

<p>Genom att installera, ladda ner eller använda SEOZ ("Browsern") accepterar du följande villkor.</p>

<h2>1. Licens</h2>
<p>Browsern tillhandahålls <strong>gratis</strong> av SEOZ. Du får:</p>
<ul>
  <li>Installera och använda Browsern på dina egna enheter</li>
  <li>Använda Browsern för personliga eller kommersiella ändamål</li>
  <li>Läsa, granska och föreslå förbättringar i den publika källkoden</li>
</ul>
<p>Du får inte:</p>
<ul>
  <li>Vidaredistribuera Browsern under annan branding</li>
  <li>Återskapa SEOZ-varumärket</li>
  <li>Ladda ner och bygga om binären med skadlig kod och distribuera vidare</li>
</ul>
<p>Browsern är byggd på Electron + Chromium med MIT/BSD-licens. Underliggande open source-komponenter behåller sina respektive licenser.</p>

<h2>2. Tjänsten "som den är"</h2>
<p>Browsern levereras <strong>som den är</strong> ("AS-IS") utan garantier av något slag, uttryckliga eller underförstådda. Vi garanterar inte:</p>
<ul>
  <li>Att Browsern är felfri eller buggfri</li>
  <li>Att den fungerar med alla webbplatser</li>
  <li>Att den är tillgänglig 100 % av tiden</li>
  <li>Att lagrad data inte kan gå förlorad</li>
</ul>

<h2>3. Ansvarsbegränsning</h2>
<p>I största utsträckning lag tillåter:</p>
<ul>
  <li>SEOZ ansvarar <strong>inte</strong> för någon förlust av data, inkomst, vinst, eller affärsmöjligheter som uppstår vid användning av Browsern.</li>
  <li>SEOZ:s totala ansvar gentemot dig får aldrig överstiga <strong>1 000 SEK</strong>, eller det belopp du betalat för Browsern (vilket är 0 SEK om du inte betalat).</li>
  <li>Detta inkluderar — men är inte begränsat till — bortfall av lösenord, e-postdata, bokmärken, eller annan information lagrad i Browsern.</li>
</ul>
<p><strong>Du är själv ansvarig för backuper av viktig data.</strong></p>

<h2>4. AI-funktioner</h2>
<p>Browsern erbjuder integration med externa AI-tjänster (Claude, OpenAI, ElevenLabs) om du tillhandahåller dina egna API-nycklar. Du är medveten om att:</p>
<ul>
  <li>AI-genererade svar kan vara felaktiga, vilseledande eller stötande.</li>
  <li>SEOZ granskar inte och garanterar inte AI-resultat.</li>
  <li>Du är ansvarig för hur du använder AI-genererat innehåll.</li>
  <li>Tredjepartsleverantörer (Anthropic, OpenAI, ElevenLabs) tillämpar sina egna villkor.</li>
</ul>

<h2>5. Tredjepartstjänster</h2>
<p>Browsern interagerar med externa tjänster du själv väljer (mail-leverantörer, AI-tjänster, webbplatser). SEOZ ansvarar inte för:</p>
<ul>
  <li>Tillgänglighet eller funktionalitet hos dessa tjänster</li>
  <li>Avgifter eller villkor från dessa tjänster</li>
  <li>Säkerheten i deras infrastruktur</li>
</ul>

<h2>6. Acceptabel användning</h2>
<p>Du får inte använda Browsern för att:</p>
<ul>
  <li>Bryta mot lagen i din jurisdiktion</li>
  <li>Trakassera, skada eller bedra andra</li>
  <li>Distribuera skadlig kod</li>
  <li>Bryta mot tredje parts immateriella rättigheter</li>
  <li>Återskapa SEOZ:s varumärke eller representationer</li>
</ul>

<h2>7. Uppdateringar</h2>
<p>Browsern uppdaterar sig själv automatiskt via auto-updater. Genom att använda Browsern accepterar du att uppdateringar installeras. Vi förbehåller oss rätten att:</p>
<ul>
  <li>Ändra eller ta bort funktionalitet i framtida versioner</li>
  <li>Avbryta utvecklingen eller supporten av Browsern</li>
  <li>Migrera lagringsformat (vilket kan kräva manuell datamigrering)</li>
</ul>

<h2>8. Avslutning</h2>
<p>Du kan när som helst sluta använda Browsern genom att avinstallera den. SEOZ kan avsluta din åtkomst till plattformsanslutna funktioner (sync, klientdata) om du bryter mot dessa villkor; den lokala installationen påverkas inte.</p>

<h2>9. Tillämplig lag</h2>
<p>Dessa villkor regleras av svensk lag. Tvister avgörs i första hand av Stockholms tingsrätt.</p>

<h2>10. Ändringar i villkoren</h2>
<p>Vi kan komma att uppdatera dessa villkor. Vi meddelar väsentliga ändringar via en banner i Browsern eller per e-post om du är ansluten till SEOZ-plattformen. Genom fortsatt användning efter en ändring accepterar du de nya villkoren.</p>

<h2>11. Kontakt</h2>
<p>Frågor om dessa villkor:<br><a href="mailto:hello@seoz.io" onclick="event.preventDefault();SE.openExternal('mailto:hello@seoz.io')">hello@seoz.io</a></p>
`,
  },
}
