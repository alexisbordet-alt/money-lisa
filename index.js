require("dotenv").config();
const { App } = require("@slack/bolt");
const fs = require("fs");

const app = new App({
  token:         process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode:    true,
  appToken:      process.env.SLACK_APP_TOKEN,
  clientOptions: { retryConfig: { retries: 10 } },
});

const STATE_FILE  = fs.existsSync("/data") ? "/data/state.json" : "./state.json";
const CANAL_SORTIE = "test-koh-mando-58";

// ============================================================
// PERSISTANCE
// ============================================================
function chargerState() {
  try {
    if (fs.existsSync(STATE_FILE))
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) {}
  return {
    modeLabel: "la semaine", objectifDepart: 8073, objectif: 8073,
    buffer: [], milestonesVus: [], tsDejaComptes: [], montantsComptes: {}, salesStats: {}, nbCompteurs: 0,
    objectifDateDebut: null, objectifNbJours: null, lastChannel: null,
  };
}
function sauvegarderState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

let state = chargerState();
if (!state.tsDejaComptes)    state.tsDejaComptes    = [];
if (!state.montantsComptes)  state.montantsComptes  = {};
if (!state.salesStats)       state.salesStats       = {};
if (state.nbCompteurs  == null) state.nbCompteurs   = 0;
if (state.objectifDateDebut === undefined) state.objectifDateDebut = null;
if (state.objectifNbJours   === undefined) state.objectifNbJours   = null;
if (state.lastChannel        === undefined) state.lastChannel        = null;

function getDateStr(d = new Date()) { return d.toISOString().split("T")[0]; }

// ── Heure/jour en timezone Paris (Railway tourne en UTC) ──────
function getNowParis() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(now);
  const h = parseInt(parts.find(p=>p.type==="hour").value, 10);
  const m = parseInt(parts.find(p=>p.type==="minute").value, 10);
  const dayStr = new Intl.DateTimeFormat("en-US", { timeZone:"Europe/Paris", weekday:"short" }).format(now);
  const jourMap = {Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
  return { h, m, jour: jourMap[dayStr] ?? new Date().getDay() };
}

function mettreAJourPeriode() {
  if (!state.objectifNbJours || !state.objectifDateDebut) return;
  const joursEcoules = Math.floor((new Date(getDateStr()) - new Date(state.objectifDateDebut)) / 86400000);
  const restants = state.objectifNbJours - joursEcoules;
  let newLabel;
  if (restants <= 1)      newLabel = "la journée";
  else if (restants <= 4) newLabel = `les ${restants} prochains jours`;
  else                    newLabel = `les ${restants} prochains jours`;
  if (newLabel !== state.modeLabel) {
    state.modeLabel = newLabel;
    if (restants <= 0) { state.objectifNbJours = null; state.objectifDateDebut = null; }
    sauvegarderState(state);
  }
}

// ============================================================
// UTILITAIRES
// ============================================================
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ── Pick "rare" : ne sort le message qu'occasionnellement ───
// Utilisé pour réduire drastiquement la fréquence des références
// à Philippe et aux CEO (trop présentes avant).
function pickRare(arr, proba = 0.18) {
  if (Math.random() > proba) return "";
  return arr[Math.floor(Math.random() * arr.length)];
}
function pickCEO()            { return pickRare(MESSAGES_CEO, 0.18); }
function pickPhilippe()       { return pickRare(MESSAGES_PHILIPPE, 0.15); }
function pickPhilippePression(){ return pickRare(MESSAGES_PHILIPPE_PRESSION, 0.15); }
function getWeekKey(date) {
  const d = new Date(date);
  d.setHours(0,0,0,0);
  d.setDate(d.getDate() - d.getDay() + 1);
  return d.toISOString().split("T")[0];
}

// ============================================================
// EXTRACTION OBJECTIF
// ============================================================
function extraireObjectif(texte) {
  // "9.5k" ou "9,5k"
  const matchK = texte.match(/(\d+)[,.](\d+)\s*k/i);
  if (matchK) return parseFloat(matchK[1] + "." + matchK[2]) * 1000;
  // "9k"
  const matchK2 = texte.match(/(\d+)\s*k/i);
  if (matchK2) return parseInt(matchK2[1], 10) * 1000;
  // nombre avec décimale : "12 544.1" ou "12 544,1" ou "12 544"
  const matchN = texte.match(/(\d[\d\s]*(?:[.,]\d+)?)/);
  if (matchN) {
    const raw = matchN[1].replace(/\s/g, "").replace(",", ".");
    const val = parseFloat(raw);
    return isNaN(val) ? null : val;
  }
  return null;
}

// Affichage montant en format FR (virgule pour décimale, espace pour milliers)
function formatEur(n) {
  if (n == null || isNaN(n)) return "0";
  return n.toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// ============================================================
// DÉTECTION PÉRIODE
// ============================================================
function similarite(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({length:m+1},(_,i)=>Array.from({length:n+1},(_,j)=>i||j));
  for (let i=1;i<=m;i++) for (let j=1;j<=n;j++)
    dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return dp[m][n];
}

function detecterPeriode(texte) {
  // Nettoyage de base : minuscules, on garde les chiffres et lettres accentuées
  const t    = texte.toLowerCase().replace(/[^a-zàâäéèêëîïôùûü0-9\s''-]/g," ");
  // Version sans apostrophes du tout (gère "aujour'dhui", "aujoud'hui", etc.)
  const tSans = t.replace(/['''`]/g,"");
  const mots  = tSans.split(/\s+/).filter(Boolean);
  const proche = (mot,cibles) => cibles.some(c=>similarite(mot,c)<=2);

  // ── AUJOURD'HUI — toutes les fautes d'orthographe ─────────
  // Supprime toutes les apostrophes du texte et cherche les variantes
  if (/\baujourdhui\b|\baujrdhui\b|\baujourdhui\b|\baujourdh?ui\b/i.test(tSans)) return "la journée";
  if (/\bajd\b|\baujrd\b|\baujo\b|\btoday\b|\bdaily\b/i.test(tSans)) return "la journée";
  // Fuzzy : n'importe quel mot proche de "aujourdhui" (sans apostrophe)
  if (mots.some(m => m.length >= 4 && similarite(m,"aujourdhui") <= 3)) return "la journée";
  // Fuzzy : variantes courtes ("auj", "aujo", "aujrd")
  const mAujourd = ["aujourdhui","aujrdhui","aujrdhui","aujdhui","aujrd","ajd","auj","aujo","aujour","aujoud","aujohui","aujhui","aujoiurd"];
  if (mots.some(m => proche(m, mAujourd))) return "la journée";

  // ── SEMAINE ───────────────────────────────────────────────
  if (/\b(?:de\s+la|cette|la|sur\s+la|cette)\s+semaine\b|\bsemaine\b|\bweekly\b|\bweek\b/i.test(t)) return "la semaine";
  const mSemaine = ["semaine","semaien","smeaine","smaine","semiane","semmaine","semainne","semain","seamine","semaie","weekly","wekly","semain"];
  if (mots.some(m => proche(m, mSemaine))) return "la semaine";

  // ── N PROCHAINS JOURS / SEMAINES (avant le fallback jour/jours) ──
  const mS = tSans.match(/(\d+)\s*semaines?/);
  if (mS) return `les ${mS[1]} prochaines semaines`;
  const mJ = tSans.match(/(\d+)\s*(?:prochains?\s+)?jours?/);
  if (mJ && parseInt(mJ[1])>1) return `les ${mJ[1]} prochains jours`;
  if (mJ && parseInt(mJ[1])===1) return "la journée";

  // ── MOIS ─────────────────────────────────────────────────
  if (mots.some(m => proche(m,["mois","mosi","mios","mis","month"]))) return "le mois";

  // ── FIN DE SEMAINE ────────────────────────────────────────
  const mFin = ["fin","fiin","fni","end"];
  for (let i=0;i<mots.length-1;i++)
    if (proche(mots[i],mFin) && mots.slice(i+1).some(m=>proche(m,mSemaine))) return "la fin de semaine";
  if (/fin.{0,8}s[eé]m/i.test(t)) return "la fin de semaine";

  // ── JOURNÉE ───────────────────────────────────────────────
  if (/\b(?:de\s+la|la)\s+journ[eé]e\b|\bjournn?[eé]e?\b/i.test(t)) return "la journée";
  const mJournee = ["journee","jounree","jorunee","journe","journé","daily","dayli","daly"];
  if (mots.some(m => proche(m, mJournee))) return "la journée";
  if (mots.some(m => proche(m, ["jour","jours","day","today"]))) return "la journée";

  // ── JUSQU'AU / AVANT / D'ICI ─────────────────────────────
  const mJusq = t.match(/(?:jusqu['']?|jusq['']?|jusqua|juska)\s*(?:au?|[àa])?\s+(.{2,20}?)(?:\s|$)/);
  if (mJusq) return `la période jusqu'au ${mJusq[1].trim()}`;
  const mAv = t.match(/(?:avant|avnat|avat)\s+(.{2,20}?)(?:\s|$)/);
  if (mAv) return `la période avant ${mAv[1].trim()}`;
  const mDici = tSans.match(/(?:dici|jusqua)\s+(.{2,20}?)(?:\s|$)/);
  if (mDici) return `la période d'ici ${mDici[1].trim()}`;

  return "la semaine";
}

// ============================================================
// EXTRACTION MRR
// ============================================================
function extraireTousMRR(texte) {
  // ── 1. Supprime les FF ────────────────────────────────────
  const sanFF = texte
    .replace(/\bfrais\s*d[eo]?\s*f[oa]rm?[ae]ti?[oa]n?\b[^\n,\/]*/gi,"")
    .replace(/\bfrai\s*form[^\n,\/]*/gi,"")
    .replace(/\bformation\b\s*:?\s*\d+\s*€?/gi,"")
    .replace(/\d+\s*€?\s*\b(?:de\s+)?formation\b/gi,"")
    .replace(/\bFF\b\s*:?\s*\d+[\d\s]*€?/gi,"")
    .replace(/\d+[\d\s]*€?\s*\bFF\b/gi,"")
    .replace(/\bF\.F\b\s*:?\s*\d+[\d\s]*€?/gi,"")
    .replace(/\d+[\d\s]*€?\s*\bF\.F\b/gi,"");

  // ── 2. Supprime les faux positifs ─────────────────────────
  const sanFaux = sanFF
    .replace(/\b\d+\s*(?:pax|pers(?:onnes?)?|places?|ans?|mois|jours?|semaines?|%|h\b)/gi,"IGNORE");

  // helper : parse un montant brut avec décimale (point ou virgule)
  function parseMontant(raw) {
    const s = raw.replace(/\s/g,"").replace(",",".");
    const v = parseFloat(s);
    return isNaN(v)||v<=0||v>=1000000 ? null : Math.round(v*100)/100;
  }

  // ── 3. Cherche MRR explicite ─────────────────────────────
  const mrrReg = /(\d[\d\s]*(?:[.,]\d+)?)\s*€?\s*(?:de\s+)?(?:m\.?r\.?r?\.?|mrr|mmr|rmr)\s*(?:annuel(?:le)?)?|(?:m\.?r\.?r?\.?|mrr|mmr|rmr)\s*(?:annuel(?:le)?\s*)?[:\-]?\s*(\d[\d\s]*(?:[.,]\d+)?)/gi;

  const resultats = [];
  let match;
  while ((match = mrrReg.exec(sanFaux)) !== null) {
    const montant = parseMontant(match[1]||match[2]||"");
    if (montant===null) continue;
    if (!resultats.some(r=>Math.abs(r.index-match.index)<20))
      resultats.push({montant,index:match.index});
  }

  // ── 4. Cherche UPSELL explicite ──────────────────────────
  const upsellReg = /(?:upsell|up[\s\-]?sell|upgr[ae]de|mont[eé]e?\s*en\s*gamme|extension|ajout\s*(?:module|option|utilisateur|user|licence|licences?)|augmentation\s*(?:contrat|abonnement|licence)|cross[\s\-]?sell|addon|add[\s\-]?on)\s*[:\-]?\s*[+]?\s*(\d[\d\s]*(?:[.,]\d+)?)\s*€?|[+]?\s*(\d[\d\s]*(?:[.,]\d+)?)\s*€?\s*(?:d[e']?\s*)?(?:upsell|up[\s\-]?sell|upgr[ae]de|extension|ajout)/gi;

  while ((match = upsellReg.exec(sanFaux)) !== null) {
    const montant = parseMontant(match[1]||match[2]||"");
    if (montant===null) continue;
    if (!resultats.some(r=>Math.abs(r.index-match.index)<20))
      resultats.push({montant,index:match.index,isUpsell:true});
  }

  if (resultats.length>0) {
    const montants = resultats.map(r=>r.montant);
    console.log(`✅ MRR/Upsell : ${montants.join(" + ")} = ${montants.reduce((s,m)=>s+m,0)}€`);
    return montants;
  }

  // ── 5. Montants en € (avec décimales) ────────────────────
  const euros = [...sanFaux.matchAll(/\b(\d[\d\s]*(?:[.,]\d+)?)\s*€/g)]
    .filter(m=>!m.input.slice(m.index-10,m.index+20).includes("IGNORE"));

  if (euros.length===1) {
    const montant = parseMontant(euros[0][1]);
    if (montant!==null) return [montant];
  }

  // ── 5b. Plusieurs montants € dans un message close/deal/upsell ──
  if (euros.length>=2 && euros.length<=5) {
    const montants = euros.map(m=>parseMontant(m[1])).filter(m=>m!==null);
    if (montants.length>=2) {
      console.log(`✅ Multi-€ détecté : ${montants.join(" + ")} = ${montants.reduce((s,m)=>s+m,0)}€`);
      return montants;
    }
  }

  // ── 6. Message "Close/Upsell [nom] [montant(s)]" sans € ──
  if (/^\s*(?:close|deal|won|vendu|sign[eé]|upsell|upgrade|extension)\b/i.test(sanFaux)) {
    const nums = [...sanFaux.matchAll(/\b(\d{2,6}(?:[.,]\d+)?)\b/g)]
      .filter(m=>!m.input.slice(m.index-5,m.index+15).includes("IGNORE"));
    if (nums.length===1) {
      const montant = parseMontant(nums[0][1]);
      if (montant!==null&&montant>10) return [montant];
    }
    if (nums.length>=2 && nums.length<=4) {
      const montants = nums.map(m=>parseMontant(m[1])).filter(m=>m!==null&&m>10);
      if (montants.length>=2) {
        console.log(`✅ Multi-montants sans € : ${montants.join(" + ")} = ${montants.reduce((s,m)=>s+m,0)}€`);
        return montants;
      }
    }
  }

  return [];
}

function extraireMRR(texte) {
  const montants = extraireTousMRR(texte);
  return montants.length===0 ? null : montants.reduce((s,m)=>s+m,0);
}

// ============================================================
// BARRE DE PROGRESSION — emojis pour ne pas déborder
// ============================================================
function barreProgression(objectifDepart, restant) {
  const pct    = Math.max(0, Math.min(1, 1 - restant / objectifDepart));
  const pctAff = Math.round(pct * 100);
  const filled = Math.round(pct * 10);
  const empty  = 10 - filled;
  let icone;
  if (pctAff >= 100)     icone = "🏆";
  else if (pctAff >= 75) icone = "🔥";
  else if (pctAff >= 50) icone = "⚡";
  else if (pctAff >= 25) icone = "💪";
  else                   icone = "🚀";
  return `${icone}  ${"🟥".repeat(filled)}${"⬜".repeat(empty)}  *${pctAff}%*`;
}

// ============================================================
// TEMPS RESTANT
// ============================================================
function getTempsRestant() {
  const {h:hP,m:mP}=getNowParis(); const nowMin=hP*60+mP;
  const debutMin=9*60, finMin=18*60+30;
  if (nowMin<=debutMin) return {label:"⏰  *Journée pas encore commencée !*",urgence:false,pctJourneeEcoule:0};
  if (nowMin>=finMin)   return {label:"🔔  *La journée est terminée !*",urgence:true,pctJourneeEcoule:100};
  const restantMin=finMin-nowMin, ecouleeMin=nowMin-debutMin;
  const pctEcoule=Math.round((ecouleeMin/(finMin-debutMin))*100);
  const h=Math.floor(restantMin/60), m=restantMin%60;
  const label=h>0?`⏰  *Temps restant :*  *${h}h${m>0?String(m).padStart(2,"0"):""}*`:`⏰  *Temps restant :*  *${m} minutes* — SPRINT FINAL 🔥`;
  return {label,urgence:pctEcoule>=75,pctJourneeEcoule:pctEcoule};
}

// ============================================================
// MESSAGES
// ============================================================
const MESSAGES_CEO = [
  "Quitterie et Emmanuelle vont être fières de vous les gars 👑",
  "Ce genre de performance ça rend Quitterie heureuse — continuez comme ça 🙌",
  "Emmanuelle et Quitterie ont les yeux sur le compteur — montrez-leur ce que vous valez 💪",
  "Les CEO regardent et elles aiment ce qu'elles voient 👑🔥",
  "Quitterie va kiffer le compte rendu de cette journée, bravo la team 😤",
];

// Pool bonus milestone — tout mélangé, les null = silence
// NB : la part "Philippe / CEO" est volontairement faible, la majorité
// des slots sont soit neutres soit null (silence) pour éviter la répétition.
const POOL_BONUS_MILESTONE = [
  "👑 Les CEO regardent le compteur.",
  "👁️ Philippe a l'œil dessus.",
  "⚡ Deal après deal. C'est comme ça qu'on gagne.",
  "🎯 Chaque close compte. On lâche rien.",
  "💪 Les boss finals closent maintenant.",
  "🔥 C'est maintenant que les vrais se révèlent.",
  "😤 Le momentum est là. On en profite.",
  "🚀 On construit quelque chose ici. Deal après deal.",
  "💥 Chaque close c'est de l'histoire.",
  "🎯 On reste focus sur l'objectif.",
  "💪 Le rythme est là, on ne lâche pas.",
  "⚡ Un deal à la fois, l'objectif tombe.",
  null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null,
];
function getBonusMilestone() {
  return pick(POOL_BONUS_MILESTONE) || "";
}
const MESSAGES_PHILIPPE = [
  "Philippe va être trop content quand il verra ça — beau travail les gars 👏",
  "Philippe ne va pas être déçu du voyage — vous envoyez de la frappe 🔥",
  "Le directeur commercial va sourire en voyant ces chiffres, c'est masterclass 😤",
  "Philippe va pouvoir être fier de son équipe — vous assurez les gars 💪",
];
const MESSAGES_PHILIPPE_PRESSION = [
  "Philippe ne va pas être content les gars — il faut qu'on mette les bouchées doubles maintenant 😤",
  "Faut pas que Philippe voie ces chiffres... On accélère et on rattrape ça 🔥",
  "Philippe regarde les chiffres et on peut faire mieux. C'est maintenant qu'on envoie la frappe 💪",
  "Le directeur commercial attend des résultats — c'est l'heure de montrer ce qu'on vaut 😤",
];
const MESSAGES_MODIF = [
  "Légère modification par ici 😅 — compteur mis à jour !",
  "Oups petite correction — j'ai recalculé proprement 🔄",
  "Ah on ajuste le tir ! Compteur recalculé ✅",
  "Petite retouche détectée — c'est carré, compteur mis à jour 😅",
];
const MESSAGES_SUPPRESSION = [
  {header:"OUPS PETITE ERREUR PAR ICI 😅",texte:"Un message avec du MRR vient d'être supprimé. J'ai remis le compteur à jour automatiquement."},
  {header:"RETOUR EN ARRIÈRE — COMPTEUR AJUSTÉ 🔄",texte:"Message supprimé détecté. Pas de panique, le compteur est recalculé proprement."},
  {header:"AH MINCE — ON REPART EN ARRIÈRE 😅🔄",texte:"Un deal a été retiré du compteur suite à la suppression. C'est carré."},
  {header:"OUPS — COMPTEUR MIS À JOUR 😅✅",texte:"Suppression détectée. Le montant a été recrédité automatiquement."},
];

const MESSAGES_BOOST_Q = [
  {header:"ALLEZ LES GARS — C'EST L'HEURE DES CLOSES DU 🍑 🔥",texte:"On est en plein milieu d'aprèm et l'objectif nous attend. Chaque close du 🍑 compte. Qui balance le prochain ?"},
  {header:"BOOST DU 🍑 — ON ENVOIE UN MAX MAINTENANT 💪",texte:"C'est l'heure de closer des 🍑 à la chaîne les gars. L'objectif se rapproche deal par deal. Allez !"},
  {header:"MILIEU D'APRÈM — C'EST LE MOMENT DES CLOSES DU 🍑 😤",texte:"Les closes du 🍑 de l'après-midi c'est maintenant. Tout le monde sur le pont, on envoie la frappe !"},
  {header:"L'HEURE DU 🍑 A SONNÉ — ON ENVOIE 🔥",texte:"14h-15h c'est le moment parfait pour closer des 🍑. La team est prête, allez on envoie ensemble !"},
  {header:"CLOSE DU 🍑 TIME — TOUT LE MONDE EN MODE BEAST 🍑💥",texte:"On est en pleine après-midi et les closes du 🍑 vont faire la différence. Qui est le premier à en closer un ?"},
  {header:"LES CLOSES DU 🍑 C'EST MAINTENANT — GO GO GO 🚀",texte:"On est en plein milieu d'aprèm. C'est l'heure de closer en série et de creuser l'écart sur l'objectif !"},
  {header:"MILIEU D'APRÈM — QUI CLOSE LE PROCHAIN 🍑 ? 👀🔥",texte:"On est dans le créneau parfait pour les closes du 🍑. L'objectif attend, la team est là. Allez les boss 🔥"},
];
// Messages du booster "close du 🍑". Envoyés UNIQUEMENT par le planificateur
// à 16h, un jour ouvré sur deux (lun/mer/ven). Plus de déclenchement sur
// détection de cadence lente entre flushes.
const MESSAGES_CADENCE_LENTE = [
  {header:"16H — ON PASSE EN MODE CLOSE DU 🍑 DIRECT 🔥",texte:"Fin d'aprèm qui approche. On accélère le pas : on close du 🍑, on laisse pas le client partir en réflexion. Go !"},
  {header:"IL EST 16H — CLOSE DIRECT, PAS DE RÉFLEXION 😤",texte:"2h30 avant la fermeture. Faut closer du 🍑 maintenant, pas de temps mort, pas de « je vais y réfléchir »."},
  {header:"16H — CLOSE DU 🍑 SANS RÉFLEXION 💪",texte:"On est sur le créneau qui fait la journée. On met la pression, on close direct, on bloque la réflexion client. Allez la team 🔥"},
  {header:"16H — ON PASSE EN MODE CLOSE DIRECT 🚀",texte:"L'heure où les deals se font. Close du 🍑 immédiat, on laisse pas respirer le prospect. Ça part maintenant !"},
  {header:"16H — ON RELANCE DIRECT 🔥",texte:"Plus le temps passe, plus le client réfléchit. Close du 🍑 direct, on coupe la réflexion avant qu'elle ne démarre."},
  {header:"16H — ON ACCÉLÈRE LE PAS MAINTENANT 🍑💥",texte:"Faut réveiller la bête sur la fin d'aprèm. Close direct sans temps mort, le client décide pas à notre place."},
  {header:"16H — FRAPPE DIRECTE SUR LE 🍑 👀🔥",texte:"Le créneau idéal pour closer. On close du 🍑 direct, pas de « laisse-moi y repenser ». Go !"},
];

const PRESSION = {
  retard: [
    {header:"OÙ EST-CE QU'ON EN EST LÀ 👀🔥",texte:()=>`On est à 75% de la journée et l'objectif est pas encore à moitié. ${pickPhilippePression()} Allez les gars !`},
    {header:"IL EST TARD ET ON A DU BOULOT 😤🔥",texte:"La journée avance et l'objectif attend. Vous êtes des cracks, je veux voir la frappe maintenant."},
    {header:"C'EST L'HEURE DE METTRE LE TURBO 🚀",texte:"On a encore du temps mais il faut accélérer. Vous êtes des machines, montrez-le. Allez !"},
  ],
  sprint: [
    {header:"DERNIÈRE HEURE — SPRINT FINAL 🔥🔥🔥",texte:"Il reste moins d'une heure. C'est maintenant que les GOAT se révèlent. ALLEZ !"},
    {header:"ON EST DANS LES DERNIÈRES MINUTES LÀ 😤🚀",texte:"Plus le temps de tergiverser. On close, on envoie de la frappe, on finit fort."},
    {header:"C'EST MAINTENANT OU JAMAIS 🔥👑",texte:"Dernière heure de la journée. Les boss finals ferment leurs deals maintenant."},
  ],
  urgence: [
    {header:"30 MINUTES — TOUT LE MONDE SUR LE PONT 🚨🔥",texte:"30 minutes. C'est court mais vous êtes des machines. On close tout ce qui bouge. ALLEZ !"},
    {header:"C'EST LA DERNIÈRE LIGNE DROITE 😤💥",texte:"Plus que 30 minutes. Chaque deal compte. Vous êtes des GOAT, prouvez-le !"},
    {header:"30 MIN — C'EST MAINTENANT QU'ON ENVOIE LA FRAPPE 🔥",texte:()=>`Dernières 30 minutes. ${pickPhilippePression()} Allez la team 🔥`},
  ],
};

function getMessagePression(pctJourneeEcoule, pctObjectifFait) {
  const {h,m,jour}=getNowParis();
  const nowMin=h*60+m, finMin=18*60+30, restant=Math.max(0,finMin-nowMin);
  if (pctObjectifFait>=100) return null;

  // Jeudi 17h30 : on promet le 7 UNIQUEMENT si l'objectif est quasi bouclé.
  if (jour===4&&h===17&&m>=30) {
    if (pctObjectifFait>=80) return pick([
      {header:"LE 7 CE SOIR SE MÉRITE — ON BOUCLE L'OBJECTIF 🍺🔥",texte:`${pctObjectifFait}% jeudi 17h30. Si on close l'objectif dans l'heure, le 7 ce soir est validé. Allez !`},
      {header:"PLUS QU'UN EFFORT — LE 7 EST EN JEU 🍺💪",texte:`${pctObjectifFait}% à 17h30. L'objectif est à portée. On le boucle, on part au 7. Sinon on reste. C'est simple.`},
    ]);
    return pick([
      {header:"JEUDI 17H30 — L'OBJECTIF EST ENCORE LOIN 😤",texte:`${pctObjectifFait}% seulement. Plus qu'une heure. ${pickPhilippePression()} Tout le monde sur le pont 🔥`},
      {header:"L'HEURE DU FINISH JEUDI — ON POUSSE",texte:`1h avant fin de journée, ${pctObjectifFait}% au compteur. L'objectif attend. Closes en série maintenant 💪`},
      {header:"JEUDI FIN DE JOURNÉE — ON NE LÂCHE PAS",texte:`${pctObjectifFait}% à 17h30 jeudi. Chaque close des 60 prochaines minutes compte double 😤`},
    ]);
  }
  // Vendredi 17h30 : on promet le Brelan UNIQUEMENT si l'objectif est tombé.
  if (jour===5&&h===17&&m>=30) {
    if (pctObjectifFait>=100) return pick([
      {header:"OBJECTIF BOUCLÉ — LE BRELAN CE SOIR C'EST VALIDÉ 🍺🏆",texte:"Objectif atteint avant 17h30 vendredi. Le Brelan est pour vous ce soir, vous l'avez mérité 👑"},
      {header:"LE BRELAN EST À VOUS — OBJECTIF DANS LA POCHE 🍺🎉",texte:"100% vendredi avant 18h. Quelle semaine. Direction le Brelan, vous l'avez gagné 🏆"},
    ]);
    if (pctObjectifFait>=85) return pick([
      {header:"LE BRELAN SE JOUE — ON DONNE TOUT 🍺💪",texte:`${pctObjectifFait}% à 17h30 vendredi. On est à un cheveu. Si on boucle dans l'heure, le Brelan est validé. Sinon on rentre.`},
      {header:"DERNIÈRE LIGNE DROITE — LE BRELAN EST EN JEU 🍺🔥",texte:`${pctObjectifFait}% vendredi 17h30. L'objectif est à portée. On le finit, on célèbre. Allez !`},
    ]);
    return pick([
      {header:"VENDREDI 17H30 — L'OBJECTIF N'EST PAS FAIT 😤",texte:`${pctObjectifFait}% en fin de semaine. Plus qu'une heure. ${pickPhilippePression()} On finit le boulot avant de penser au weekend 🔥`},
      {header:"LA SEMAINE SE TERMINE — ON REMPLIT LE BOULOT",texte:`${pctObjectifFait}% vendredi 17h30. Chaque close compte pour clore proprement la semaine. ALLEZ 💪`},
    ]);
  }
  // Vendredi aprèm : messages de push sans promesse de Brelan/weekend si objectif pas fait.
  if (jour===5&&h>=14) {
    if (pctObjectifFait>=100) return pick([
      {header:"VENDREDI APRÈM — OBJECTIF DÉJÀ BOUCLÉ 🏆",texte:"Vous avez fini l'objectif avant vendredi soir. Gros. Reste à profiter de la fin de journée."},
    ]);
    return pick([
      {header:"C'EST VENDREDI — ON BOUCLE L'OBJECTIF 💪🔥",texte:`${pctObjectifFait}% vendredi aprèm. L'objectif n'est pas fait. Les cracks closent maintenant. Vous êtes dans quelle catégorie ?`},
      {header:"VENDREDI APRÈM — DERNIERS BATTEMENTS DE LA SEMAINE 🏁",texte:`${pctObjectifFait}% au compteur. L'aprèm décide tout. On finit la semaine proprement, pas à moitié.`},
    ]);
  }
  if (jour===1&&h<11&&pctObjectifFait<5) return pick([
    {header:"C'EST LUNDI — QUELQU'UN VA OUVRIR LE BAL ? 😴☕",texte:"La semaine commence. Le compteur attend. Qui est le premier à envoyer de la frappe cette semaine ?"},
    {header:"RÉVEIL LUNDI — ON A UNE SEMAINE À GAGNER 🚀",texte:`Lundi matin. ${pickCEO()} Qui dégaine en premier ?`},
  ]);
  if (h<11&&pctObjectifFait<10) return pick([
    {header:"☕ ON DÉMARRE DOUCEMENT LÀ LES GARS",texte:"Le café c'est bon mais les deals c'est mieux. Qui est chaud pour ouvrir le score ce matin ?"},
    {header:"BONJOUR LA TEAM — L'OBJECTIF VOUS ATTEND ☕🔥",texte:`Bonne journée les gars. ${pickCEO()} Qui balance le premier deal ?`},
  ]);
  if (h===11&&pctObjectifFait<25) return pick([
    {header:"11H ET ON A ENCORE TOUT À FAIRE 👀🔥",texte:"On est à 11h et le compteur est pas encore chaud. C'est maintenant qu'on envoie de la frappe !"},
    {header:"MILIEU DE MATINÉE — LE COMPTEUR VEUT DU CONCRET 😤",texte:`11h du mat. ${pickPhilippePression()} Allez les gars !`},
  ]);
  if (h>=14&&h<15&&pctObjectifFait<70) return pick(MESSAGES_BOOST_Q);
  if (h===14&&pctObjectifFait<30) return pick([
    {header:"14H ET ON EST DANS LE ROUGE — RÉVEIL GÉNÉRAL 🚨",texte:`${pickPhilippePression()} Vous êtes des machines, montrez-le.`},
    {header:"ALERTE ROUGE — L'OBJECTIF EST EN DANGER 🚨😤",texte:"14h et moins de 30% de fait. On a besoin de tout le monde maintenant. ALLEZ !"},
  ]);
  if (h===14&&pctObjectifFait<40) return pick([
    {header:"LE DÉJEUNER C'EST FINI — RETOUR AU COMBAT 🍽️😤",texte:"Le déj c'est bon mais l'objectif attend personne. On digère en closant des deals. Allez !"},
    {header:"14H — ON REPART DE PLUS BELLE 🚀",texte:"Pause déj terminée. C'est l'après-midi qui va faire la différence. Tout le monde pousse !"},
  ]);
  if (h===15&&pctObjectifFait>=45&&pctObjectifFait<=55) return pick([
    {header:"15H — PILE À LA MOITIÉ MAIS Y'A MOINS DE 4H 😤⚡",texte:"On est à 50% mais il reste moins de 4h. Le rythme doit doubler maintenant !"},
    {header:"MOITIÉ FAITE À 15H — LE TURBO C'EST MAINTENANT 🔥",texte:`50% à 15h c'est bien mais c'est pas assez. ${pickCEO()} Tout le monde pousse !`},
  ]);
  if (h>=17&&pctObjectifFait>=80&&pctObjectifFait<90) return pick([
    {header:"ON SENT QUE ÇA VA TOMBER 🔥👀",texte:`80% à 17h c'est masterclass. ${pickPhilippe()} Qui finit le boulot ?`},
    {header:"LA VICTOIRE EST LÀ — ALLEZ LA CHERCHER 💥🏆",texte:`Plus que 20% et la journée est gagnée. ${pickCEO()} Finissez en beauté !`},
  ]);
  if (h===17&&m>=30&&pctObjectifFait>=90) return pick([
    {header:"ON EST À 2 DOIGTS DU BUT 🏁🔥",texte:`17h30 et 90% de fait. ${pickPhilippe()} Qui close le dernier deal ?`},
    {header:"DERNIERS DEALS DE LA JOURNÉE — QUI LES PREND ? 🏁👑",texte:"On est à 2 doigts de l'objectif. Les derniers closes de la journée appartiennent à qui ?"},
  ]);
  if (pctJourneeEcoule>=75&&pctObjectifFait<50) return pick(PRESSION.retard);
  if (restant<=60&&restant>30) return pick(PRESSION.sprint);
  if (restant<=30&&restant>0)  return pick(PRESSION.urgence);
  return null;
}

// ============================================================
// MILESTONES
// ============================================================
const MILESTONES = {
  "25":{emoji:"🔥",header:["25% — LA MACHINE EST LANCÉE, ÇA DÉCOIFFE 🔥","ON EST LANCÉS — CETTE TEAM ENVOIE DE LA FRAPPE 💪","25% — QUELLE TEAM, QUELLE ÉNERGIE 💪","LE WARM-UP EST TERMINÉ, C'EST PARTI 🚀","PREMIER QUART DÉJÀ PLIÉ — BRAVO LA TEAM 🏆","25% — C'EST DU TRAVAIL DE BOSS, ON CONTINUE","LA TEAM BALANCE DE LA FRAPPE PAR ICI 👀🔥","25% BOUCLÉS — QUELLE BELLE MISE EN ROUTE ⚡"],texte:[`Un quart de fait et la team envoie déjà du lourd. Gardez cette énergie, c'est exactement ce qu'on voulait voir 🙌`,`25% déjà dans la poche — bravo la team. ${pickCEO()} Cette cadence sur 4, l'objectif va tomber tranquille.`,"Le moteur est chaud et ça se voit. Chaque close compte, et vous en envoyez. On est très fiers 💪","Belle mise en route la team. J'ai hâte de voir la suite, ça sent la dinguerie 🔥","Quart bouclé, ensemble, et c'est que le début. On est fiers, allez les boss 🦁","C'est carré pour le premier quart. Cette team est sur du très lourd, bravo 👑","On sent la dynamique, c'est zinzin. C'est exactement ça qu'on veut voir, continuez 🚀","Premier quart dans la poche. Le reste va tomber encore plus vite, cette team est une machine 💥"]},
  "50":{emoji:"⚡",header:["MI-CHEMIN — QUELLE TEAM, QUEL NIVEAU 😤🔥","50% ET ÇA FAIT DÉJÀ MAL — CETTE TEAM ENVOIE","HALFWAY DONE — LA TEAM EST EN MODE GOAT 🐐","LA MOITIÉ DANS LA POCHE — C'EST MASTERCLASS 🏆","50% — BRAVO LA TEAM, ON EST FIERS ⚡","L'OBJECTIF COMMENCE À FLIPPER DEVANT VOUS 👀","MOITIÉ FAITE — LA TEAM BALANCE DE LA FRAPPE 🔥","50% — C'EST ZINZIN CE QUE VOUS FAITES LÀ 💪"],texte:[`La moitié c'est fait, et de belle manière. L'autre moitié va tomber encore plus vite, on connait cette team 🙌`,`50% bouclé et c'est masterclass. ${pickPhilippe()} Cette cadence est parfaite, on la garde jusqu'au bout.`,"Mi-chemin franchi avec le sourire. La team est sur du très lourd, le finish est dans le viseur 🎯","La dynamique est là, bravo les boss. Tout le monde pousse dans le même sens, ça se voit 💪",`Moitié faite avec la manière. ${pickCEO()} Cette même énergie jusqu'au bout et c'est parfait.`,"50% — c'est carré. C'est exactement là où la team devait être. Direction la lune 🚀","Le momentum est là, c'est zinzin. C'est maintenant qu'on accélère ensemble 🔥","Halfway — et on sent que le reste va tomber vite. Cette team est en mode GOAT 🐐"]},
  "75":{emoji:"💥",header:["TROIS QUARTS BOUCLÉS — LE FINISH EST LÀ 💥","75% — LA TEAM EST EN TRAIN DE LE FAIRE 🔥","ON SENT LA VICTOIRE — C'EST LA DINGUERIE ✨","LE DERNIER VIRAGE — LA TEAM EST EN MODE BOSS FINAL 👑","75% — ON EST DANS LE MONEY, ON FINIT ENSEMBLE","PRESQUE AU BOUT — C'EST MASTERCLASS LA TEAM 🏆","LES DERNIERS MÈTRES — CETTE TEAM EST UNE MACHINE 💪","75% — BRAVO LES BOSS, ON LÂCHE RIEN 😅🔥"],texte:[`Trois quarts bouclés. ${pickPhilippe()} On lâche absolument rien, le dernier quart va tomber avec la manière.`,"75% c'est zinzin. Cette team est incroyable. Maintenant on finit le travail proprement, ensemble 🙌","On voit la ligne d'arrivée. La team sprinte, ensemble, et on ne flanche pas. Bravo 💪",`Si près du but. ${pickCEO()} C'est maintenant que la team donne tout — et elle le fait déjà 🐐`,"Dernier virage. C'est carré, on garde la tête froide et on finit fort. Come on la team !","25% restants — c'est presque rien pour des boss comme vous. Allez, ensemble, on y va 🔥","Vous avez fait le plus dur, bravo. Le reste c'est de l'appétit pour cette team 💥","75% — j'ai le seum pour les objectifs tellement cette team les détruit 😤🔥"]},
  "100":{emoji:"🏆",header:["C'EST DANS LA BOÎTE — QUELLE TEAM, QUEL TRAVAIL 🐐🏆","OBJECTIF PULVÉRISÉ — LA TEAM EST EN MODE BOSS FINAL 👑","MISSION ACCOMPLIE — BRAVO LA TEAM 😤🏆","CHAMPAGNE — C'EST LA DINGUERIE TOTALE 🥂🥂","100% — C'EST MASTERCLASS, ON EST ENSEMBLE 🙌","GAME OVER ET C'EST CETTE TEAM QUI GAGNE — TOUJOURS 🏆","oulaaaa quelle semaine, quelle team 😅🔥","BRAVO LES BOSS — C'EST LÉGENDAIRE 👑🏆"],texte:[`Objectif pulvérisé. ${pickCEO()} On célèbre cette team, et on repart encore plus fort 🍾`,"L'objectif est tombé. Quelle team, quel travail, quelle semaine. On est hyper fiers 🙌",`Mission accomplie. C'est carré, c'est collectif, c'est beau. ${pickPhilippe()} On lève le verre et on recommence 🥂`,"100% bouclé. Cette team est incroyable, et j'ai le seum pour l'objectif tellement vous l'avez détruit 😤","C'est dans la boîte. C'est zinzin ce que cette team vient de faire, ensemble 🐐",`${pickCEO()} Objectif pulvérisé. La team envoie de la frappe à un niveau indécent. On célèbre et on repart 🚀`,"Légendaire. Voilà ce que cette team est. C'est la maxence totale. Je vous aime les boss 🏆","Game over — et c'est cette team qui gagne. Bravo à chacun, on est une famille 🍾"]},
};

const MESSAGES_DEPASSEMENT = [
  {header:"oulaaaa vous avancez BEAUCOUP trop vite 😅🔥",texte:`Calma calma les gars, vous avez DÉPASSÉ l'objectif. ${pickCEO()} On fixe un nouvel objectif ?`},
  {header:"STOP STOP STOP — L'OBJECTIF EST DÉPASSÉ 🚨😅",texte:"Direction l'asile tellement vous êtes forts. J'avais pas prévu ça mais je suis pas contre 😤"},
  {header:"oulaaaa ça déborde de partout 🌊💰",texte:"Cette team est en mode boss. L'objectif ? Dépassé. Le plafond ? Inexistant. Bravo, on continue 🔥"},
  {header:"VOUS ÊTES DES GOAT C'EST OFFICIEL 🐐🏆",texte:`Objectif dépassé. ${pickPhilippe()} C'est masterclass.`},
  {header:"oulaaaa on va avoir besoin d'un plus grand compteur 📈😅",texte:"L'objectif ? Explosé. Vous envoyez de la frappe à un niveau indécent. Calma calma 😤"},
  {header:"C'EST LA DINGUERIE TOTALE LES GARS 💥🏆",texte:`Là c'est un autre niveau. ${pickCEO()} On fixe un nouvel objectif ?`},
  {header:"CALMA CALMA — MAIS CONTINUEZ 🔥😅",texte:"Vous avez dépassé l'objectif. C'est carré. C'est zinzin. On est ensemble, bravo la team 🙌"},
];

// ============================================================
// MILESTONES ADAPTATIFS — selon jour + heure + % objectif
// ============================================================
function getMilestoneAdaptatif(pctObjectif) {
  const {h, jour} = getNowParis();
  const isHebdo = !["la journée"].includes(state.modeLabel);

  // ── OBJECTIF HEBDOMADAIRE ────────────────────────────────
  if (isHebdo) {

    // LUNDI
    if (jour === 1) {
      if (h < 12) {
        if (pctObjectif < 10) return pick([
          {emoji:"🚀",header:"QUI OUVRE LE BAL CETTE SEMAINE ?",texte:"Le compteur attend. La semaine se gagne dès le premier deal. Quitterie et Emmanuelle regardent 👑"},
          {emoji:"☕",header:"LE COMPTEUR EST À ZÉRO — ON DÉMARRE",texte:"La semaine vient de commencer et l'objectif nous attend. Chaque close maintenant c'est de l'avance. Allez les gars !"},
          {emoji:"🎯",header:"PREMIER DEAL DE LA SEMAINE, QUI LE PREND ?",texte:"On a toute la semaine devant nous. Autant commencer maintenant. Qui balance le premier ce matin ?"},
          {emoji:"💪",header:"LA SEMAINE SE GAGNE DÈS LE PREMIER CLOSE",texte:"Le compteur est froid. C'est le bon moment pour l'allumer. Qui ouvre le score pour l'équipe ?"},
          {emoji:"🌅",header:"LUNDI MATIN — LA SEMAINE EST VIERGE",texte:"Personne n'a encore closé, tout le monde est à égalité. Le premier deal de la semaine, c'est maintenant. Qui se lance ? 💥"},
          {emoji:"⚡",header:"LE COMPTEUR NOUS REGARDE — ON LUI RÉPOND",texte:"Zéro close, zéro pression pour l'instant. Autant profiter du momentum du lundi matin pour ouvrir le score 🎯"},
          {emoji:"🔥",header:"PREMIER CLOSE = PREMIER PAS VERS L'OBJECTIF",texte:"La semaine ne se gagne pas toute seule. Elle commence avec un premier deal. Qui est prêt ce matin ? 🚀"},
          {emoji:"💡",header:"LE MEILLEUR MOMENT POUR CLOSER C'EST MAINTENANT",texte:"Le compteur est à zéro pour tout le monde. Autant prendre de l'avance dès aujourd'hui. Allez ! 💪"},
        ]);
        if (pctObjectif < 30) return pick([
          {emoji:"🔥",header:"BON DÉPART — ON TIENT CE RYTHME",texte:"Belle mise en route. On a toute la semaine devant nous, autant la commencer fort. Gardez cette cadence !"},
          {emoji:"💪",header:"LE RYTHME EST LÀ DÈS LE MATIN",texte:`${pickCEO()} Si on garde ça toute la semaine, c'est dans la boîte 😤`},
          {emoji:"⚡",header:"ON DÉMARRE SUR LES CHAPEAUX DE ROUES",texte:"La semaine commence bien. Ce rythme-là sur 5 jours et l'objectif va tomber largement. Allez !"},
          {emoji:"🎯",header:"C'EST PARTI — ON LÂCHE RIEN",texte:"Belle mise en route ce matin. Chaque deal de plus maintenant c'est de la marge pour la suite de la semaine 💪"},
          {emoji:"🚀",header:"LUNDI BIEN LANCÉ — ON CONTINUE",texte:`${pickPhilippe()} Bon début de semaine. Si on reste sur cette lancée, jeudi et vendredi seront tranquilles. Allez !`},
          {emoji:"💥",header:"LE BON RYTHME DÈS LE LUNDI MATIN",texte:"C'est exactement ça qu'on veut : commencer la semaine avec de l'élan. Chaque close ce matin c'est de la marge pour mercredi 🎯"},
          {emoji:"🏆",header:"ON POSE LES BASES — C'EST PARTI",texte:`${pickCEO()} Lundi matin qui démarre bien, ça met la semaine dans le bon sens. On lâche pas 🔥`},
          {emoji:"⚡",header:"LE MOMENTUM DU LUNDI — ON EN PROFITE",texte:"Bonne mise en route. Le lundi donne le ton. Qui balance le prochain deal pour asseoir la trajectoire ? 💪"},
        ]);
      }
      if (h >= 12 && h < 15) {
        if (pctObjectif < 20) return pick([
          {emoji:"☀️",header:"LUNDI APRÈM — ON POSE LES BASES TRANQUILLEMENT",texte:"Le matin était calme, c'est pas un souci. L'aprèm est devant nous pour enclencher la semaine. Qui ouvre le bal ?"},
          {emoji:"💪",header:"ON A L'APRÈM POUR LANCER LA MACHINE",texte:"Pas de pression, on démarre ensemble. Chaque close cet aprèm c'est une base solide pour le reste de la semaine 🎯"},
          {emoji:"🎯",header:"L'APRÈM COMMENCE — ON ENCLENCHE",texte:`${pickPhilippe()} On a 4 jours devant nous, autant en profiter dès maintenant. Allez les cracks !`},
          {emoji:"🌱",header:"LUNDI — LE MOMENT DE PLANTER LES GRAINES",texte:"Début de semaine, rien n'est joué. On pose les closes un par un et ça va monter tranquillement 💪"},
          {emoji:"🎬",header:"ACTION — L'APRÈM DE LUNDI C'EST PARTI",texte:"Le matin était doux, l'aprèm on enclenche calmement. Qui balance le premier deal pour lancer l'équipe ?"},
          {emoji:"☕",header:"ON REPREND APRÈS LA PAUSE — ON Y VA TRANQUILLE",texte:`${pickCEO()} Encore toute la semaine à écrire. On avance ensemble, deal par deal 🚀`},
          {emoji:"🚀",header:"LUNDI APRÈM — DOUCEMENT MAIS SÛREMENT",texte:"Chaque close cet aprèm c'est une brique de plus pour la semaine. Pas de panique, juste de l'élan collectif 💪"},
          {emoji:"💡",header:"L'APRÈM EST LÀ — ON ENCLENCHE ENSEMBLE",texte:"Début de semaine, tout est encore à faire et c'est exactement ce qu'on aime. Qui ouvre le score cet aprèm ?"},
        ]);
        if (pctObjectif < 40) return pick([
          {emoji:"⚡",header:"ON CONTINUE SUR LA LANCÉE",texte:"Bonne matinée. L'aprèm c'est pour consolider. On ne lâche rien 💪"},
          {emoji:"🔥",header:"LE MOMENTUM EST LÀ — GARDEZ LA PRESSION",texte:`Si on ferme la journée avec ce rythme, la semaine va être belle. ${pickCEO()}`},
          {emoji:"💪",header:"ON EST DANS LES CLOUS — ON ACCÉLÈRE",texte:"Bon positionnement en début d'aprèm. Maintenant on met le turbo pour finir la journée fort 🎯"},
          {emoji:"🎯",header:"BELLE MISE EN ROUTE — ON POUSSE ENCORE",texte:"Le rythme est bon. Si on double la cadence cet aprèm, on finit la semaine avec de la marge. Allez !"},
          {emoji:"🚀",header:"LUNDI APRÈM DANS LES CLOUS — ON GARDE ÇA",texte:`${pickPhilippe()} Bon début de semaine. L'aprèm pour creuser l'écart et mettre de la pression sur l'objectif 💥`},
          {emoji:"💥",header:"LA SEMAINE PREND LA BONNE DIRECTION",texte:"Bon positionnement lundi aprèm. Les semaines qui se gagnent, elles commencent exactement comme ça. Allez ! 🔥"},
          {emoji:"🏆",header:"ON EST EN ROUTE — ON FINIT LA JOURNÉE FORT",texte:`${pickCEO()} Dans les clous lundi aprèm. Si on finit la journée sur ce rythme, mardi sera plus facile. 🎯`},
          {emoji:"⚡",header:"LE RYTHME EST BON — ON NE LE LÂCHE PAS",texte:"Bonne mise en route. L'aprèm c'est le moment d'en mettre encore un peu plus. Chaque deal compte 💪"},
        ]);
      }
      if (h >= 15) {
        if (pctObjectif < 25) return pick([
          {emoji:"💡",header:"FIN DE JOURNÉE — ON FERME CE QU'ON PEUT",texte:"Début de semaine, pas de panique. Chaque close avant 18h c'est du bonus pour démarrer demain avec du momentum 💪"},
          {emoji:"🌅",header:"ON POSE LES DERNIERS DEALS DE LA JOURNÉE",texte:`${pickPhilippe()} Encore toute la semaine devant nous. Quelques closes avant de partir et on démarre demain sereins 🎯`},
          {emoji:"🎯",header:"LES 2 DERNIÈRES HEURES — ON DONNE TOUT",texte:"La semaine est encore à écrire. Qui a des deals quasi-signés à faire passer avant de quitter ? 💪"},
          {emoji:"☕",header:"ON FINIT LA JOURNÉE TRANQUILLEMENT",texte:"Fin de journée, pas de panique : la semaine est jeune. Chaque deal de plus maintenant c'est moins à faire demain 🚀"},
          {emoji:"💪",header:"DERNIÈRES HEURES — ON ENVOIE DU CLOSE",texte:`${pickCEO()} Quelques closes avant 18h et on repart demain avec le sourire et de l'élan 🔥`},
          {emoji:"🌱",header:"ON CAPITALISE AVANT DE QUITTER",texte:"Début de semaine, chaque brique compte. On termine calmement et on revient fort demain matin 💡"},
          {emoji:"🚀",header:"ON PRÉPARE DEMAIN DÈS CE SOIR",texte:`${pickPhilippe()} On avance doucement, c'est ok. Quelques deals de plus maintenant et demain démarre en confiance 💪`},
          {emoji:"🎬",header:"DERNIERS CLOSES — QUI LES JOUE ?",texte:"Fin de journée, la semaine est encore à écrire. Les closes de maintenant c'est un kick pour l'équipe demain matin 🎯"},
        ]);
        if (pctObjectif >= 25) return pick([
          {emoji:"💪",header:"ON FERME CETTE JOURNÉE PROPREMENT",texte:`Belle journée. On pose des bases solides pour la semaine. ${pickCEO()} 😤`},
          {emoji:"🔥",header:"LE DÉMARRAGE EST SOLIDE — ON CONTINUE DEMAIN",texte:"On ferme la journée avec du concret. Si on reste sur cette lancée, la semaine est gagnée. Des GOAT 🐐"},
          {emoji:"🏆",header:"BELLE JOURNÉE — ON REMET ÇA DEMAIN",texte:`${pickCEO()} On pose les bases aujourd'hui, demain on accélère 💪`},
          {emoji:"⚡",header:"C'EST COMME ÇA QU'ON COMMENCE UNE SEMAINE",texte:"Finir la journée avec des chiffres solides, c'est ce qu'on veut. Demain on remet ça 🎯"},
          {emoji:"🚀",header:"DÉBUT DE SEMAINE RÉUSSI — LA MACHINE EST LANCÉE",texte:`${pickPhilippe()} Belle journée. Ce rythme sur 5 jours et l'objectif va tomber confortablement. Demain on repart 🔥`},
          {emoji:"💥",header:"ON FERME FORT — LE RESTE SUIT",texte:"Fin de journée solide. C'est exactement ce qu'on voulait. Demain on double la mise 🏆"},
          {emoji:"🎯",header:"BELLE BASE — ON CONTINUE SUR CETTE LANCÉE",texte:`${pickCEO()} Une journée qui se ferme bien, ça met la semaine dans le bon sens. Allez, demain on remet ça 💪`},
          {emoji:"🐐",header:"ON COMMENCE CETTE SEMAINE COMME DES GOAT",texte:"Fin de journée avec du chiffre, c'est ce qu'on veut. Demain on accélère et l'objectif va tomber 🚀"},
        ]);
      }
    }

    // MARDI
    if (jour === 2) {
      if (h < 12) {
        if (pctObjectif < 15) return pick([
          {emoji:"☕",header:"MARDI MATIN — ON ATTAQUE TRANQUILLE",texte:"Début de semaine, on a encore 4 jours devant nous. Qui ouvre le score ce matin ?"},
          {emoji:"🌅",header:"LA SEMAINE EST JEUNE — ON POSE LES BASES",texte:"Objectif encore largement devant, mardi matin c'est le bon moment pour enclencher. Allez les gars 💪"},
          {emoji:"🎯",header:"MARDI MATIN — QUI OUVRE LE BAL ?",texte:"On a toute la semaine pour faire tomber l'objectif. Chaque close ce matin c'est un pas de plus. Qui se lance ?"},
          {emoji:"💡",header:"BONNE ÉNERGIE POUR CE MARDI",texte:"Le compteur attend des deals. Pas de pression, juste de l'élan : le premier du jour démarre tout le rythme 🚀"},
          {emoji:"☀️",header:"ON EST AU DÉBUT DE SEMAINE — ON ENCLENCHE",texte:"L'objectif est encore loin mais la semaine est devant nous. Qui balance le premier deal ?"},
          {emoji:"🌱",header:"MARDI — LE MOMENT D'ENCLENCHER LA SEMAINE",texte:"On a fait un début, on continue calmement. Chaque close maintenant c'est du terrain gagné pour plus tard."},
          {emoji:"🎬",header:"ON DÉMARRE LE MARDI — DOUCEMENT MAIS SÛREMENT",texte:"Pas de panique, la semaine vient à peine de commencer. On pose les closes un par un 💪"},
          {emoji:"🚀",header:"MARDI MATIN — ON REPART TRANQUILLE",texte:"Nouvelle journée, l'objectif attend. Allez les gars, on y va au rythme qu'il faut."},
        ]);
        if (pctObjectif < 35) return pick([
          {emoji:"💪",header:"ON EST DANS LES CLOUS — ON ACCÉLÈRE",texte:"Bon rythme pour où on en est. Continuez comme ça et l'objectif de la semaine va tomber 🎯"},
          {emoji:"🔥",header:"LE MOMENTUM EST LÀ",texte:`Si on garde ce rythme aujourd'hui, demain on sera en avance. C'est exactement ce qu'on veut. ${pickCEO()}`},
          {emoji:"⚡",header:"ON EST SUR LA BONNE TRAJECTOIRE",texte:"Le rythme est bon. On reste dessus et la semaine va être belle. Qui balance le prochain deal ? 💪"},
          {emoji:"🎯",header:"BELLE PROGRESSION — ON LÂCHE RIEN",texte:`${pickCEO()} On est sur la bonne trajectoire. Accélération maintenant pour prendre de l'avance 🚀`},
          {emoji:"🚀",header:"MARDI MATIN SOLIDE — ON TIENT ÇA",texte:`${pickPhilippe()} Dans les clous mardi matin, c'est ce qu'on voulait. On garde la cadence et la semaine va bien se finir 💪`},
          {emoji:"💥",header:"LE RYTHME EST CORRECT — ON POUSSE ENCORE UN CRAN",texte:"Bon positionnement mardi matin. Si on accélère là, mercredi sera confortable. Qui sort le prochain deal ? 🔥"},
          {emoji:"🏆",header:"LA SEMAINE EST SUR LA BONNE VOIE",texte:`${pickCEO()} Mardi matin dans les clous. Chaque deal maintenant c'est de la marge pour la fin de semaine. Allez !`},
          {emoji:"⚡",header:"ON EST BIEN — ON LE RESTE PAS",texte:"Dans les clous mardi matin c'est bien. Dans les clous mardi soir c'est encore mieux. On accélère 🎯"},
        ]);
      }
      if (h >= 12 && h < 15) {
        if (pctObjectif < 25) return pick([
          {emoji:"💪",header:"MARDI APRÈM — ON ENCLENCHE LA SUITE",texte:"On a encore 3 jours et demi devant nous, c'est largement de quoi bien finir. Qui sort le prochain deal ?"},
          {emoji:"🎯",header:"L'APRÈM DE MARDI — ON MONTE EN RÉGIME",texte:`${pickPhilippe()} Pas de panique, la semaine est encore jeune. On y va close par close, ensemble 🚀`},
          {emoji:"☀️",header:"ON A TOUTE L'APRÈM POUR POUSSER",texte:"Encore plein de temps devant. Chaque close maintenant c'est une base posée pour la fin de semaine 💪"},
          {emoji:"🌱",header:"MARDI APRÈM — ON FAIT POUSSER LE COMPTEUR",texte:`${pickCEO()} On a le temps de bien faire. L'essentiel c'est de garder le rythme en équipe 🎯`},
          {emoji:"💡",header:"L'APRÈM EST LÀ — ON ENCLENCHE TRANQUILLEMENT",texte:"Début de semaine oblige : pas de pression, juste de l'élan. On pose les closes un par un 💪"},
          {emoji:"🎬",header:"ACTION APRÈS-MIDI — QUI DONNE LE TON ?",texte:"La semaine est devant nous. Qui balance le prochain deal pour donner de l'énergie à l'équipe ? 🚀"},
          {emoji:"☕",header:"APRÈS LA PAUSE CAFÉ — ON ENCLENCHE",texte:`${pickPhilippe()} On repart tranquillement. Chaque close cet aprèm c'est moins à faire mercredi matin 💡`},
          {emoji:"🚀",header:"MARDI APRÈM — DOUCEMENT ON AVANCE",texte:"La semaine est encore à construire. On y va calmement, deal par deal, et ça va monter tout seul 🎯"},
        ]);
        if (pctObjectif < 45) return pick([
          {emoji:"⚡",header:"ON EST SUR LE FIL — L'APRÈM DOIT ÊTRE FORTE",texte:"On est dans les clous mais juste. L'aprèm doit être chargée. On pousse ensemble 💪"},
          {emoji:"🔥",header:"LE GAME EST OUVERT",texte:"Bon positionnement à cette heure. L'aprèm va faire la différence. Qui sort le prochain close ? 🎯"},
          {emoji:"💪",header:"ON CONTINUE — DEAL APRÈS DEAL",texte:`${pickCEO()} On reste focusés et ça va tomber. L'aprèm commence, on accélère 🚀`},
          {emoji:"🎯",header:"LE RYTHME EST LÀ — ON DOUBLE LA CADENCE",texte:"On est bien positionnés. Si on met le turbo cet aprèm, demain on sera en avance sur l'objectif. Allez !"},
          {emoji:"🚀",header:"MARDI APRÈM DANS LA COURSE — ON EN PROFITE",texte:`${pickPhilippe()} Dans les clous mardi aprèm, c'est exactement ça. L'aprèm pour accélérer et finir fort cette semaine 💥`},
          {emoji:"💥",header:"ON EST POSITIONNÉS — ON ACCÉLÈRE",texte:"Bon rythme à cette heure. Mais c'est mardi aprèm : le bon moment pour prendre de l'avance sur mercredi. Allez ! 🔥"},
          {emoji:"🏆",header:"LA TRAJECTOIRE EST BONNE — ON LA TIENT",texte:`${pickCEO()} Dans les clous mardi aprèm. Si on reste là-dessus, jeudi et vendredi seront déjà à moitié gagnés 🎯`},
          {emoji:"⚡",header:"UN CRAN AU-DESSUS CET APRÈM — ET LA SEMAINE CHANGE",texte:"On est dans la course. Si on force un peu là maintenant, on sera en avance demain. Qui pousse ? 💪"},
        ]);
      }
      if (h >= 15) {
        if (pctObjectif < 30) return pick([
          {emoji:"💡",header:"FIN DE JOURNÉE — ON PRÉPARE LA SUITE",texte:"Encore 3 jours devant nous, c'est large. Quelques closes avant 18h et on démarre demain avec du momentum 💪"},
          {emoji:"🌅",header:"ON FERME LA JOURNÉE PROPREMENT",texte:`${pickPhilippe()} Qui a des deals quasi-signés à faire passer avant de partir ? Ça fait des bases de plus pour la suite 🎯`},
          {emoji:"🎯",header:"LES 2 DERNIÈRES HEURES — ON ENVOIE DU CLOSE",texte:"La semaine est encore jeune. Des closes avant 18h et demain démarre avec un peu d'avance 💪"},
          {emoji:"☕",header:"FIN DE JOURNÉE TRANQUILLE — ON CAPITALISE",texte:`${pickCEO()} Pas de stress, on a le temps. Quelques closes avant la fermeture et la semaine reste bien en main 🚀`},
          {emoji:"💪",header:"ON POSE LES DERNIERS DEALS AVANT DE QUITTER",texte:"Encore 3 jours pleins devant nous. Un push collectif maintenant et on repart demain plein d'élan 🔥"},
          {emoji:"🌱",header:"LA JOURNÉE SE TERMINE — ON CAPITALISE",texte:"Début de semaine, chaque deal compte. On ferme calmement et on attaque demain avec les idées claires 💡"},
          {emoji:"🚀",header:"FIN DE JOURNÉE — DIRECTION LA SUITE",texte:`${pickPhilippe()} On pose 2-3 closes avant 18h et demain on redémarre sur de bonnes bases 💪`},
          {emoji:"🎬",header:"DERNIERS CLOSES DE LA JOURNÉE — QUI LES POSE ?",texte:"Fin de journée, encore plein de semaine devant. Les deals de maintenant = moins à faire demain matin 🎯"},
        ]);
        if (pctObjectif >= 30) return pick([
          {emoji:"💪",header:"ON FERME BIEN CETTE JOURNÉE",texte:`Bonne journée. On est dans le game. Demain on continue et l'objectif va tomber. ${pickCEO()} 🎯`},
          {emoji:"🔥",header:"BELLE JOURNÉE — LES BASES SONT POSÉES",texte:`On ferme en bonne posture. ${pickCEO()} 👑 On continue demain !`},
          {emoji:"🏆",header:"ON EST SUR LA BONNE TRAJECTOIRE",texte:"Finir la journée avec ce niveau c'est ce qu'on veut. Demain on remet ça et l'objectif va tomber 🎯"},
          {emoji:"⚡",header:"C'EST COMME ÇA QU'ON GAGNE UNE SEMAINE",texte:"Deal après deal, journée après journée. On reste sur cette lancée et la semaine est dans la boîte 💪"},
          {emoji:"🚀",header:"BELLE FIN DE JOURNÉE — ON REPART DEMAIN",texte:`${pickPhilippe()} Journée qui se ferme bien. Demain on accélère encore et la semaine va être belle 🔥`},
          {emoji:"💥",header:"LE RYTHME EST LÀ — ON LE TIENT",texte:"Bonne journée. Deal après deal on construit la semaine qu'on veut. Demain on remet ça 🏆"},
          {emoji:"🎯",header:"JOURNÉE RÉUSSIE — LES BASES SONT LÀ",texte:`${pickCEO()} Finir à ce niveau c'est exactement ce qu'on voulait. Demain on pousse encore 💪`},
          {emoji:"🐐",header:"DEUX JOURS DE FAITS — ET C'EST DU SOLIDE",texte:"Fin de journée avec de bons chiffres, ça met la semaine dans le bon sens. Demain on accélère encore 🚀"},
        ]);
      }
    }

    // MERCREDI
    if (jour === 3) {
      if (h < 12) {
        if (pctObjectif < 30) return pick([
          {emoji:"☕",header:"MERCREDI MATIN — ON ENCLENCHE LA MI-SEMAINE",texte:"Milieu de semaine, encore 2 jours et demi pour bien finir. Qui ouvre le bal ce matin ?"},
          {emoji:"💪",header:"ON A LA SEMAINE ENTRE LES MAINS",texte:`${pickPhilippe()} Mi-semaine, chaque close maintenant c'est de la marge pour la fin de semaine. Allez les cracks 🎯`},
          {emoji:"🎯",header:"MI-SEMAINE — LE MOMENT D'ACCÉLÉRER TRANQUILLEMENT",texte:"On a encore largement le temps. L'important c'est de garder le rythme en équipe. Qui sort le prochain deal ?"},
          {emoji:"🌅",header:"MERCREDI MATIN — NOUVELLE DYNAMIQUE",texte:"Nouveau jour, nouvelle énergie. On a deux jours pleins devant pour construire la semaine qu'on veut 💪"},
          {emoji:"🚀",header:"MERCREDI MATIN — ON MONTE EN RÉGIME",texte:`${pickCEO()} Mi-semaine, on sort le second souffle. Chaque close ce matin c'est un kick pour l'équipe 🔥`},
          {emoji:"💡",header:"LA SEMAINE SE CONSTRUIT — ON POUSSE ENSEMBLE",texte:"Pas de pression, juste de l'élan collectif. Mi-semaine c'est pile le bon moment pour enclencher la vitesse supérieure 🎯"},
          {emoji:"☀️",header:"MERCREDI — LE PIVOT DE LA SEMAINE",texte:`${pickPhilippe()} C'est ici que la semaine bascule. On y va ensemble, close après close 💪`},
          {emoji:"🎬",header:"MERCREDI MATIN — ACTION COLLECTIVE",texte:"Milieu de semaine, encore plein de temps. Qui donne le ton ce matin pour lancer l'équipe ? 🚀"},
        ]);
        if (pctObjectif < 50) return pick([
          {emoji:"⚡",header:"ON EST PILE SUR LE FIL — ON DOIT ACCÉLÉRER",texte:"Mi-semaine et pile à la moitié de l'objectif. C'est le minimum. L'aprèm doit être plus forte. Allez !"},
          {emoji:"🔥",header:"LE RYTHME EST BON — ON LE TIENT",texte:"On est dans les clous. La deuxième moitié de semaine commence. On garde le rythme et ça va tomber !"},
          {emoji:"💪",header:"ON EST DANS LA COURSE — ON ACCÉLÈRE",texte:`${pickCEO()} Mi-semaine et dans les clous. Si on pousse maintenant, jeudi et vendredi seront tranquilles 🎯`},
          {emoji:"🎯",header:"LE MOMENTUM EST LÀ — ON EN PROFITE",texte:"On est bien positionnés. La deuxième moitié de semaine est là pour creuser l'écart. Allez !"},
          {emoji:"🚀",header:"MI-SEMAINE SUR LE FIL — L'ACCÉLÉRATION COMMENCE",texte:`${pickPhilippe()} Mercredi matin pile dans les clous. Maintenant faut passer un cran au-dessus pour que jeudi soit tranquille. Allez 💥`},
          {emoji:"💥",header:"LE MINIMUM C'EST BIEN — LE MIEUX C'EST MAINTENANT",texte:"Mi-semaine dans les clous, c'est le minimum qu'on attendait. Maintenant on pousse pour prendre de la marge. Qui accélère ? 🔥"},
          {emoji:"🏆",header:"ON EST DANS LE GAME — ON LE RESTE",texte:`${pickCEO()} Mercredi matin dans la course. La deuxième moitié de semaine se joue maintenant. On accélère 💪`},
          {emoji:"⚡",header:"MI-SEMAINE CORRECT — MAINTENANT ON CREUSE L'ÉCART",texte:"On est là où il faut être. Mais rester dans les clous c'est le minimum. On veut de l'avance. Allez les cracks ! 🎯"},
        ]);
        if (pctObjectif >= 50) return pick([
          {emoji:"💪",header:"DÉJÀ 50%+ C'EST ZINZIN",texte:`Mi-semaine et déjà plus de la moitié de l'objectif. ${pickCEO()} 👑🔥`},
          {emoji:"🏆",header:"VOUS ÊTES EN AVANCE SUR L'OBJECTIF",texte:`Mi-semaine et largement dans les clous. Quelle team, quel niveau. ${pickPhilippe()} 🙌`},
          {emoji:"🚀",header:"ON EST EN AVANCE — ON CREUSE L'ÉCART",texte:"Plus de 50% à mi-semaine c'est masterclass. L'objectif va tomber avant vendredi si on continue 🏆"},
          {emoji:"💥",header:"LES CHIFFRES PARLENT D'EUX-MÊMES",texte:`${pickCEO()} 50%+ à mi-semaine, c'est une semaine de feu qui se profile. On lâche rien 🔥`},
          {emoji:"🐐",header:"MERCREDI MATIN EN AVANCE — VOUS ÊTES DES GOAT",texte:`${pickPhilippe()} 50%+ mercredi matin. Jeudi et vendredi pour finir en beauté. Cette semaine va être mémorable 🏆`},
          {emoji:"🎯",header:"EN AVANCE À MI-SEMAINE — ON MAINTIENT LA PRESSION",texte:"50%+ mercredi matin c'est exactement là où on veut être. Maintenant on finit ce qu'on a commencé. Allez 💪"},
          {emoji:"💥",header:"CETTE SEMAINE EST DÉJÀ EN TRAIN DE SE GAGNER",texte:`${pickCEO()} En avance mercredi matin. L'objectif va tomber avant vendredi soir. On continue comme ça 🚀`},
          {emoji:"🔥",header:"LES SEMAINES DE FEU COMMENCENT COMME ÇA",texte:`${pickPhilippe()} Plus de la moitié de l'objectif et encore 2.5 jours. C'est une semaine de gala. On finit proprement 🥂`},
        ]);
      }
      if (h >= 12) {
        if (pctObjectif < 40) return pick([
          {emoji:"💪",header:"MERCREDI APRÈM — ON ENCLENCHE LA SECONDE MOITIÉ",texte:"Encore 2 jours et demi devant nous. Chaque close cet aprèm c'est de la marge pour jeudi et vendredi 🎯"},
          {emoji:"🎯",header:"L'APRÈM DU PIVOT — ON MONTE ENSEMBLE",texte:`${pickPhilippe()} C'est le moment idéal pour accélérer tranquillement en équipe. Qui ouvre ?`},
          {emoji:"🚀",header:"DEUXIÈME MOITIÉ DE SEMAINE — ON LANCE LA MACHINE",texte:"2 jours pleins après aujourd'hui, c'est largement assez pour bien finir. On y va close par close 💪"},
          {emoji:"☀️",header:"MERCREDI APRÈM — ON POSE DES BASES POUR JEUDI",texte:`${pickCEO()} Chaque deal maintenant c'est un deal de moins à faire demain. On avance ensemble 🔥`},
          {emoji:"💡",header:"L'APRÈM EST LÀ — ON CAPITALISE",texte:"C'est le momentum parfait pour prendre un peu d'avance. Pas de stress, juste du rythme 🎯"},
          {emoji:"🎬",header:"SECONDE MI-TEMPS — QUI REPREND LE MATCH ?",texte:"Milieu de semaine dépassé, on attaque la seconde mi-temps. Qui balance le prochain deal pour lancer l'équipe ? 💪"},
          {emoji:"🏆",header:"MERCREDI APRÈM — ON CONSTRUIT LA FIN DE SEMAINE",texte:`${pickPhilippe()} Encore plein de temps. On enclenche calmement et la fin de semaine sera douce 🚀`},
          {emoji:"⚡",header:"ON EST AU BON MOMENT — ON EN PROFITE",texte:"C'est exactement l'heure où l'équipe prend sa deuxième respiration. Qui lance la suite ? 🎯"},
        ]);
        if (pctObjectif < 60) return pick([
          {emoji:"⚡",header:"ON EST DANS LA COURSE — ON DOUBLE LA CADENCE",texte:"On est encore dans le game. Les 2 prochains jours vont être décisifs. On accélère maintenant 💪"},
          {emoji:"🔥",header:"LE MOMENTUM EST LÀ — ON EN PROFITE",texte:`On est bien positionnés pour la fin de semaine. ${pickCEO()} On lâche rien 💪`},
          {emoji:"💪",header:"ON EST DANS LES CLOUS — ON POUSSE ENCORE",texte:"Bon positionnement à mi-semaine. Jeudi et vendredi pour finir fort. Qui balance le prochain deal ? 🎯"},
          {emoji:"🎯",header:"LE GAME EST OUVERT — ON L'EMPORTE",texte:"Mi-semaine et dans la course. Les 2 prochains jours peuvent tout faire basculer dans le bon sens. Allez !"},
          {emoji:"🚀",header:"MERCREDI APRÈM DANS LA COURSE — ON ACCÉLÈRE",texte:`${pickPhilippe()} Bon positionnement. Si l'aprèm est forte, jeudi matin on sera en avance. Allez les cracks ! 💥`},
          {emoji:"💥",header:"ON EST DANS LE GAME — MAINTENANT ON LE GAGNE",texte:"Dans la course à mi-semaine, c'est bien. Mais les semaines qui se gagnent, c'est ceux qui accélèrent là. 🔥"},
          {emoji:"🏆",header:"LE MOMENTUM EST BON — ON LE TIENT",texte:`${pickCEO()} Dans les clous mercredi aprèm. Jeudi et vendredi pour finir cette semaine comme des pros 🎯`},
          {emoji:"⚡",header:"DEUX JOURS POUR TRANSFORMER UN BON DÉBUT EN GRANDE SEMAINE",texte:"On est bien placés à mi-semaine. Jeudi et vendredi pour mettre un point final solide. Qui pousse maintenant ? 💪"},
        ]);
        if (pctObjectif >= 60) return pick([
          {emoji:"🏆",header:"L'OBJECTIF EST À PORTÉE — ON FINIT LE BOULOT",texte:`Plus de 60% à mi-semaine c'est masterclass. 2 jours pour finir proprement. ${pickPhilippe()} 🐐`},
          {emoji:"💪",header:"ON A FAIT L'ESSENTIEL — ON FINIT FORT",texte:`${pickCEO()} 60%+ à mi-semaine. Jeudi et vendredi pour finir cette semaine en beauté 👑`},
          {emoji:"🚀",header:"ON EST EN AVANCE — ON CREUSE L'ÉCART",texte:"60% à mi-semaine et 2 jours devant nous. L'objectif va tomber bien avant vendredi soir. Des GOAT 🐐"},
          {emoji:"💥",header:"QUELLE SEMAINE ON EST EN TRAIN DE FAIRE",texte:`${pickCEO()} 60%+ aujourd'hui c'est une semaine de feu. On garde le rythme 🔥`},
          {emoji:"🐐",header:"MERCREDI APRÈM EN AVANCE — CETTE SEMAINE EST GAGNÉE",texte:`${pickPhilippe()} 60%+ mercredi aprèm c'est des GOAT. Jeudi et vendredi pour finir proprement et célébrer 🍺`},
          {emoji:"🎯",header:"ON A FAIT LA MAJORITÉ — ON TERMINE EN BEAUTÉ",texte:"60%+ mercredi aprèm c'est exactement ce qu'on voulait. Maintenant jeudi et vendredi pour solidifier 💪"},
          {emoji:"💥",header:"CETTE SEMAINE VA REJOINDRE LE HALL OF FAME",texte:`${pickCEO()} 60%+ à mi-semaine c'est rare. Finissez proprement et cette semaine sera mémorable 🏆`},
          {emoji:"⚡",header:"EN AVANCE ET ENCORE DU TEMPS — ON EN PROFITE",texte:`${pickPhilippe()} 60%+ mercredi aprèm. 2 jours pour finir en beauté. L'objectif va tomber avant vendredi soir 🚀`},
        ]);
      }
    }

    // JEUDI — 80% de la semaine consommée
    // Seuils calibrés sur le temps écoulé :
    //   Jeudi matin  : 3 jours passés sur 5 → "devrait être" à ~60%
    //   Jeudi aprèm  : 3.5 jours passés    → "devrait être" à ~70%
    //   Jeudi 17h+   : 4 jours passés      → "devrait être" à ~80%
    if (jour === 4) {
      if (h < 12) {
        // < 45% jeudi matin — en retard mais on garde un ton fun/pro/collectif (pas de pression le matin)
        if (pctObjectif < 45) return pick([
          {emoji:"🍺",header:"L'AFTERWORK AU 7 SE MÉRITE AUJOURD'HUI",texte:`${pickPhilippe()} Jeudi matin à ${pctObjectif}%. Le 7 ce soir se joue sur les closes de la journée. Qui ouvre le bal ce matin ?`},
          {emoji:"💪",header:"JEUDI MATIN — ON ENCLENCHE LA FIN DE SEMAINE",texte:`${pctObjectif}% au compteur. Il reste jeudi et vendredi pour bien finir. On avance ensemble, close après close 🎯`},
          {emoji:"🎯",header:"LE MATCH SE JOUE SUR 2 JOURS — ÇA COMMENCE CE MATIN",texte:`${pctObjectif}% jeudi matin. On a largement de quoi faire. Qui sort le premier deal pour lancer la journée ?`},
          {emoji:"⚡",header:"DEUX JOURS DEVANT NOUS — ON LES PREND",texte:`${pctObjectif}% au compteur. Jeudi et vendredi pour faire les ${100-pctObjectif}% restants. En équipe, c'est jouable 🔥`},
          {emoji:"🔥",header:"JEUDI MATIN — ON REMONTE ENSEMBLE",texte:`${pickPhilippe()} ${pctObjectif}% ce matin. Le Brelan de vendredi se construit dès maintenant. Allez les cracks 💪`},
          {emoji:"🍻",header:"LE 7 CE SOIR — ON EN FAIT UNE MOTIVATION",texte:`${pctObjectif}% jeudi matin. Le 7 c'est la récompense collective des closes de la journée. Qui balance le premier ?`},
          {emoji:"🚀",header:"JEUDI MATIN — ON LANCE L'ÉQUIPE",texte:`${pctObjectif}% à cette heure. Deux jours pleins pour finir en beauté. Le premier close du matin donne le ton 🎯`},
          {emoji:"💡",header:"LE RYTHME DE LA MATINÉE FAIT LA SEMAINE",texte:`${pctObjectif}% jeudi matin. Chaque close maintenant c'est un pas vers le 7 ce soir. On pousse ensemble 💪`},
        ]);
        // 45-69% jeudi matin — légèrement en retard, le 7 est atteignable
        if (pctObjectif < 70) return pick([
          {emoji:"🔥",header:"L'AFTERWORK AU 7 SE JOUE AUJOURD'HUI",texte:`${pctObjectif}% jeudi matin, c'est dans la course. ${pickCEO()} Chaque close aujourd'hui rapproche du 7 ce soir et de l'objectif vendredi 🍺`},
          {emoji:"⚡",header:"ON EST DANS LE GAME — LE 7 NOUS ATTEND",texte:`${pickPhilippe()} ${pctObjectif}% jeudi matin. Ce matin on accélère, l'aprèm on clôture. Le 7 se mérite mais c'est jouable 🍺`},
          {emoji:"💪",header:"CHAQUE DEAL CE MATIN = UN VERRE AU 7 CE SOIR",texte:`On est à ${pctObjectif}% avec jeudi et vendredi devant nous. Si on pousse aujourd'hui, l'objectif peut tomber avant vendredi soir 🍺🔥`},
          {emoji:"🎯",header:"ON EST SUR LA TRAJECTOIRE — ON ACCÉLÈRE",texte:`${pctObjectif}% jeudi matin. Le rythme est là. On garde ça toute la journée et le 7 ce soir c'est validé. Qui balance le prochain deal ? 💪`},
          {emoji:"🍺",header:"LE 7 CE SOIR C'EST DANS LA COURSE — ON POUSSE",texte:`${pctObjectif}% jeudi matin. Légèrement en retard mais le 7 est encore jouable. Ce matin on ferme ce qui peut l'être. Allez ! 🔥`},
          {emoji:"💥",header:"ON EST LÀ — MAINTENANT ON ACCÉLÈRE",texte:`${pickPhilippe()} ${pctObjectif}% jeudi matin. Dans la course mais faut pas relâcher. Le 7 ce soir et l'objectif vendredi : ça se joue maintenant 💪`},
          {emoji:"🚀",header:"JEUDI MATIN DANS LE GAME — ON FINIT LA SEMAINE",texte:`${pctObjectif}% à cette heure. Le rythme est correct. Si on pousse fort aujourd'hui, vendredi sera plus tranquille. Le 7 nous attend 🍺`},
          {emoji:"⚡",header:"UN CRAN AU-DESSUS CE MATIN ET LE 7 EST VALIDÉ",texte:`${pctObjectif}% jeudi matin. C'est jouable mais serré. Chaque close ce matin compte pour le 7 ce soir et pour finir fort vendredi 🎯`},
        ]);
        // 70%+ jeudi matin — en avance sur la semaine, le 7 est validé
        return pick([
          {emoji:"🏆",header:"LE 7 CE SOIR EST VALIDÉ — FINISSEZ PROPREMENT",texte:`${pctObjectif}%+ jeudi matin c'est masterclass — 70% de l'objectif en 3 jours. L'afterwork au 7 vous l'avez déjà mérité 🍺🔥`},
          {emoji:"💪",header:"QUELLE SEMAINE ON EST EN TRAIN DE FAIRE",texte:`${pickCEO()} ${pctObjectif}%+ ce matin. L'objectif va tomber aujourd'hui. Le 7 ce soir c'est validé 🐐`},
          {emoji:"🚀",header:"CETTE SEMAINE EST DÉJÀ GAGNÉE",texte:`${pctObjectif}%+ jeudi matin c'est une semaine de feu. L'objectif va tomber avant ce soir. Finissez en beauté 🏆`},
          {emoji:"💥",header:"VOUS AVEZ ÉCRASÉ CETTE SEMAINE",texte:`${pickPhilippe()} ${pctObjectif}%+ jeudi matin. Finissez proprement et l'afterwork au 7 c'est pour vous ce soir 🍺🎉`},
          {emoji:"🍺",header:"LE 7 CE SOIR C'EST ACQUIS — ON FINIT EN BEAUTÉ",texte:`${pctObjectif}%+ jeudi matin. Le 7 ce soir c'est validé. Quelques closes et l'objectif tombe dans la journée 🎉`},
          {emoji:"🐐",header:"TROIS JOURS POUR 70% — C'EST DES GOAT",texte:`${pickCEO()} ${pctObjectif}%+ jeudi matin. Cette semaine va être parfaite. Le 7 ce soir et l'objectif demain 🏆`},
          {emoji:"🎯",header:"ON EST DEVANT — ON RESTE DEVANT",texte:`${pctObjectif}%+ jeudi matin c'est là où il faut être. Finissez la journée fort et vendredi c'est pour les finitions. Le 7 vous attend 🍺`},
          {emoji:"⚡",header:"EN AVANCE SUR LA SEMAINE — C'EST UNE BELLE SEMAINE",texte:`${pickPhilippe()} ${pctObjectif}%+ jeudi matin. L'objectif va tomber avant vendredi soir. Le 7 ce soir c'est validé 🚀`},
        ]);
      }
      if (h >= 12) {

        // ── JEUDI FIN DE JOURNÉE (17h+) — 4 jours sur 5 consommés, "devrait être" à 80% ──
        if (h >= 17) {
          // < 55% à 17h jeudi — vendredi seul ne peut pas compenser
          if (pctObjectif < 55) return pick([
            {emoji:"🚨",header:"LE 7 CE SOIR C'EST COMPROMIS — VENDREDI VA ÊTRE DÉCISIF",texte:`${pickPhilippePression()} On est à ${pctObjectif}% en fin de jeudi. 4 jours passés sur 5. L'objectif hebdo est compromis. On finit fort ce soir et vendredi on donne tout 😤`},
            {emoji:"💥",header:"ON A UTILISÉ 80% DE LA SEMAINE POUR 55% DE L'OBJECTIF",texte:`${pctObjectif}% jeudi soir. Vendredi va devoir être exceptionnel pour rattraper. Chaque close ce soir c'est moins de pression demain 🔥`},
            {emoji:"🚨",header:"DERNIÈRES HEURES POUR PRÉPARER DEMAIN",texte:`${pickPhilippePression()} ${pctObjectif}% en fin de journée c'est un problème. On ferme tout ce qu'on peut ce soir. Demain c'est jour J 💪`},
            {emoji:"⚡",header:"VENDREDI VA ÊTRE LE PLUS IMPORTANT DE LA SEMAINE",texte:`On est à ${pctObjectif}% avec une journée restante. Chaque close ce soir c'est du carburant pour la remontada demain. ALLEZ !`},
            {emoji:"🔥",header:"JEUDI SOIR DIFFICILE — VENDREDI PARFAIT",texte:`${pickPhilippePression()} ${pctObjectif}% jeudi 17h+. 4 jours de passés. Le 7 c'est pas pour ce soir. Mais vendredi peut encore sauver la semaine. On ferme ce qu'on peut là 😤`},
            {emoji:"💪",header:"CHAQUE CLOSE CE SOIR C'EST UN DEAL DE MOINS VENDREDI",texte:`${pctObjectif}% fin de jeudi. L'objectif est compromis. Mais si on close encore ce soir, vendredi ce sera plus léger. Qui est chaud ? 🎯`},
            {emoji:"🚀",header:"ON PRÉPARE LE VENDREDI DÈS MAINTENANT",texte:`${pickPhilippePression()} ${pctObjectif}% jeudi soir. Vendredi va être décisif. On optimise les dernières heures du jeudi pour mieux partir demain. ALLEZ 💥`},
            {emoji:"⚡",header:"LE 7 C'EST POUR CEUX QUI CLOSENT ENCORE CE SOIR",texte:`${pctObjectif}% et la soirée commence. Le 7 c'est chaud. Mais les derniers closes du jeudi changeront l'ambiance de vendredi. Qui ferme maintenant ? 🔥`},
          ]);
          // 55-79% — possible avec un bon vendredi, le 7 est incertain
          if (pctObjectif < 80) return pick([
            {emoji:"🔥",header:"LE 7 EST ENCORE EN JEU — ON DONNE TOUT",texte:`${pickPhilippePression()} ${pctObjectif}% au compteur. Quelques closes avant de partir et le 7 ce soir est validé. QUI CLOSE ? 🍺`},
            {emoji:"⚡",header:"L'AFTERWORK AU 7 DANS UNE HEURE — ON LE MÉRITE",texte:`${pctObjectif}% et il reste une heure. On est dans la course. ${pickCEO()} Quelques closes et on part au 7 avec le sourire 🍺🔥`},
            {emoji:"💪",header:"DES DEALS AVANT LE 7 — QUI LES PREND ?",texte:`${pickPhilippe()} ${pctObjectif}% au compteur. L'afterwork au 7 se mérite avec les closes de la dernière heure. ALLEZ 💪`},
            {emoji:"🎯",header:"ON CLOSE AVANT LE 7 — LES BOSS FINALS SE RÉVÈLENT",texte:`On est à ${pctObjectif}%. 2-3 closes de plus et on part au 7 avec le sourire. Demain on finit. Qui est chaud ? 🍺`},
            {emoji:"🍺",header:"LE 7 EST DANS LA COURSE — ON POUSSE ENSEMBLE",texte:`${pctObjectif}% en fin de journée. Le 7 ce soir c'est encore jouable. Les closes de la dernière heure font la différence. ALLEZ 🔥`},
            {emoji:"💥",header:"C'EST MAINTENANT QUE ÇA SE PASSE — LE 7 ATTEND",texte:`${pickPhilippe()} ${pctObjectif}%. La fenêtre pour valider le 7 se ferme bientôt. Closes maintenant. Qui ouvre ? 💪`},
            {emoji:"🚀",header:"DERNIÈRE HEURE — LE 7 OU RIEN",texte:`${pctObjectif}% et la soirée est là. Le 7 ce soir c'est jouable si on close dans l'heure. ${pickCEO()} Allez les cracks 🍺`},
            {emoji:"⚡",header:"LE 7 SE MÉRITE — ET ON PEUT LE MÉRITER",texte:`${pctObjectif}% en fin de journée. C'est dans la course. Un bon push collectif et le 7 ce soir c'est validé. Demain on finit la semaine 🎯`},
          ]);
          // 80%+ — le 7 est validé, semaine quasi gagnée
          return pick([
            {emoji:"🏆",header:"LE 7 CE SOIR C'EST VALIDÉ 🍺🎉",texte:`${pctObjectif}%+ en fin de jeudi — 80% de la semaine passée et ${pctObjectif}% de l'objectif fait. C'est une semaine parfaite qui se profile. ${pickCEO()} 🥂`},
            {emoji:"💥",header:"QUELLE SEMAINE — LE 7 VOUS ATTEND",texte:`${pickPhilippe()} ${pctObjectif}%+ jeudi soir. Demain on finit le boulot et cette semaine est parfaite. Ce soir : le 7 bien mérité 🍺🔥`},
            {emoji:"🚀",header:"L'OBJECTIF VA TOMBER DEMAIN MATIN",texte:`${pctObjectif}%+ fin de jeudi c'est une semaine gagnée. Demain matin ça tombe vite. Ce soir : afterwork mérité 🐐`},
            {emoji:"💪",header:"JEUDI PARFAIT — LE 7 ET DEMAIN ON BOUCLE",texte:`${pctObjectif}%+ jeudi soir. Le 7 ce soir c'est validé. Demain quelques closes et c'est dans la boîte 🍺🏆`},
            {emoji:"🍺",header:"80%+ JEUDI SOIR — CETTE SEMAINE EST PRESQUE PARFAITE",texte:`${pctObjectif}%+ et une journée devant nous. Le 7 ce soir c'est validé. Demain on finalise et cette semaine rejoint le hall of fame 🏆`},
            {emoji:"🐐",header:"JEUDI SOIR EN AVANCE — ON EST DES GOAT",texte:`${pickCEO()} ${pctObjectif}%+ fin de jeudi. Le 7 vous attend ce soir. Demain on clôture une semaine parfaite 🥂`},
            {emoji:"🎉",header:"LE 7 EST MÉRITÉ — CE SOIR ON CÉLÈBRE",texte:`${pctObjectif}%+ jeudi soir c'est une semaine de feu. Le 7 ce soir c'est acquis. Demain quelques closes et c'est plié 🍺🔥`},
            {emoji:"⚡",header:"EN AVANCE SUR 5 JOURS — C'EST RARE ET C'EST VOUS",texte:`${pickPhilippe()} ${pctObjectif}%+ jeudi fin de journée. Le 7 ce soir c'est validé. Demain pour finir proprement 💪`},
          ]);
        }

        // ── JEUDI DÉBUT D'APRÈM (12h-17h) — 3.5 jours consommés, "devrait être" à ~70% ──
        // < 50% — sévèrement en retard
        if (pctObjectif < 50) return pick([
          {emoji:"🚨",header:"L'AFTERWORK AU 7 EST EN DANGER 🚨",texte:`${pickPhilippePression()} ${pctObjectif}% jeudi aprèm — 3.5 jours de passés pour ça. Le 7 ce soir c'est quasi impossible. Mais on peut sauver la semaine vendredi si on commence MAINTENANT 😤`},
          {emoji:"💥",header:"ON A CONSOMMÉ 70% DE LA SEMAINE POUR 50% DE L'OBJECTIF",texte:`${pctObjectif}% jeudi aprèm. C'est un retard sérieux. L'aprèm et vendredi pour tout renverser. Closes en série, tout le monde dessus 🔥`},
          {emoji:"🚨",header:"LA REMONTADA COMMENCE MAINTENANT OU JAMAIS",texte:`${pickPhilippePression()} ${pctObjectif}% en milieu de jeudi. Il reste 1.5 jours. C'est jouable mais ça nécessite une intensité maximale MAINTENANT 💪`},
          {emoji:"⚡",header:"LE 7 C'EST CHAUD — MAIS ON PEUT ENCORE SAUVER LA SEMAINE",texte:`On est à ${pctObjectif}% avec jeudi aprèm + vendredi. Le 7 ce soir c'est compromis, mais l'objectif final peut encore tomber. ALLEZ ! 🔥`},
          {emoji:"🔥",header:"JEUDI APRÈM EN RETARD — ON DONNE TOUT",texte:`${pickPhilippePression()} ${pctObjectif}% à cette heure c'est sérieusement en retard. Le 7 ce soir c'est mort. Mais cet aprèm + demain peuvent encore tout changer. ALLEZ 😤`},
          {emoji:"💪",header:"ON A ENCORE 1.5 JOURS — ON LES UTILISE À FOND",texte:`${pctObjectif}% en milieu de jeudi. Le retard est sérieux mais pas fatal. Closes en série cet aprèm + vendredi et la semaine peut finir droit 🎯`},
          {emoji:"🚀",header:"LE 7 C'EST PLIÉ — MAIS LA SEMAINE SE SAUVE DEMAIN",texte:`${pickPhilippePression()} ${pctObjectif}% à cette heure. Le 7 ce soir c'est pas possible. Mais si l'aprèm et demain sont forts, la semaine peut encore bien finir. On y va 💥`},
          {emoji:"⚡",header:"L'INTENSITÉ MAXIMALE DÈS MAINTENANT",texte:`${pctObjectif}% jeudi aprèm. On n'a pas le luxe d'attendre vendredi. Chaque close maintenant c'est critique. Tout le monde dessus. ALLEZ 🔥`},
        ]);
        // 50-69% — en retard sur la trajectoire, le 7 incertain
        if (pctObjectif < 70) return pick([
          {emoji:"🔥",header:"LE 7 EST ENCORE EN JEU — ON ACCÉLÈRE",texte:`${pctObjectif}% jeudi aprèm. On est légèrement en retard sur la trajectoire de la semaine. Chaque close maintenant rapproche du 7 ce soir 🍺`},
          {emoji:"⚡",header:"L'AFTERWORK AU 7 SE JOUE CET APRÈM",texte:`${pickPhilippePression()} ${pctObjectif}% — on devrait être plus haut à cette heure. L'aprèm est encore longue. Le 7 ce soir c'est faisable si on pousse maintenant 🔥`},
          {emoji:"💪",header:"ON EST DANS LE GAME — MAIS FAUT ACCÉLÉRER",texte:`${pctObjectif}% jeudi aprèm. C'est dans la course mais serré. Si l'aprèm est forte, le 7 ce soir et l'objectif vendredi sont atteignables 🍺`},
          {emoji:"🎯",header:"ON EST SUR LE FIL — L'APRÈM EST DÉCISIVE",texte:`${pickPhilippe()} ${pctObjectif}% à cette heure. L'aprèm va tout décider. On pousse ensemble et le 7 ce soir est validé 💪`},
          {emoji:"🍺",header:"LE 7 SE JOUE MAINTENANT — UN PUSH ET C'EST DEDANS",texte:`${pctObjectif}% jeudi aprèm. On est dans la course mais faut accélérer. Chaque close cet aprèm compte pour le 7 et pour vendredi. ALLEZ 🔥`},
          {emoji:"💥",header:"JEUDI APRÈM — DÉCISIVE POUR LE 7",texte:`${pickPhilippePression()} ${pctObjectif}% et l'aprèm est longue. Si on ferme 2-3 deals là, le 7 ce soir c'est jouable et vendredi sera plus facile 💪`},
          {emoji:"🚀",header:"L'APRÈM PEUT TOUT CHANGER — ON LA JOUE À FOND",texte:`${pctObjectif}% jeudi aprèm. On est légèrement en retard. Mais l'aprèm est encore là. Un push et le 7 ce soir c'est mérité. Allez ! 🎯`},
          {emoji:"⚡",header:"CHAQUE DEAL CET APRÈM = UN PAS VERS LE 7",texte:`${pctObjectif}% en milieu de jeudi. Le 7 est encore jouable. Closes maintenant. ${pickCEO()} Allez les cracks 🍺`},
        ]);
        // 70%+ — sur la trajectoire ou en avance, le 7 est validé
        return pick([
          {emoji:"🏆",header:"LE 7 CE SOIR C'EST VALIDÉ 🍺🔥",texte:`${pctObjectif}%+ jeudi aprèm — on est dans la trajectoire parfaite. Le 7 ce soir vous l'avez mérité. Finissez proprement et on célèbre 🥂`},
          {emoji:"💪",header:"QUELLE SEMAINE ON EST EN TRAIN DE FAIRE",texte:`${pctObjectif}%+ jeudi aprèm. ${pickCEO()} Demain on met le point final. Ce soir : afterwork au 7 bien mérité 🐐`},
          {emoji:"🚀",header:"L'OBJECTIF EST QUASIMENT DANS LA BOÎTE",texte:`${pctObjectif}%+ jeudi aprèm c'est masterclass. Quelques closes et c'est plié. Le 7 ce soir c'est validé 🍺🐐`},
          {emoji:"💥",header:"VOUS ALLEZ FINIR CETTE SEMAINE EN BEAUTÉ",texte:`${pickCEO()} ${pctObjectif}%+ et encore du temps. Ce soir le 7, demain on finit. Cette semaine va être parfaite 🔥`},
          {emoji:"🍺",header:"70%+ JEUDI APRÈM — LE 7 EST ACQUIS",texte:`${pctObjectif}%+ jeudi aprèm. On est sur la bonne trajectoire. Le 7 ce soir c'est validé. Demain on finalise 💪`},
          {emoji:"🐐",header:"JEUDI APRÈM EN AVANCE — VOUS ÊTES DES GOAT",texte:`${pickPhilippe()} ${pctObjectif}%+ à cette heure. Cette semaine va être parfaite. Le 7 vous attend ce soir 🏆`},
          {emoji:"🎉",header:"LE 7 MÉRITE — CE SOIR ON Y VA",texte:`${pctObjectif}%+ jeudi aprèm c'est une semaine de feu. Le 7 ce soir c'est acquis. Demain quelques closes et c'est bouclé 🍺🔥`},
          {emoji:"⚡",header:"EN AVANCE EN PLEIN JEUDI — CETTE SEMAINE EST GAGNÉE",texte:`${pickCEO()} ${pctObjectif}%+ jeudi aprèm. Le 7 ce soir c'est validé. Demain pour finaliser proprement 🚀`},
        ]);
      }
    }

    // VENDREDI
    if (jour === 5) {
      if (h < 12) {
        // Vendredi matin — pas de pression (le matin c'est jamais), ton fun+pro+collectif
        if (pctObjectif < 50) return pick([
          {emoji:"🍺",header:"VENDREDI MATIN — LE BRELAN SE PRÉPARE DÈS MAINTENANT",texte:`${pickPhilippe()} ${pctObjectif}% au compteur. On a toute la journée pour bien finir la semaine. Qui ouvre le bal ce matin ?`},
          {emoji:"☀️",header:"DERNIER MATIN — ON L'UTILISE BIEN",texte:`${pctObjectif}% vendredi matin. Matin + aprèm = une journée entière pour finir fort ensemble 💪`},
          {emoji:"💪",header:"VENDREDI MATIN — ON ENCLENCHE LE FINAL",texte:"Dernière journée de la semaine. On a largement de quoi bien finir si on s'y met ensemble. Qui sort le premier deal ?"},
          {emoji:"🎯",header:"LE MATIN POSE LE RYTHME DE LA JOURNÉE",texte:`${pctObjectif}% au compteur. Un close ce matin et on démarre l'aprèm avec du momentum 🚀`},
          {emoji:"🎬",header:"VENDREDI — LE DERNIER ACTE DE LA SEMAINE",texte:`${pickPhilippe()} On attaque la dernière journée ensemble. Le Brelan ce soir se construit deal après deal, dès ce matin 🍺`},
          {emoji:"💡",header:"VENDREDI MATIN — ON LANCE L'ÉQUIPE",texte:"Dernier jour, on y va calmement mais sérieusement. Chaque close ce matin c'est une brique pour l'aprèm 💪"},
          {emoji:"🚀",header:"LA JOURNÉE EST ENTIÈRE — ON EN PROFITE",texte:`${pickCEO()} Vendredi matin à ${pctObjectif}%. On a de quoi faire une belle fin de semaine. Allez les cracks 🎯`},
          {emoji:"☕",header:"CAFÉ + PREMIER CLOSE — LA FORMULE DU VENDREDI",texte:`${pctObjectif}% au compteur. Qui ouvre le score ce matin pour donner le ton à toute l'équipe ? 🔥`},
        ]);
        if (pctObjectif < 75) return pick([
          {emoji:"🔥",header:"ON EST DANS LE GAME — ON FINIT LA SEMAINE",texte:`Chaque close ce matin = un verre au Brelan ce soir. ${pickCEO()} Qui est chaud ? 🍺`},
          {emoji:"⚡",header:"L'OBJECTIF EST ATTEIGNABLE — ON ACCÉLÈRE",texte:"On est bien positionnés pour finir fort. Ce matin on attaque, l'aprèm on clôture 💪"},
          {emoji:"💪",header:"LA SEMAINE SE FINIT EN BEAUTÉ",texte:`${pickPhilippe()} On est dans les clous. Ce matin on ferme ce qui reste et le Brelan est validé 🍺`},
          {emoji:"🎯",header:"ON EST À UN SPRINT DU BUT",texte:"On est dans la course et il reste toute la journée. L'objectif va tomber si on reste focusés. Allez !"},
          {emoji:"🍺",header:"LE BRELAN SE JOUE CE MATIN — ON LE MÉRITE",texte:`${pickPhilippe()} Vendredi matin dans la course. Chaque deal ce matin rapproche du Brelan ce soir. Qui balance le prochain ? 🔥`},
          {emoji:"💥",header:"VENDREDI MATIN SOLIDE — ON FINIT LA SEMAINE FORT",texte:`${pickCEO()} On est dans les clous. Ce matin pour avancer, l'aprèm pour finir. Le Brelan nous attend ce soir 🎉`},
          {emoji:"🚀",header:"LE MOMENTUM EST LÀ — ON LE GARDE",texte:"Vendredi matin dans la course. Si on garde ce rythme sur la journée, l'objectif va tomber. Allez les cracks 💪"},
          {emoji:"⚡",header:"UN BON VENDREDI MATIN POUR UN BEAU VENDREDI SOIR",texte:`${pickPhilippe()} On est bien placés. Ce matin on ferme, cet aprèm on finalise, ce soir on célèbre au Brelan 🍺`},
        ]);
        if (pctObjectif >= 75) return pick([
          {emoji:"🏆",header:"QUELLE SEMAINE ON VIENT DE FAIRE 🔥",texte:`75%+ et le dernier matin devant nous. Quelques closes et c'est dans la boîte. Le Brelan est validé 🍺🎉`},
          {emoji:"💪",header:"ON FINIT CETTE SEMAINE EN BEAUTÉ",texte:`Vendredi matin avec 75%+. ${pickCEO()} On finit proprement et on célèbre 👑`},
          {emoji:"🚀",header:"L'OBJECTIF EST QUASI BOUCLÉ",texte:"75%+ vendredi matin c'est une semaine de feu. Finissez et cette semaine rejoint le hall of fame 🏆"},
          {emoji:"💥",header:"CETTE SEMAINE EST DÉJÀ GAGNÉE",texte:`${pickCEO()} 75%+ vendredi matin. Finissez proprement et profitez du weekend, vous l'avez mérité 🥂`},
          {emoji:"🍺",header:"LE BRELAN EST VALIDÉ — ON FINIT PROPREMENT",texte:`${pctObjectif}%+ vendredi matin. Le Brelan ce soir c'est acquis. Quelques closes pour boucler l'objectif et on célèbre 🎉`},
          {emoji:"🐐",header:"VENDREDI MATIN EN AVANCE — C'EST DES GOAT",texte:`${pickPhilippe()} 75%+ vendredi matin c'est masterclass. L'objectif va tomber aujourd'hui. Le Brelan vous attend 🏆`},
          {emoji:"🎯",header:"LA SEMAINE EST GAGNÉE — ON FINIT EN BEAUTÉ",texte:`${pickCEO()} 75%+ et la journée devant nous. L'objectif va tomber avant ce soir. Le Brelan c'est validé 💪`},
          {emoji:"⚡",header:"UNE BELLE SEMAINE QUI SE FINIT EN BEAUTÉ",texte:`${pctObjectif}%+ vendredi matin. Cette semaine va être mémorable. Finissez proprement et profitez du Brelan ce soir 🍺🔥`},
        ]);
      }
      if (h >= 12) {

        // ── VENDREDI DERNIER SPRINT (16h+) — 2 dernières heures de closing ──
        // À ce stade, l'objectif hebdo est hors de portée si on est < 85%.
        // Les messages doivent être RÉALISTES — on ne dit plus "quelques closes et c'est plié"
        if (h >= 16) {
          if (pctObjectif < 50) return pick([
            {emoji:"🚨",header:"DERNIER SPRINT — ON FINIT FORT QUAND MÊME",texte:`${pickPhilippePression()} L'objectif hebdo sera pas atteint cette semaine. Mais on peut encore faire une belle fin. Qui close maintenant ? 💪`},
            {emoji:"💥",header:"LA SEMAINE FINIT ICI — ON MAXIMISE CE QUI RESTE",texte:`On est à ${pctObjectif}%, l'objectif de la semaine c'est plié. Mais chaque close dans les 2 prochaines heures c'est du concret pour le next. ALLEZ 😤`},
            {emoji:"🚨",header:"ON TIRE LES LEÇONS — ET ON FINIT LE BOULOT",texte:`La semaine a été difficile. On analyse lundi. Ce soir on ferme tout ce qu'on peut fermer et on repart la tête haute 🔥`},
            {emoji:"⚡",header:"VENDREDI FIN DE JOURNÉE — ON LAISSE TOUT SUR LE TERRAIN",texte:`${pickPhilippePression()} L'objectif est loin mais ça ne change rien à l'engagement. On donne tout jusqu'à la dernière minute. Allez ! 💪`},
            {emoji:"🔥",header:"SEMAINE DIFFICILE — ON FINIT LA TÊTE HAUTE",texte:`${pctObjectif}% vendredi 16h+. L'objectif c'est pas pour ce soir. Mais chaque close dans les 2 prochaines heures c'est pour l'honneur. ALLEZ 😤`},
            {emoji:"💪",header:"ON NE LÂCHE PAS — MÊME EN FIN DE SEMAINE",texte:"L'objectif est hors de portée. Mais les vrais closent jusqu'à la dernière minute. Qui ferme encore quelque chose ce soir ? 🎯"},
            {emoji:"🚀",header:"LES DERNIÈRES HEURES COMPTENT POUR LUNDI",texte:`${pickPhilippePression()} Fin de semaine difficile. Mais les closes de ce soir ça construit le momentum de lundi. On y va 💥`},
            {emoji:"⚡",header:"CHAQUE DEAL CE SOIR C'EST UN MEILLEUR LUNDI",texte:"L'objectif hebdo c'est pas pour ce soir, c'est factuel. Mais on peut encore créer du momentum pour la semaine prochaine. Allez ! 💪"},
          ]);
          if (pctObjectif < 75) return pick([
            {emoji:"🔥",header:"BELLE SEMAINE MALGRÉ TOUT — ON FINIT PROPREMENT",texte:`${pctObjectif}% c'est une semaine solide. L'objectif sera pas plié ce soir, mais chaque close maintenant c'est du bonus pour lundi. Allez !`},
            {emoji:"⚡",header:"DERNIERS CLOSES — CHAQUE DEAL COMPTE POUR LA SUITE",texte:`${pickPhilippePression()} On ferme cette semaine fort. Ce qu'on close maintenant ça impacte le next sprint. QUI EST ENCORE CHAUD ? 🔥`},
            {emoji:"💥",header:"ON OPTIMISE LA FIN DE SEMAINE",texte:`On est à ${pctObjectif}%. L'objectif hebdo c'est pas pour ce soir. Mais finir à 70-75% c'est honorable. On y va 💪`},
            {emoji:"🎯",header:"DERNIÈRES HEURES — ON LAISSE TOUT SUR LE TERRAIN",texte:`${pickCEO()} La semaine touche à sa fin. Ce qui se close dans les 2 prochaines heures c'est pour l'honneur et pour le lundi. ALLEZ 🏆`},
            {emoji:"🔥",header:"ON FERME CETTE SEMAINE EN TÊTE HAUTE",texte:`${pickPhilippe()} Chaque deal ce soir c'est du momentum pour la semaine prochaine. On lâche rien jusqu'à la fin. 💪`},
            {emoji:"💪",header:"SEMAINE HONORABLE — ON LA FINIT PROPREMENT",texte:`${pctObjectif}% vendredi fin de journée c'est une semaine solide. L'objectif était ambitieux. On finit fort et on repart lundi 🎯`},
            {emoji:"🚀",header:"CHAQUE CLOSE MAINTENANT C'EST DU CARBURANT POUR LUNDI",texte:`${pickPhilippePression()} On ferme cette semaine avec du chiffre. Chaque deal de ce soir construit la semaine prochaine. Allez ! 🔥`},
            {emoji:"⚡",header:"VENDREDI SOIR — ON FINIT FORT QUELLE QUE SOIT LA SITUATION",texte:"L'objectif sera pas là ce soir mais la fierté de finir fort, elle, elle sera là. Closes jusqu'à la dernière minute 💥"},
          ]);
          if (pctObjectif < 90) return pick([
            {emoji:"🔥",header:"ON EST SI PROCHES — ON DONNE TOUT",texte:`${pctObjectif}% à 2h de la fin de semaine. L'objectif est pas loin. Chaque close maintenant peut tout changer. QUI SORT LE PROCHAIN DEAL ? 🔥`},
            {emoji:"⚡",header:"LA SEMAINE PEUT ENCORE ÊTRE PARFAITE",texte:`${pickPhilippePression()} On est à ${pctObjectif}%. Quelques closes et l'objectif hebdo tombe ce soir. ALLEZ LES CRACKS 💪`},
            {emoji:"💥",header:"LE FINISH — C'EST MAINTENANT",texte:`Fin de semaine, ${pctObjectif}% au compteur. On est si proches. Les boss finals ferment les deals maintenant. Le Brelan se mérite 🍺`},
            {emoji:"🎯",header:"LES DEUX DERNIÈRES HEURES FONT LA SEMAINE",texte:`On est dans la zone de finish. ${pickCEO()} On a encore le temps de boucler l'objectif. ALLEZ 🏆`},
            {emoji:"🍺",header:"LE BRELAN EST JOUABLE — ON POUSSE ENSEMBLE",texte:`${pctObjectif}% en fin de semaine. On est proches. Si on close encore là, le Brelan ce soir c'est mérité. ALLEZ 🔥`},
            {emoji:"💪",header:"ON EST À QUELQUES DEALS DU BUT",texte:`${pickPhilippePression()} ${pctObjectif}% et encore 2h. L'objectif hebdo est tangible. Closes maintenant. Les boss finals se révèlent en fin de semaine 💥`},
            {emoji:"🚀",header:"FIN DE SEMAINE — L'OBJECTIF EST LÀ",texte:`${pctObjectif}%+ en fin de semaine. C'est encore jouable. Chaque close maintenant peut faire basculer la semaine. Allez ! 🏆`},
            {emoji:"⚡",header:"LA LIGNE D'ARRIVÉE EST VISIBLE — ON L'ATTEINT",texte:`${pickCEO()} ${pctObjectif}% et la fin de semaine. On est proches. Les closes des 2 prochaines heures vont décider. Qui est chaud ? 🎯`},
          ]);
          // >= 90% — objectif à portée réelle
          return pick([
            {emoji:"🏆",header:"ON FINIT CETTE SEMAINE EN BEAUTÉ 🍺🎉",texte:`${pctObjectif}%+ et 2 dernières heures. Le Brelan ce soir c'est validé. Finissez proprement et on célèbre 🥂`},
            {emoji:"💥",header:"QUELLE SEMAINE ON VIENT DE FAIRE 🔥",texte:`${pickCEO()} ${pctObjectif}%+ en fin de semaine. Quelques closes et l'objectif tombe. On profite du weekend 🏆`},
            {emoji:"🚀",header:"L'OBJECTIF EST QUASI BOUCLÉ",texte:`${pctObjectif}%+ en fin de journée. Finissez et cette semaine rejoint le hall of fame 🐐`},
            {emoji:"💪",header:"QUELLE TEAM — OFFICIELLEMENT",texte:`${pickPhilippe()} ${pctObjectif}%+ et on approche de la ligne. Deux ou trois closes et c'est parfait. BRAVO LES BOSS 🙌`},
            {emoji:"🍺",header:"90%+ EN FIN DE SEMAINE — LE BRELAN EST ACQUIS",texte:`${pctObjectif}%+ en fin de semaine. Le Brelan ce soir c'est largement mérité. Finissez proprement et cette semaine est parfaite 🎉`},
            {emoji:"🐐",header:"CETTE SEMAINE EST DÉJÀ DANS LE HALL OF FAME",texte:`${pickCEO()} ${pctObjectif}%+ en fin de semaine. L'objectif va tomber dans les 2 prochaines heures. On est des GOAT 🏆`},
            {emoji:"🎯",header:"ON EST À QUELQUES CLOSES DE LA PERFECTION",texte:`${pctObjectif}%+ et la semaine se finit. Finissez ce que vous avez commencé. Le Brelan ce soir c'est validé 💪`},
            {emoji:"⚡",header:"UNE SEMAINE EXCEPTIONNELLE SE FINIT",texte:`${pickPhilippe()} ${pctObjectif}%+ en fin de journée. Le Brelan vous attend. On finit proprement et on célèbre 🍺🔥`},
          ]);
        }

        // ── VENDREDI DÉBUT D'APRÈM (12h-16h) ──
        // À 54% vendredi aprèm, l'objectif hebdo est HORS DE PORTÉE. Seuils réalistes :
        // < 65% → hors de portée, on maximise et prépare lundi
        // 65-84% → encore jouable si l'aprèm est forte
        // 85%+ → à portée réelle
        if (pctObjectif < 50) return pick([
          {emoji:"🚨",header:"C'EST MAINTENANT OU JAMAIS 🚨",texte:`${pickPhilippePression()} Dernier aprèm de la semaine. L'objectif est loin mais chaque close maintenant ça compte. ALLEZ 🔥`},
          {emoji:"💥",header:"DERNIER APRÈM — ON DONNE TOUT CE QUI RESTE",texte:"On est loin de l'objectif et le temps tourne. Mais chaque deal fermé ce soir ça se retient. On y va 😤"},
          {emoji:"🚨",header:"LA SEMAINE SE FINIT ICI — ON MAXIMISE",texte:`${pickPhilippePression()} L'objectif hebdo sera compliqué. Mais on ferme tout ce qu'on peut avant 18h. Closes en série 💪`},
          {emoji:"⚡",header:"VENDREDI APRÈM — ON LAISSE TOUT SUR LE TERRAIN",texte:"L'objectif est hors de portée pour ce soir. Mais finir fort c'est ce qui compte. Qui sort le prochain close ? 🔥"},
          {emoji:"🔥",header:"SEMAINE DIFFICILE — ON FINIT QUAND MÊME FORT",texte:`${pickPhilippePression()} L'objectif hebdo sera pas là. Mais fermer la semaine avec des closes c'est ce qu'on fait. ALLEZ 💥`},
          {emoji:"💪",header:"VENDREDI APRÈM — CHAQUE CLOSE C'EST POUR L'HONNEUR",texte:"L'objectif c'est plié pour cette semaine. Mais les closes de l'aprèm ça construit le momentum de lundi. Qui y va ? 🎯"},
          {emoji:"🚀",header:"ON FINIT CE QU'ON A COMMENCÉ",texte:`${pickPhilippePression()} La semaine a été difficile. Mais on la finit avec de la dignité. Closes jusqu'à 18h, tout le monde dessus 😤`},
          {emoji:"⚡",header:"DERNIER APRÈM DE LA SEMAINE — ON LE RESPECTE",texte:"L'objectif hebdo est loin. Mais chaque deal de l'aprèm c'est du réel. On lâche pas jusqu'à la dernière minute 💪"},
        ]);
        if (pctObjectif < 65) return pick([
          {emoji:"🔥",header:"ON A FAIT LA MOITIÉ — ON MAXIMISE LA FIN",texte:`${pickPhilippePression()} L'objectif de la semaine sera pas plié ce soir. Mais chaque close maintenant c'est du concret. ALLEZ 💪`},
          {emoji:"⚡",header:"VENDREDI APRÈM — ON FINIT CE QU'ON A COMMENCÉ",texte:"On est à mi-chemin de l'objectif. Le reste on le fait pas ce soir. Mais on ferme tout ce qui peut être fermé. 😤"},
          {emoji:"💥",header:"LA SEMAINE FINIT ICI — ON DONNE TOUT",texte:`${pickCEO()} On a bien bossé cette semaine. L'objectif était ambitieux. On donne tout jusqu'au bout. Allez !`},
          {emoji:"🎯",header:"CHAQUE DEAL MAINTENANT C'EST DU MOMENTUM POUR LUNDI",texte:`${pickPhilippe()} On finit cette semaine la tête haute. Closes en série cet aprèm, c'est pour l'honneur et pour le next sprint. 🔥`},
        ]);
        if (pctObjectif < 85) return pick([
          {emoji:"🔥",header:"L'APRÈM PEUT TOUT CHANGER — ON POUSSE",texte:`On est à ${pctObjectif}% et l'aprèm est encore là. C'est jouable si on se met tous dessus maintenant. ${pickCEO()} 💪`},
          {emoji:"⚡",header:"LE DERNIER SPRINT DE LA SEMAINE COMMENCE",texte:`${pickPhilippePression()} On est dans la course. L'objectif peut encore tomber si l'aprèm est forte. Tout le monde dessus ! 🔥`},
          {emoji:"💥",header:"ON EST DANS LE GAME — ON FINIT LE BOULOT",texte:`${pctObjectif}% et toute l'aprèm devant nous. L'objectif est atteignable si on ne lâche rien. Closes en série. Allez !`},
          {emoji:"🎯",header:"L'APRÈM EST DÉCISIVE — ON LA JOUE À FOND",texte:`${pickPhilippe()} On est bien positionnés pour finir fort. Chaque close cet aprèm peut faire basculer la semaine. 🍺`},
        ]);
        // >= 85% — à portée réelle
        return pick([
          {emoji:"🏆",header:"ON FINIT CETTE SEMAINE EN BEAUTÉ 🍺",texte:`${pctObjectif}%+ et toute l'aprèm devant nous. L'objectif est à portée. Quelques closes et c'est plié. ${pickCEO()} 🥂`},
          {emoji:"💥",header:"L'OBJECTIF VA TOMBER CET APRÈM",texte:`${pickPhilippe()} ${pctObjectif}%+ vendredi aprèm. On finit fort et le Brelan ce soir c'est mérité. ALLEZ 🏆`},
          {emoji:"🚀",header:"QUELQUES DEALS ET C'EST DANS LA BOÎTE",texte:`${pctObjectif}% et l'aprèm commence. L'objectif est à portée. Finissez proprement et cette semaine rejoint le hall of fame 🐐`},
          {emoji:"💪",header:"ON EST À UN SPRINT DU BUT",texte:`${pickPhilippe()} ${pctObjectif}%+ vendredi aprèm. Le Brelan vous attend. Fermez les derniers deals et on célèbre 🍺🔥`},
        ]);
      }
    }

    // WEEK-END (samedi / dimanche) — rare mais possible
    if (jour === 6 || jour === 0) {
      if (pctObjectif < 50) return pick([
        {emoji:"💪",header:"LA SEMAINE PROCHAINE ON FRAPPE FORT",texte:`On finit à ${pctObjectif}%. Le weekend c'est pour recharger et revenir lundi en mode berserker 🔥`},
        {emoji:"🎯",header:"ON ANALYSE ET ON REVIENT PLUS FORTS",texte:`${pctObjectif}% cette semaine. Weekend pour recharger les batteries, lundi pour attaquer 💪`},
        {emoji:"⚡",header:"ON RECHARGE ET ON REVIENT",texte:`${pctObjectif}% cette semaine. La semaine prochaine on fait mieux. Bon weekend les gars 😤`},
        {emoji:"🔥",header:"LE PROCHAIN SPRINT COMMENCE LUNDI",texte:`${pickPhilippePression()} ${pctObjectif}% cette semaine. On analyse, on ajuste, et lundi c'est reparti 🚀`},
      ]);
      return pick([
        {emoji:"🏆",header:"BELLE SEMAINE LES GARS",texte:`${pctObjectif}% — c'est une semaine solide. Profitez du weekend, vous le méritez. Lundi on repart de plus belle 🙌`},
        {emoji:"🔥",header:"VOUS AVEZ BIEN TRAVAILLÉ CETTE SEMAINE",texte:`${pickCEO()} ${pctObjectif}% cette semaine c'est du solide. Bon weekend ! 👑`},
        {emoji:"💪",header:"LE WEEKEND C'EST POUR LES GENS QUI ONT TOUT DONNÉ",texte:`${pctObjectif}% — le weekend se mérite et vous l'avez mérité. Rechargez les batteries et revenez lundi en mode killer 🔥`},
        {emoji:"🏆",header:"BELLE PERFORMANCE CETTE SEMAINE",texte:`${pickPhilippe()} ${pctObjectif}% au compteur. Bon weekend, et lundi on repart encore plus fort 💪`},
      ]);
    }
  }

  // ── OBJECTIF JOURNALIER ──────────────────────────────────
  if (!isHebdo) {

    // MATIN (avant 12h)
    if (h < 12) {
      if (pctObjectif < 10) return pick([
        {emoji:"☕",header:"LA JOURNÉE COMMENCE — QUI OUVRE LE BAL ?",texte:"L'objectif journalier nous regarde. Chaque close maintenant c'est de l'avance. Qui se lance en premier ?"},
        {emoji:"🚀",header:"LE COMPTEUR ATTEND SON PREMIER DEAL",texte:"On est encore tôt et c'est bien. Mais l'objectif attend pas. Premier deal de la journée, qui se lance ?"},
        {emoji:"🎯",header:"PREMIER CLOSE DE LA JOURNÉE — QUI LE PREND ?",texte:"La journée commence et le compteur est à zéro. C'est l'heure d'ouvrir le score. Allez les gars !"},
        {emoji:"💪",header:"ON DÉMARRE — QUI OUVRE ?",texte:`${pickCEO()} Le compteur attend. Premier close de la journée, qui est chaud ? ☕`},
      ]);
      if (pctObjectif < 30) return pick([
        {emoji:"🔥",header:"BON DÉBUT — ON TIENT CE RYTHME",texte:"Belle mise en route ce matin. Si on garde ce rythme l'objectif va tomber avant 17h. Allez les cracks !"},
        {emoji:"💪",header:"LE RYTHME EST LÀ — ON ACCÉLÈRE",texte:`${pickCEO()} On démarre bien. On continue et l'objectif va tomber aujourd'hui 😤`},
        {emoji:"⚡",header:"ON DÉMARRE SUR LES CHAPEAUX DE ROUES",texte:"Belle mise en route. Chaque deal de plus maintenant c'est de la marge pour l'aprèm. On lâche rien !"},
        {emoji:"🎯",header:"C'EST PARTI — ON LÂCHE RIEN",texte:`Bon début de journée. ${pickPhilippe()} Si on garde ce rythme, l'objectif va tomber avant 17h 💪`},
      ]);
    }

    // MILIEU DE JOURNÉE (12h-15h)
    if (h >= 12 && h < 15) {
      if (pctObjectif < 30) return pick([
        {emoji:"🚨",header:"L'APRÈM COMMENCE — ON DOIT ACCÉLÉRER",texte:`${pickPhilippePression()} On a l'aprèm pour tout rattraper. Closes en série, allez 😤`},
        {emoji:"💥",header:"LE SPRINT DE L'APRÈM COMMENCE",texte:"On est à la moitié de la journée et l'objectif est loin. Il faut inverser MAINTENANT. Tout le monde dessus 🔥"},
        {emoji:"🚨",header:"ON A L'APRÈM — ON L'UTILISE",texte:`${pickPhilippePression()} L'objectif est loin mais l'aprèm est longue. Closes en série, pas le temps d'attendre 💪`},
        {emoji:"⚡",header:"LA REMONTADA COMMENCE",texte:"Moitié de journée, encore beaucoup à faire. Mais l'aprèm peut tout changer. On y met tout, ALLEZ !"},
      ]);
      if (pctObjectif < 50) return pick([
        {emoji:"⚡",header:"ON EST SUR LE FIL — L'APRÈM EST DÉCISIVE",texte:"Moitié de journée, moins de moitié de l'objectif. L'aprèm va faire la différence. Tout le monde pousse !"},
        {emoji:"🔥",header:"LE MOMENTUM EST LÀ — ON EN PROFITE",texte:"On est dans la course. L'aprèm va faire la différence. On finit cette journée en beauté 🎯"},
        {emoji:"💪",header:"ON EST DANS LES CLOUS — ON ACCÉLÈRE",texte:`${pickCEO()} Bon positionnement à midi. L'aprèm pour creuser l'écart. Allez !`},
        {emoji:"🎯",header:"LE GAME EST OUVERT — ON LE GAGNE",texte:"Bien positionnés à mi-journée. L'aprèm pour tout finir. Qui sort le prochain close ? 💪"},
      ]);
      if (pctObjectif >= 50) return pick([
        {emoji:"🏆",header:"DÉJÀ 50%+ — QUELLE TEAM 🙌",texte:`Moitié de journée et plus de la moitié de l'objectif. Bravo. ${pickCEO()} 👑`},
        {emoji:"💪",header:"ON EST EN AVANCE — ON CREUSE L'ÉCART",texte:"En avance sur l'objectif journalier à midi. Si on continue comme ça on va le pulvériser. Des GOAT 🐐"},
        {emoji:"🚀",header:"L'OBJECTIF VA TOMBER CET APRÈM",texte:`50%+ à midi c'est masterclass. ${pickPhilippe()} L'aprèm pour finir en beauté 🔥`},
        {emoji:"💥",header:"QUELLE MATINÉE VOUS VENEZ DE FAIRE",texte:`${pickCEO()} 50%+ avant midi. L'objectif va tomber bien avant 18h si on continue 🏆`},
      ]);
    }

    // FIN DE JOURNÉE (15h+)
    if (h >= 15) {
      if (pctObjectif < 40) return pick([
        {emoji:"🚨",header:"SPRINT TOTAL — IL RESTE PEU DE TEMPS",texte:`${pickPhilippePression()} C'est maintenant que les vrais se révèlent. ALLEZ, tout le monde dessus 🔥`},
        {emoji:"💥",header:"C'EST MAINTENANT OU JAMAIS",texte:"Il reste peu de temps et l'objectif est encore loin. Closes en série immédiatement. Allez la team !"},
        {emoji:"🚨",header:"LES DERNIÈRES HEURES SONT LÀ",texte:`${pickPhilippePression()} Chaque deal maintenant compte triple. On ferme tout ce qu'on peut avant 18h 💪`},
        {emoji:"⚡",header:"ON A LES DERNIÈRES HEURES — ON LES UTILISE",texte:"Il reste du temps. Closes en série maintenant et l'objectif peut encore tomber. Allez les cracks !"},
      ]);
      if (pctObjectif < 70) return pick([
        {emoji:"🔥",header:"ON EST DANS LA COURSE — ON FINIT LE BOULOT",texte:"On approche. Chaque close maintenant est décisif. Vous êtes des machines, finissez ce que vous avez commencé 💪"},
        {emoji:"⚡",header:"LE FINISH EST LÀ",texte:`L'objectif est à portée. Les derniers closes de la journée appartiennent aux boss finals. ${pickCEO()} 👑`},
        {emoji:"💪",header:"ON Y EST PRESQUE — ON FINIT",texte:`${pickPhilippe()} On approche de l'objectif. Qui sort le dernier close ? 🎯`},
        {emoji:"🎯",header:"L'OBJECTIF EST ACCESSIBLE — ON CLOSE",texte:"On est bien positionnés pour finir cette journée fort. Quelques closes et c'est dans la boîte. Allez !"},
      ]);
      if (pctObjectif >= 70) return pick([
        {emoji:"🏆",header:"L'OBJECTIF VA TOMBER AUJOURD'HUI 🔥",texte:`70%+ en fin de journée c'est énorme. ${pickCEO()} Finissez proprement et cette journée sera parfaite 🐐`},
        {emoji:"💥",header:"VOUS ALLEZ PULVÉRISER L'OBJECTIF",texte:"On est si proches que c'est douloureux 😤 Quelques closes et c'est dans la boîte. Allez les boss !"},
        {emoji:"🚀",header:"L'OBJECTIF EST QUASIMENT PLIÉ",texte:`${pickPhilippe()} 70%+ en fin de journée. Finissez et cette journée rejoint le hall of fame 🏆`},
        {emoji:"💪",header:"QUELLE TEAM — OFFICIELLEMENT 🙌",texte:`${pickCEO()} 70%+ et encore du temps. Cette journée va être parfaite 🔥`},
      ]);
    }
  }

  // Fallback
  return null;
}

// ============================================================
// VÉRIFICATION MILESTONES
// ============================================================
// verifierMilestone : ne renvoie QUE les paliers 25/50/75/100.
// Entre deux milestones forcés (toutes les 5 flushes), cette fonction
// renvoie null, donc le compteur s'affiche seul sans header décoratif.
function verifierMilestone(objectifDepart, objectif) {
  if (!objectifDepart || objectifDepart <= 0) return null;
  const pct = Math.round((1 - Math.max(0, objectif) / objectifDepart) * 100);

  for (const threshold of [25, 50, 75, 100]) {
    if (pct >= threshold && !state.milestonesVus.includes(threshold)) {
      state.milestonesVus.push(threshold);
      sauvegarderState(state);
      const m = MILESTONES[String(threshold)];
      return {
        emoji: m.emoji,
        header: pick(m.header),
        texte: pick(m.texte),
      };
    }
  }
  return null;
}

// getMilestoneForce : utilisé uniquement pour les milestones FORCÉS
// (tous les 5 compteurs). Ordre : palier franchi > adaptatif (contextuel
// jour/heure/avancement) > fallback générique.
function getMilestoneForce(objectifDepart, objectif) {
  const m = verifierMilestone(objectifDepart, objectif);
  if (m) return m;
  const pct = objectifDepart > 0 ? Math.round((1 - Math.max(0, objectif) / objectifDepart) * 100) : 0;
  const adaptatif = getMilestoneAdaptatif(pct);
  if (adaptatif) return adaptatif;
  return pick([
    {emoji:"🔥",header:"ON CONTINUE — DEAL APRÈS DEAL",texte:`${pickPhilippe()} Chaque close compte, on lâche rien. 💪`},
    {emoji:"⚡",header:"LE MOMENTUM EST LÀ — ON EN PROFITE",texte:`${pickCEO()} Gardez la cadence les gars !`},
    {emoji:"💪",header:"C'EST COMME ÇA QU'ON CONSTRUIT UN OBJECTIF",texte:"Deal après deal, close après close. C'est le game et vous êtes dans le game 🎯"},
    {emoji:"🚀",header:"VOUS ENVOYEZ DE LA FRAPPE — CONTINUEZ",texte:`${pickCEO()} On est sur la bonne trajectoire 📈`},
    {emoji:"😤",header:"LA TEAM EST EN TRAIN DE CLOSER",texte:`${pickPhilippe()} C'est exactement ce qu'on veut voir. Bravo les boss 🐐`},
    {emoji:"🏆",header:"DEAL AFTER DEAL — C'EST LE STYLE MONEY LISA",texte:"On accumule, on cumule, on performe. L'objectif va tomber si vous continuez comme ça 🎯"},
  ]);
}

// ============================================================
// CONSTRUCTION DU CALCUL
// ============================================================
function construireCalcul(deals, ancienObjectif, restant) {
  const debut  = `*${ancienObjectif.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€*`;
  const soustr = deals.flatMap(d=>(d.leads&&d.leads.length>1?d.leads:[d.montant])).map(l=>`−  ${l.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€`).join("  ");
  const res    = `*${restant.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€*`;
  const obj    = `${state.objectifDepart.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€  _(${state.modeLabel})_`;
  return `${debut}  ${soustr}  =  ${res}  /  ${obj}`;
}

// ============================================================
// CONSTRUCTION DU MESSAGE
// ------------------------------------------------------------
// Deux flux STRICTEMENT séparés :
//
//   FLUX A — COMPTEUR NU (cas par défaut, 4 flushes sur 5)
//     → titre + divider + calcul + barre. RIEN d'autre.
//     → pas de pression, pas de phrase décorative, rien.
//
//   FLUX B — COMPTEUR AVEC MILESTONE (tous les 5 flushes OU
//             quand un palier 25/50/75/100 est franchi)
//     → titre + bloc milestone + divider + calcul + barre.
//
// Le booster 🍑 "cadence lente" n'est PLUS couplé au flush de
// compteur : il est désormais envoyé par le planificateur 16h
// lun/mer/ven (voir demarrerBoosterCadence16h).
// ============================================================
function construireMessage(deals, ancienObjectif, restant, objectifDepart, milestone) {
  const depasse     = restant<0;
  const depasseAff  = Math.abs(restant).toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2});
  const calcul      = construireCalcul(deals, ancienObjectif, restant);
  const blocks      = [];

  // ── 1. TITRE (toujours) ──────────────────────────────────
  blocks.push({type:"section",text:{type:"mrkdwn",text:`🚨  *COMPTEUR MONEY LISA*  🚨`}});

  // ── 2. BLOC MILESTONE (FLUX B uniquement) ────────────────
  if (milestone) {
    const _bonus1 = getBonusMilestone();
    blocks.push({type:"section",text:{type:"mrkdwn",text:`${milestone.emoji}  *${milestone.header}*  ${milestone.emoji}\n${milestone.texte}${_bonus1?`\n${_bonus1}`:""}`}});
  }
  // ⚠️ PAS de "else" : en FLUX A on n'ajoute AUCUN bloc décoratif.

  blocks.push({type:"divider"});

  // ── 3. DÉPASSEMENT ───────────────────────────────────────
  if (depasse) {
    const msg = pick(MESSAGES_DEPASSEMENT);
    blocks.push({type:"section",text:{type:"mrkdwn",text:calcul}});
    blocks.push({type:"section",text:{type:"mrkdwn",text:barreProgression(objectifDepart,restant)}});
    blocks.push({type:"divider"});
    blocks.push({type:"section",text:{type:"mrkdwn",text:`🏆  *${msg.header}*\n> *Objectif pour ${state.modeLabel} : ${state.objectifDepart.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€*\n> *+${depasseAff}€ AU-DESSUS DE L'OBJECTIF* 🔥\n\n${msg.texte}`}});
    return blocks;
  }

  // ── 4. CALCUL ────────────────────────────────────────────
  blocks.push({type:"section",text:{type:"mrkdwn",text:calcul}});

  // ── 5. BARRE ─────────────────────────────────────────────
  blocks.push({type:"section",text:{type:"mrkdwn",text:barreProgression(objectifDepart,restant)}});

  return blocks;
}

// ============================================================
// STATUT
// ============================================================
async function envoyerStatut(channel, client) {
  const mrrBuffer      = state.buffer.reduce((s,d)=>s+d.montant,0);
  const ancienObjectif = state.objectif;

  const bufferSnapshot = [...state.buffer];
  if (state.buffer.length>0) {
    const now=new Date(), dateStr=now.toISOString().split("T")[0], weekStr=getWeekKey(now);
    state.buffer.forEach(d=>{
      if (!state.salesStats[d.userId]) state.salesStats[d.userId]={name:d.user,closes:[]};
      if (!state.salesStats[d.userId].closes.some(c=>c.ts===d.ts))
        state.salesStats[d.userId].closes.push({ts:d.ts,montant:d.montant,date:dateStr,week:weekStr});
      state.tsDejaComptes.push(d.ts);
      state.montantsComptes[d.ts]=d.montant;
    });
    state.objectif -= mrrBuffer;
    state.buffer    = [];
    sauvegarderState(state);
  }

  // Statut : on n'affiche QUE le palier franchi (25/50/75/100) s'il
  // y en a un. Pas de pression, pas de décoration d'ambiance — sinon
  // le /statut ressemble à un milestone à chaque appel.
  const milestone = verifierMilestone(state.objectifDepart, state.objectif);

  const calcul = mrrBuffer>0
    ? `*${ancienObjectif.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€*  ${bufferSnapshot.flatMap(d=>(d.leads&&d.leads.length>1?d.leads:[d.montant])).map(l=>`−  ${l.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€`).join("  ")}  =  *${Math.max(0,state.objectif).toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€*  /  ${state.objectifDepart.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€  _(${state.modeLabel})_`
    : `*${Math.max(0,state.objectif).toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€*  /  ${state.objectifDepart.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€  _(${state.modeLabel})_`;

  const blocks = [];

  // ── 1. TITRE ─────────────────────────────────────────────
  blocks.push({type:"section",text:{type:"mrkdwn",text:`🚨  *COMPTEUR MONEY LISA*  🚨`}});

  // ── 2. MILESTONE uniquement (pas de pression) ────────────
  if (milestone) {
    const _bonus2 = getBonusMilestone();
    blocks.push({type:"section",text:{type:"mrkdwn",text:`${milestone.emoji}  *${milestone.header}*  ${milestone.emoji}\n${milestone.texte}${_bonus2?`\n${_bonus2}`:""}`}});
  }

  blocks.push({type:"divider"});

  // ── 3. CALCUL ────────────────────────────────────────────
  blocks.push({type:"section",text:{type:"mrkdwn",text:calcul}});

  // ── 4. BARRE ─────────────────────────────────────────────
  blocks.push({type:"section",text:{type:"mrkdwn",text:barreProgression(state.objectifDepart,state.objectif)}});

  await client.chat.postMessage({channel,text:`🚨 COMPTEUR`,blocks});
}

// ============================================================
// MESSAGE MODIFICATION / SUPPRESSION
// ============================================================
function construireMessageModif(restant, objectifDepart, msgTexte, isSuppression=false) {
  const calcul = `*${objectifDepart.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€*  →  *${Math.max(0,restant).toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€*  _(${state.modeLabel})_`;
  return [
    {type:"section",text:{type:"mrkdwn",text:`${isSuppression?"🗑️":"✏️"}  ${msgTexte}`}},
    {type:"divider"},
    {type:"section",text:{type:"mrkdwn",text:`🚨  *COMPTEUR MONEY LISA*  🚨`}},
    {type:"divider"},
    {type:"section",text:{type:"mrkdwn",text:calcul}},
    {type:"section",text:{type:"mrkdwn",text:barreProgression(objectifDepart,restant)}},
  ];
}

// ============================================================
// TOP SALES
// ============================================================
function detecterPeriodeTopSales(texte) {
  return /daily|journ[eé]e?|aujourd|ajd|aujrd|day\b/i.test(texte) ? "daily" : "weekly";
}
function detecterModeTopSales(texte) {
  return /valeur|mrr|montant|chiffre|€|euro/i.test(texte) ? "valeur" : "closes";
}
function calculerTopSales(periode, mode) {
  const now=new Date(), dateStr=now.toISOString().split("T")[0], weekStr=getWeekKey(now);
  const scores={};
  for (const [uid,data] of Object.entries(state.salesStats)) {
    const closes=(data.closes||[]).filter(c=>periode==="daily"?c.date===dateStr:c.week===weekStr);
    if (closes.length===0) continue;
    scores[uid]={name:data.name,closes:closes.length,mrr:closes.reduce((s,c)=>s+c.montant,0)};
  }
  return Object.values(scores).sort((a,b)=>mode==="valeur"?b.mrr-a.mrr:b.closes-a.closes).slice(0,3);
}
const MESSAGES_TOP_SALES_FIN = [
  "Continuez comme ça la team 😤🔥","Voilà ce qu'on veut voir. Bravo les boss 💪",
  "C'est masterclass. On est sur du très lourd 👑","Le classement c'est bien, le 100% c'est mieux. On continue 🚀",
  "Ce rythme, on le garde. On double la mise 😤","Vous envoyez de la frappe les gars. C'est exactement ça 🔥",
  "C'est carré. Maintenant on double la mise 💥","Des GOAT. Voilà ce que vous êtes 🐐🏆",
  "C'est zinzin ce classement. Continuez à envoyer 🙌","Top 3 de feu. Le reste du classement va devoir se réveiller 😅🔥",
  "Ça c'est un classement de boss finals 👑","C'est la maxence totale. Je vous aime les gars 🏆",
  "Direction l'asile tellement vous êtes bons 😅💥","Quelle team, on ne lâche rien 🔥😤",
  "J'ai le seum pour l'objectif tellement vous lui faites du mal 😤🔥",
];
function formaterTopSales(top, periode, mode) {
  const periodeLabel=periode==="daily"?"la journée":"la semaine";
  const modeLabel=mode==="valeur"?"MRR":"nombre de closes";
  const medals=["🥇","🥈","🥉"];
  if (top.length===0) return `📊 *Top Sales — ${periodeLabel}*\n\nAucun deal enregistré pour l'instant. Allez les gars, on ouvre le bal ! 🚀`;
  const lignes=top.map((s,i)=>mode==="valeur"
    ?`${medals[i]}  *${s.name}* — ${s.mrr.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€ MRR (${s.closes} close${s.closes>1?"s":""})`
    :`${medals[i]}  *${s.name}* — ${s.closes} close${s.closes>1?"s":""} (${s.mrr.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€ MRR)`
  ).join("\n");
  return `🏆  *TOP SALES — ${periodeLabel.toUpperCase()} (${modeLabel})*\n\n${lignes}\n\n${pick(MESSAGES_TOP_SALES_FIN)}`;
}

// ============================================================
// MESSAGES PLANIFIÉS
// ============================================================
// MESSAGES_PLANIFIES — headers sans jour ni heure, texte dynamique via fonction (pct, modeLabel)
const MESSAGES_PLANIFIES = {
  matin:{
    lundi:[
      {header:"LA SEMAINE COMMENCE MAINTENANT 🚀",texte:(p,ml)=>`Le weekend c'est fini, les closes c'est maintenant. ${p>0?`Déjà ${p}% de l'objectif ${ml} au compteur. `:""}Qui ouvre le score cette semaine ?`},
      {header:"QUI OUVRE LE BAL CETTE SEMAINE ? ☕",texte:(p,ml)=>`Nouveau lundi, nouvelles opportunités. ${pickCEO()} On a toute la semaine pour atteindre l'objectif ${ml}. Allez !`},
      {header:"ON A UNE SEMAINE À GAGNER 💪",texte:(p,ml)=>`La semaine commence. L'objectif ${ml} nous attend. ${p>0?`${p}% déjà fait, `:""}On continue de monter 🎯`},
      {header:"LE COMPTEUR TOURNE — QUI ENVOIE LA FRAPPE ? 🔥",texte:(p,ml)=>`Lundi matin et l'objectif ${ml} est là. ${pickPhilippe()} Premier close de la semaine, qui se lance ?`},
    ],
    mardi:[
      {header:"LA SEMAINE PREND FORME — ON ACCÉLÈRE 🔥",texte:(p,ml)=>`La semaine avance. ${p>0?`On est à ${p}% de l'objectif ${ml}. `:""}C'est maintenant qu'on envoie la frappe pour se mettre à l'aise.`},
      {header:"L'OBJECTIF NOUS REGARDE — ON LUI RÉPOND 👀",texte:(p,ml)=>`${p>0?`${p}% de fait sur l'objectif ${ml}. `:""}Chaque deal maintenant c'est de l'avance. Qui envoie la frappe ce matin ?`},
      {header:"ON EST LANCÉS — ON LÂCHE RIEN 💪",texte:(p,ml)=>`${pickCEO()} ${p>0?`${p}% au compteur sur l'objectif ${ml}. `:""}On continue de pousser et la semaine va être belle !`},
      {header:"L'OBJECTIF DE LA SEMAINE EST À PORTÉE 🎯",texte:(p,ml)=>`${p>=40?`${p}% de fait, on est en bonne posture sur l'objectif ${ml}. Gardez le rythme !`:`On est à ${p}% de l'objectif ${ml}. C'est maintenant qu'on met le turbo. Allez !`}`},
    ],
    mercredi:[
      {header:"PIVOT DE MI-SEMAINE — TOUT LE MONDE POUSSE ⚡",texte:(p,ml)=>`Milieu de semaine et on est à ${p}% de l'objectif ${ml}. ${p>=50?"On est dans les clous, on garde le rythme !":"L'aprèm doit être forte. Tout le monde pousse !"}`},
      {header:"LA SEMAINE SE JOUE MAINTENANT 🔥",texte:(p,ml)=>`${p>=50?`${p}% de fait à mi-semaine — c'est masterclass. ${pickCEO()}`:`On est à ${p}% à mi-semaine. ${pickPhilippePression()} C'est maintenant qu'on bascule !`}`},
      {header:"CE QUI SE PASSE AUJOURD'HUI DÉFINIT LA FIN DE SEMAINE 💥",texte:(p,ml)=>`Milieu de semaine, objectif ${ml} à ${p}%. ${p>=50?"Bien positionné. On continue à ce rythme et vendredi on célèbre.":"Il reste encore de la marge. Ce matin on accélère, l'aprèm on finit le boulot."}`},
      {header:"HUMP DAY — ON BASCULE OU ON RESTE ? 🏆",texte:(p,ml)=>`${pickCEO()} On est à ${p}% de l'objectif ${ml}. ${p>=45?"Belle semaine en cours, on continue 💪":"Le momentum doit s'accélérer maintenant. Allez les cracks !"}`},
    ],
    jeudi:[
      {header:"L'AFTERWORK AU 7 ÇA SE MÉRITE 🍺🔥",texte:(p,ml)=>`L'afterwork au 7 ce soir ça se mérite avec des closes. On est à ${p}% de l'objectif ${ml}. ${p>=65?"Quelques closes et c'est plié. Allez !":"On a encore tout le temps. Qui ouvre ce matin ?"}`},
      {header:"AVANT-DERNIER JOUR — ON ENVOIE TOUT 💥",texte:(p,ml)=>`${p>=65?`${p}% de fait sur l'objectif ${ml} — on est en avance. Finissons proprement !`:`${p}% sur l'objectif ${ml}. Il reste aujourd'hui et demain pour tout donner. ${pickPhilippePression()}`}`},
      {header:"LE 7 VOUS ATTEND SI VOUS CLOSEZ 🍺😤",texte:(p,ml)=>`${pickPhilippe()} On est à ${p}% de l'objectif ${ml}. L'afterwork au 7 ce soir, c'est pour ceux qui closent maintenant.`},
      {header:"DERNIER SPRINT DE LA SEMAINE — AUJOURD'HUI OU JAMAIS 🔥",texte:(p,ml)=>`On a aujourd'hui et demain. ${p}% de l'objectif ${ml} au compteur. ${p>=60?"L'objectif va tomber cette semaine. Finissons en beauté !":"On a besoin d'un gros push ces 2 jours. Tout le monde dessus !"}`},
    ],
    vendredi:[
      {header:"DERNIER JOUR — ON FINIT FORT 🔥",texte:(p,ml)=>`Dernière journée de la semaine. On est à ${p}% de l'objectif ${ml}. ${p>=75?"Quelques closes et c'est dans la boîte. Le Brelan est validé 🍺":"On a toute la journée pour tout donner. Allez !"}`},
      {header:"LE WEEKEND SE MÉRITE — ALORS ON CLOSE 💪",texte:(p,ml)=>`${p>=75?`${p}% de fait — quelle semaine ! Le Brelan ce soir c'est validé. Finissez proprement 🍺🎉`:`La semaine se finit aujourd'hui. ${p}% au compteur sur l'objectif ${ml}. On donne tout et on célèbre ce soir !`}`},
      {header:"FINISSONS CETTE SEMAINE EN BEAUTÉ 🏆",texte:(p,ml)=>`${pickCEO()} On est à ${p}% de l'objectif ${ml}. Aujourd'hui on finit ce qu'on a commencé. Le Brelan vous attend 🍺`},
      {header:"DERNIER BAL DE LA SEMAINE — QUI DANSE ? 💃🔥",texte:(p,ml)=>`Vendredi matin. ${p}% sur l'objectif ${ml}. ${p>=65?"On est sur une belle trajectoire. Finissons fort et on fête ça ce soir !":"L'objectif est encore atteignable. Closes en série dès maintenant, on y va !"}`},
    ],
  },
  finMatinee:{
    lundi:[
      {header:"LE COMPTEUR COMMENCE À CHAUFFER ? 👀",texte:(p,ml)=>`${p>0?`${p}% de l'objectif ${ml} déjà au compteur.`:"Le compteur attend ses premiers deals."} Qui a déjà envoyé de la frappe ce matin ?`},
      {header:"ON EST BIEN PARTIS ? 🎯",texte:(p,ml)=>`${p>=20?`${p}% au compteur — beau début ! Si on garde ce rythme, la semaine va être belle.`:`${p}% sur l'objectif ${ml}. L'aprèm doit être plus chargée. Allez les gars !`}`},
      {header:"LA MATINÉE TIRE À SA FIN ⚡",texte:(p,ml)=>`${pickCEO()} ${p}% de l'objectif ${ml} fait ce matin. L'aprèm commence bientôt — on va doubler la cadence !`},
    ],
    mardi:[
      {header:"ON Y EST — QUI CLOSE MAINTENANT ? 🔥",texte:(p,ml)=>`${p}% de l'objectif ${ml} au compteur. Le reste de la semaine se construit deal par deal. Allez les cracks !`},
      {header:"LA MATINÉE AVANCE VITE ⚡",texte:(p,ml)=>`${pickPhilippe()} ${p}% fait sur l'objectif ${ml}. L'aprèm c'est le moment de passer la 2ème vitesse !`},
      {header:"LE MOMENTUM EST LÀ — ON EN PROFITE 💪",texte:(p,ml)=>`${p}% sur l'objectif ${ml}. Si on continue à cette cadence, l'objectif va tomber bien avant vendredi !`},
    ],
    mercredi:[
      {header:"ON EST AU COEUR DE LA SEMAINE ⚡",texte:(p,ml)=>`Milieu de semaine, milieu de matinée. ${p}% de l'objectif ${ml}. C'est le bon moment pour envoyer la frappe les gars !`},
      {header:"LE PIVOT C'EST MAINTENANT 🔥",texte:(p,ml)=>`${p}% au compteur sur l'objectif ${ml}. ${p>=45?"On est dans les clous. L'aprèm pour finir fort !":"On accélère maintenant et demain on est en avance."}`},
      {header:"MI-SEMAINE — L'HEURE DE VÉRITÉ 📊",texte:(p,ml)=>`${pickCEO()} ${p}% de l'objectif ${ml} fait. ${p>=50?"Masterclass à mi-semaine. On continue !":`Il faut pousser maintenant pour finir la semaine en beauté.`}`},
    ],
    jeudi:[
      {header:"LE 7 CE SOIR C'EST POUR LES CLOSERS 🍺😤",texte:(p,ml)=>`${p}% de l'objectif ${ml}. L'afterwork au 7 se mérite deal par deal. Qui est en train de se l'offrir là ?`},
      {header:"AVANT-DERNIÈRE MATINÉE DE LA SEMAINE 💥",texte:(p,ml)=>`${pickPhilippe()} ${p}% sur l'objectif ${ml}. Il reste aujourd'hui et demain pour finir fort. On pousse maintenant !`},
      {header:"L'OBJECTIF EST À PORTÉE — ON L'ATTRAPE 🎯",texte:(p,ml)=>`${p}% fait sur l'objectif ${ml}. ${p>=60?"On est bien positionnés. L'aprèm pour finaliser !":"Chaque close maintenant est critique. Allez les gars !"}`},
    ],
    vendredi:[
      {header:"LE BRELAN S'APPROCHE 🍺🔥",texte:(p,ml)=>`${p}% de l'objectif ${ml}. Le Brelan ce soir c'est pour ceux qui closent maintenant. Qui est chaud ?`},
      {header:"DERNIÈRE MATINÉE DE LA SEMAINE 💪",texte:(p,ml)=>`${p}% au compteur sur l'objectif ${ml}. Ce matin on attaque, l'aprèm on finalise, ce soir on célèbre 🍺`},
      {header:"LA SEMAINE SE GAGNE CE MATIN 🔥",texte:(p,ml)=>`${p>=65?`${p}% — on est en bonne posture ! Quelques closes ce matin et le Brelan est validé 🍺`:`${p}% sur l'objectif ${ml}. On a le matin et l'aprèm pour tout donner. ALLEZ !`}`},
    ],
  },
  apresLunch:{
    lundi:[
      {header:"ON REPART DE PLUS BELLE 🚀",texte:(p,ml)=>`Le déj c'est fini. ${p}% de l'objectif ${ml} au compteur. L'aprèm commence — on met le turbo et on finit la journée fort !`},
      {header:"LE TURBO EST ENCLENCHÉ 💪",texte:(p,ml)=>`Retour au combat. ${p}% sur l'objectif ${ml}. L'aprèm du lundi c'est pour poser les bases de la semaine. Allez !`},
      {header:"L'APRÈM COMMENCE — QUI OUVRE ? 🎯",texte:(p,ml)=>`${pickPhilippe()} ${p}% de l'objectif ${ml}. L'aprèm commence, c'est maintenant qu'on envoie de la frappe !`},
    ],
    mardi:[
      {header:"CLOSES DU 🍑 EN SÉRIE — C'EST L'HEURE 💪",texte:(p,ml)=>`${p}% sur l'objectif ${ml}. L'aprèm de mardi c'est le meilleur moment pour closer. Qui balance le prochain deal ?`},
      {header:"C'EST MAINTENANT QU'ON ENVOIE 🔥",texte:(p,ml)=>`${pickCEO()} ${p}% de l'objectif ${ml} fait. L'aprèm commence — deals en série, on lâche rien !`},
      {header:"L'APRÈM DÉCIDE DE LA SEMAINE ⚡",texte:(p,ml)=>`${p}% au compteur sur l'objectif ${ml}. Cette aprèm peut tout changer. Tout le monde pousse maintenant !`},
    ],
    mercredi:[
      {header:"PIVOT TOTAL — C'EST MAINTENANT 🔥",texte:(p,ml)=>`Milieu de journée, milieu de semaine. ${p}% de l'objectif ${ml}. C'est LE moment charnière. Tout le monde pousse !`},
      {header:"L'APRÈM DE MI-SEMAINE EST DÉCISIVE 💥",texte:(p,ml)=>`${p}% sur l'objectif ${ml}. Cette aprèm définit jeudi et vendredi. On envoie la frappe maintenant !`},
      {header:"CE QUI SE PASSE LÀ DÉFINIT LA FIN DE SEMAINE 🎯",texte:(p,ml)=>`${pickPhilippe()} ${p}% de l'objectif ${ml}. L'aprèm est là pour inverser ou consolider. Allez les cracks !`},
    ],
    jeudi:[
      {header:"LE 7 SE MÉRITE MAINTENANT 🍺🔥",texte:(p,ml)=>`${p}% sur l'objectif ${ml}. L'afterwork au 7 se gagne deal par deal. C'est maintenant qu'on le mérite. Allez !`},
      {header:"AVANT-DERNIÈRE APRÈM DE LA SEMAINE 💥",texte:(p,ml)=>`${p}% de l'objectif ${ml}. Il reste cet aprèm et demain. ${p>=65?"On est bien positionnés. On finit proprement !":"On donne tout maintenant. Pas le temps d'attendre !"}`},
      {header:"L'URGENCE C'EST MAINTENANT 🚨",texte:(p,ml)=>`${pickPhilippePression()} ${p}% de l'objectif ${ml}. Cette aprèm est critique pour finir la semaine en beauté. ALLEZ !`},
    ],
    vendredi:[
      {header:"LE BRELAN VOUS ATTEND 🍺😤",texte:(p,ml)=>`${p}% de l'objectif ${ml}. Le Brelan ce soir c'est pour ceux qui closent maintenant. Qui est dans la course ?`},
      {header:"DERNIÈRE APRÈM DE LA SEMAINE 🔥",texte:(p,ml)=>`${p}% au compteur sur l'objectif ${ml}. Dernier aprèm. Tout ce qu'on close maintenant c'est de la semaine gagnée. ALLEZ !`},
      {header:"C'EST L'HEURE DU FINISH 🏁💥",texte:(p,ml)=>`${pickCEO()} ${p}% sur l'objectif ${ml}. Le Brelan ce soir = chaque close cet aprèm. Qui balance le prochain deal ? 🍺`},
    ],
  },
  soir:{
    lundi:[
      {header:"ON FAIT LE BILAN — ET ON REPART DEMAIN 📊",texte:(p,ml)=>`Fin de journée. ${p}% de l'objectif ${ml} au compteur. ${p>=20?"Belle journée de lundi ! Demain on continue sur cette lancée.":"La journée est terminée. Demain on remonte les manches et on repart plus fort !"}`},
      {header:"LA JOURNÉE EST DANS LA BOÎTE 🙌",texte:(p,ml)=>`${p}% sur l'objectif ${ml} après le premier jour. ${pickPhilippe()} Reposez-vous — demain on remet le couvert !`},
      {header:"ROUND 1 TERMINÉ — À DEMAIN POUR LE ROUND 2 💪",texte:(p,ml)=>`${p}% de l'objectif ${ml} au bout du premier jour. ${p>=20?"Bon départ !":"Pas le meilleur départ, mais demain c'est une nouvelle page."} À demain la team !`},
    ],
    mardi:[
      {header:"LA JOURNÉE EST TERMINÉE — À DEMAIN 💪",texte:(p,ml)=>`${p}% sur l'objectif ${ml}. ${p>=40?"Bonne progression. Demain on continue !":" Encore du chemin mais on a le temps. Demain on repart encore plus fort !"}`},
      {header:"ON FAIT LE POINT — ET ON REVIENT DEMAIN 📊",texte:(p,ml)=>`${p}% de l'objectif ${ml}. ${pickCEO()} Reposez-vous, demain la semaine se joue pour de vrai.`},
      {header:"JOURNÉE DANS LA BOÎTE — DEMAIN ON ACCÉLÈRE 🔥",texte:(p,ml)=>`${p}% sur l'objectif ${ml}. ${p>=35?"On est dans les clous.":"Il va falloir accélérer demain."} À demain les cracks !`},
    ],
    mercredi:[
      {header:"LE CAP EST PASSÉ — LA DESCENTE VERS LE WEEKEND 🏆",texte:(p,ml)=>`${p}% sur l'objectif ${ml}. La moitié de la semaine est derrière nous. Les deux derniers jours vont être décisifs !`},
      {header:"MI-SEMAINE BOUCLÉE 🎯",texte:(p,ml)=>`${p}% de l'objectif ${ml}. ${p>=50?"On est en bonne posture pour finir la semaine fort. Demain on accélère !":"Il reste jeudi et vendredi pour tout donner. Reposez-vous et revenez demain en mode berserker !"}`},
      {header:"ON A PASSÉ LE MIL DE MI-SEMAINE 💥",texte:(p,ml)=>`${pickPhilippe()} ${p}% sur l'objectif ${ml}. Demain jeudi, avant-dernier jour — c'est là que les vrais se révèlent. À demain !`},
    ],
    jeudi:[
      {header:"L'AFTERWORK AU 7 SE MÉRITE 🍺🔥",texte:(p,ml)=>`${p}% de l'objectif ${ml} au compteur. L'afterwork au 7 ce soir c'est pour ceux qui ont tout donné. Vous y étiez ?`},
      {header:"AVANT-DERNIER JOUR BOUCLÉ 💪",texte:(p,ml)=>`${p}% sur l'objectif ${ml}. Demain c'est le grand final. Reposez-vous et revenez vendredi en mode finish.`},
      {header:"DEMAIN C'EST LE GRAND FINAL 🏆",texte:(p,ml)=>`${p}% de l'objectif ${ml}. Demain vendredi = dernier jour. ${p>=65?"On est en bonne posture. Finissons en beauté !":"Il reste tout à donner demain. Dormez bien, demain on est là."}`},
    ],
    vendredi:[
      {header:"DERNIER PUSH AVANT LE BRELAN 🍺🔥",texte:(p,ml)=>`${p}% de l'objectif ${ml}. Tout ceux qui closent avant 18h30 je leur paye un verre au Brelan. C'est dit, c'est promis. Allez !`},
      {header:"LE BRELAN VOUS ATTEND 🍺💪",texte:(p,ml)=>`Plus qu'une heure. ${p}% sur l'objectif ${ml}. Chaque close avant 18h30 = un verre au Brelan offert. Qui est chaud ?`},
      {header:"L'HEURE DU FINISH — QUI CLOSE ? 🏁🔥",texte:(p,ml)=>`${pickPhilippe()} ${p}% de l'objectif ${ml}. Les derniers closes de la semaine appartiennent aux boss finals. Qui les prend ?`},
    ],
  },
  cloture:{
    lundi:[
      {header:"BONNE SOIRÉE — À DEMAIN 🙌",texte:(p,ml)=>`Fin de journée. ${p}% de l'objectif ${ml}. On rentre, on recharge, et demain on revient encore plus forts !`},
      {header:"LA JOURNÉE EST TERMINÉE — REPOS MÉRITÉ 💪",texte:(p,ml)=>`${p}% sur l'objectif ${ml} au bout du premier jour. ${pickCEO()} À demain la team !`},
    ],
    mardi:[
      {header:"À DEMAIN LA TEAM 💪",texte:(p,ml)=>`${p}% de l'objectif ${ml}. Encore deux jours et demi. On rentre et demain on remet le couvert encore plus fort !`},
      {header:"JOURNÉE TERMINÉE — REVENEZ EN FORME 🔋",texte:(p,ml)=>`${p}% sur l'objectif ${ml}. Demain mercredi, pivot de la semaine. Rechargez bien 🙌`},
    ],
    mercredi:[
      {header:"LA DESCENTE VERS LE WEEKEND COMMENCE 🔥",texte:(p,ml)=>`${p}% de l'objectif ${ml}. Le plus dur est derrière vous. Deux jours pour finir fort. À demain les cracks !`},
      {header:"MI-SEMAINE DERRIÈRE NOUS 🏆",texte:(p,ml)=>`${p}% sur l'objectif ${ml}. Demain jeudi et vendredi pour finir cette semaine en beauté. Bon repos !`},
    ],
    jeudi:[
      {header:"DEMAIN C'EST LE GRAND FINAL 🏆",texte:(p,ml)=>`${p}% de l'objectif ${ml}. Demain c'est vendredi. On arrive frais et on finit en beauté. Bonne soirée !`},
      {header:"AVANT-DERNIER JOUR DANS LA BOÎTE 💥",texte:(p,ml)=>`${p}% sur l'objectif ${ml}. Demain vendredi = dernier sprint. Rechargez les batteries. À demain 🏁`},
    ],
    vendredi:[
      {header:"BON WEEKEND — VOUS L'AVEZ MÉRITÉ 🎉🍺",texte:(p,ml)=>`La semaine est terminée. ${p}% sur l'objectif ${ml}. Profitez bien du weekend, vous avez bossé dur. À lundi !`},
      {header:"WEEKEND — RECHARGEZ LES BATTERIES 🔋🙌",texte:(p,ml)=>`${p}% de l'objectif ${ml} cette semaine. ${pickCEO()} Bon weekend la team — lundi on repart plus forts !`},
      {header:"LA SEMAINE EST DANS LA BOÎTE 🏆",texte:(p,ml)=>`${p}% sur l'objectif ${ml}. ${pickPhilippe()} Rechargez les batteries et revenez lundi en mode berserker. Bon weekend !`},
    ],
  },
};

const JOURS = ["dimanche","lundi","mardi","mercredi","jeudi","vendredi","samedi"];

function demarrerPlanificateur(client) {
  setInterval(async () => {
    const {h,m,jour}=getNowParis();
    if (jour===0||jour===6) return;

    // ── MILESTONE QUOTIDIEN 16H ──────────────────────────────
    if (h===16&&m===0) {
      mettreAJourPeriode();
      const pct = state.objectifDepart>0 ? Math.round((1-Math.max(0,state.objectif)/state.objectifDepart)*100) : 0;
      const milestone = getMilestoneForce(state.objectifDepart, state.objectif);
      if (!milestone) return;
      const bonus = getBonusMilestone();
      await client.chat.postMessage({
        channel:`#${CANAL_SORTIE}`, text:`${milestone.emoji} ${milestone.header}`,
        blocks:[
          {type:"section",text:{type:"mrkdwn",text:`🚨  *COMPTEUR MONEY LISA*  🚨`}},
          {type:"section",text:{type:"mrkdwn",text:`${milestone.emoji}  *${milestone.header}*  ${milestone.emoji}\n${milestone.texte}${bonus?`\n${bonus}`:""}`}},
          {type:"divider"},
          {type:"section",text:{type:"mrkdwn",text:barreProgression(state.objectifDepart,state.objectif)}},
          {type:"section",text:{type:"mrkdwn",text:`*${Math.max(0,state.objectif).toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€* restants sur *${state.objectifDepart.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€* _(${state.modeLabel})_`}},
        ],
      });
      return;
    }

    // ── MESSAGES PLANIFIÉS ───────────────────────────────────
    let moment=null;
    if (h===9&&m===0)  moment="matin";
    if (h===11&&m===30) moment="finMatinee";
    if (h===14&&m===0)  moment="apresLunch";
    if (h===17&&m===30) moment="soir";
    if (h===18&&m===30) moment="cloture";
    if (!moment) return;
    const jourNom = JOURS[jour];
    const msgs = MESSAGES_PLANIFIES[moment]?.[jourNom];
    if (!msgs||msgs.length===0) return;
    const msg = pick(msgs);
    const pct = Math.round((1-Math.max(0,state.objectif)/state.objectifDepart)*100);
    const texte = typeof msg.texte==="function" ? msg.texte(pct, state.modeLabel) : msg.texte;
    await client.chat.postMessage({
      channel:`#${CANAL_SORTIE}`, text:msg.header,
      blocks:[
        {type:"section",text:{type:"mrkdwn",text:`⏰  *${msg.header}*\n${texte}`}},
        {type:"divider"},
        {type:"section",text:{type:"mrkdwn",text:`🚨  *COMPTEUR MONEY LISA*  🚨`}},
        {type:"section",text:{type:"mrkdwn",text:barreProgression(state.objectifDepart,state.objectif)}},
        {type:"section",text:{type:"mrkdwn",text:`*${Math.max(0,state.objectif).toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€* restants sur *${state.objectifDepart.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€* _(${state.modeLabel})_`}},
      ],
    });
  }, 60*1000);
}

// ============================================================
// TRAITEMENT MESSAGE
// ============================================================
async function traiterMessage({ts,texte,userId,channel,estEdition}, client) {
  // ── GARDE-FOUS ANTI-DOUBLON ────────────────────────────────────
  // Slack peut livrer 2 fois le même event "message" en cas de :
  //   - reconnexion Socket Mode,
  //   - retry Bolt,
  //   - deploy Railway avec 2 instances momentanément vivantes.
  // Sans ces guards, le ts est poussé 2 fois dans le buffer et on
  // se retrouve avec un montant fantôme au flush. Les guards sont
  // redondants volontairement (défense en profondeur).
  if (!estEdition) {
    // 1) ts déjà flushé dans un compteur précédent → ignorer.
    if (state.tsDejaComptes.includes(ts)) return;
    // 2) ts déjà présent dans le buffer en attente → ignorer
    //    (évite le double-push sur delivery dupliquée).
    if (state.buffer.some(b=>b.ts===ts)) {
      console.log(`⚠️ Doublon évité (buffer) : ts ${ts} déjà bufferisé`);
      return;
    }
  }
  if (/^\s*<@[A-Z0-9]+>\s*(?:objectif|obj|add|ajoute|remove|supprime|switch|change|statut|stat|top|reset)/i.test(texte)) return;

  const mrr = extraireMRR(texte);

  if (estEdition) {
    const idx = state.buffer.findIndex(b=>b.ts===ts);

    // Message encore dans le buffer → met à jour le montant silencieusement
    if (idx!==-1) {
      if (!mrr) { state.buffer.splice(idx,1); sauvegarderState(state); return; }
      if (mrr===state.buffer[idx].montant) return;
      state.buffer[idx].montant = mrr;
      state.buffer[idx].leads   = extraireTousMRR(texte);
      sauvegarderState(state);
      console.log(`🔄 Buffer mis à jour : ${mrr}€`);
      return;
    }

    // Message déjà compté → recalcul immédiat et envoi du compteur
    if (state.tsDejaComptes.includes(ts) && mrr) {
      const ancien = state.montantsComptes[ts] || 0;
      const diff   = mrr - ancien;
      if (diff !== 0) {
        state.objectif -= diff;
        state.montantsComptes[ts] = mrr;
        for (const uid of Object.keys(state.salesStats)) {
          const c = state.salesStats[uid].closes.find(c=>c.ts===ts);
          if (c) { c.montant = mrr; break; }
        }
        sauvegarderState(state);
        // Édition : on n'affiche QUE le palier franchi s'il y en a un.
        // Pas de pression — l'édition n'est pas un flush de compteur.
        const milestone = verifierMilestone(state.objectifDepart, state.objectif);
        const calcul = `*${state.objectifDepart.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€*  →  *${Math.max(0,state.objectif).toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€*  /  ${state.objectifDepart.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€  _(${state.modeLabel})_`;
        const blocks = [];
        blocks.push({type:"section",text:{type:"mrkdwn",text:`🚨  *COMPTEUR MONEY LISA*  🚨`}});
        if (milestone) {
          const _bonus3 = getBonusMilestone();
          blocks.push({type:"section",text:{type:"mrkdwn",text:`${milestone.emoji}  *${milestone.header}*  ${milestone.emoji}\n${milestone.texte}${_bonus3?`\n${_bonus3}`:""}`}});
        }
        blocks.push({type:"divider"});
        blocks.push({type:"section",text:{type:"mrkdwn",text:`✏️  _${pick(MESSAGES_MODIF)}_`}});
        blocks.push({type:"section",text:{type:"mrkdwn",text:calcul}});
        blocks.push({type:"section",text:{type:"mrkdwn",text:barreProgression(state.objectifDepart,state.objectif)}});
        await client.chat.postMessage({channel,text:`✏️ Compteur ajusté`,blocks});
      }
      return;
    }
    // ⚠️ Édition d'un message qu'on n'a NI dans le buffer NI dans tsDejaComptes.
    // Cas typique : édition cosmétique d'un message dont le ts a été purgé
    // de tsDejaComptes (cap à 200), OU édition d'un message posté pendant
    // un downtime du bot. Dans les DEUX cas, on NE doit PAS l'ajouter comme
    // un nouveau close — ça créerait un doublon silencieux si le montant
    // original avait été capté autrement. On sort silencieusement.
    return;
  }

  if (!mrr) return;

  let userName="Commercial";
  try {const u=await client.users.info({user:userId});userName=u.user.real_name||u.user.name;} catch(e){}

  const now=new Date(),dateStr=now.toISOString().split("T")[0],weekStr=getWeekKey(now);
  if (!state.salesStats[userId]) state.salesStats[userId]={name:userName,closes:[]};
  state.salesStats[userId].name=userName;
  if (!state.salesStats[userId].closes.some(c=>c.ts===ts))
    state.salesStats[userId].closes.push({ts,montant:mrr,date:dateStr,week:weekStr});

  // ── Flush anticipé des deals stale (>4h) ──────────────────────────
  // Avant d'ajouter le nouveau close, on regarde si le buffer contient
  // des deals de plus de 4h (typiquement des closes d'hier qui n'ont
  // jamais atteint le seuil de 3). Si oui, on les extrait et on les
  // flushe MAINTENANT comme leur propre compteur visible (1 ou 2 deals),
  // pour que le nouveau close n'atterrisse pas dans un buffer "sale"
  // et ne crée pas l'illusion d'un montant fantôme. Les deals fresh
  // (<4h) restent dans le buffer en attente.
  const SEUIL_STALE_BUFFER_MS = 4 * 60 * 60 * 1000;
  const nowMsCheck = Date.now();
  const staleDeals = [];
  const freshDeals = [];
  for (const d of state.buffer) {
    const dealMs = parseFloat(d.ts) * 1000;
    if (isFinite(dealMs) && (nowMsCheck - dealMs) >= SEUIL_STALE_BUFFER_MS) {
      staleDeals.push(d);
    } else {
      freshDeals.push(d);
    }
  }
  if (staleDeals.length > 0) {
    state.buffer = freshDeals;
    const totalStale = staleDeals.reduce((s,d)=>s+d.montant, 0);
    const ancienObj  = state.objectif;
    state.objectif  -= totalStale;
    staleDeals.forEach(d => {
      if (!state.tsDejaComptes.includes(d.ts)) state.tsDejaComptes.push(d.ts);
      state.montantsComptes[d.ts] = d.montant;
    });
    if (state.tsDejaComptes.length > 200) state.tsDejaComptes = state.tsDejaComptes.slice(-200);
    state.nbCompteurs = (state.nbCompteurs || 0) + 1;
    state.lastChannel = channel;
    sauvegarderState(state);
    console.log(`🧹 Flush anticipé : ${staleDeals.length} deal(s) stale > 4h (−${totalStale}€)`);
    // Milestone respecte la règle "tous les 5 compteurs" + paliers.
    const milestoneStale = (state.nbCompteurs % 5 === 0)
      ? getMilestoneForce(state.objectifDepart, state.objectif)
      : verifierMilestone(state.objectifDepart, state.objectif);
    const blocksStale = construireMessage(staleDeals, ancienObj, state.objectif, state.objectifDepart, milestoneStale);
    await client.chat.postMessage({ channel, text: "🚨 COMPTEUR", blocks: blocksStale });
  }

  // 3e garde-fou (défense en profondeur) : entre le début de la fonction
  // et ici, on a fait des `await` (client.users.info) — un autre handler
  // concurrent peut avoir pushé le même ts. On revérifie juste avant le push.
  if (state.buffer.some(b=>b.ts===ts) || state.tsDejaComptes.includes(ts)) {
    console.log(`⚠️ Doublon évité (race condition post-await) : ts ${ts}`);
    return;
  }

  state.buffer.push({user:userName,userId,montant:mrr,leads:extraireTousMRR(texte),ts});
  sauvegarderState(state);
  console.log(`📥 Buffer : ${state.buffer.length}/3 — ${userName} : ${mrr}€`);

  // ✅ Réaction tick vert sur le message comptabilisé
  try {
    await client.reactions.add({ channel, timestamp: ts, name: "white_check_mark" });
  } catch(e) { console.log("Réaction impossible :", e.message); }

  if (state.buffer.length>=3) {
    const deals=state.buffer.splice(0,3);
    const ancienObjectif=state.objectif;
    const totalMRR=deals.reduce((s,d)=>s+d.montant,0);
    state.objectif=ancienObjectif-totalMRR;
    state.buffer=[];
    deals.forEach(d=>{state.tsDejaComptes.push(d.ts);state.montantsComptes[d.ts]=d.montant;});
    if (state.tsDejaComptes.length>200) state.tsDejaComptes=state.tsDejaComptes.slice(-200);
    state.nbCompteurs = (state.nbCompteurs || 0) + 1;
    // On mémorise le dernier channel où un close a été posté, pour que le
    // booster planifié 16h sache où aller.
    state.lastChannel = channel;
    sauvegarderState(state);
    // Milestone forcé uniquement tous les 5 compteurs (au lieu de 3)
    // pour éviter la saturation de messages.
    const milestone = (state.nbCompteurs % 5 === 0)
      ? getMilestoneForce(state.objectifDepart, state.objectif)
      : verifierMilestone(state.objectifDepart, state.objectif);
    const blocks=construireMessage(deals,ancienObjectif,state.objectif,state.objectifDepart,milestone);
    await client.chat.postMessage({channel,text:`🚨 COMPTEUR`,blocks});
  }
}

// ============================================================
// SUPPRESSIONS
// ============================================================
async function traiterSuppression({ts,channel}, client) {
  const idx=state.buffer.findIndex(b=>b.ts===ts);
  if (idx!==-1) {
    for (const uid of Object.keys(state.salesStats))
      state.salesStats[uid].closes=state.salesStats[uid].closes.filter(c=>c.ts!==ts);
    state.buffer.splice(idx,1);
    sauvegarderState(state);
    return;
  }
  if (state.tsDejaComptes.includes(ts)) {
    const montant=state.montantsComptes[ts]||0;
    if (!montant) return;
    state.objectif+=montant;
    delete state.montantsComptes[ts];
    state.tsDejaComptes=state.tsDejaComptes.filter(t=>t!==ts);
    for (const uid of Object.keys(state.salesStats))
      state.salesStats[uid].closes=state.salesStats[uid].closes.filter(c=>c.ts!==ts);
    sauvegarderState(state);
    const msg=pick(MESSAGES_SUPPRESSION);
    const blocks=construireMessageModif(state.objectif,state.objectifDepart,`${msg.header} — ${msg.texte}`,true);
    await client.chat.postMessage({channel,text:`🗑️ Compteur ajusté`,blocks});
  }
}

// ============================================================
// COMMANDES @Money Lisa
// ============================================================
app.event("app_mention", async ({event,say}) => {
  mettreAJourPeriode();
  const texte=event.text, tl=texte.toLowerCase();
  console.log("🔔 Mention :",texte);

  // ── TOP SALES ────────────────────────────────────────────────
  if (/top\s*sal[e|s]?|top\s*vent|meilleur|classement|ranking|podium|leaderboard|scoreboard/i.test(tl)) {
    await say(formaterTopSales(calculerTopSales(detecterPeriodeTopSales(tl),detecterModeTopSales(tl)),detecterPeriodeTopSales(tl),detecterModeTopSales(tl)));
    return;
  }

  // ── SWITCH PÉRIODE ──────────────────────────────────────────
  if (/\b(?:switch|swicth|swich|swithc|switcher|change|changer|chagne|chnage|modif(?:ie[rz]?)?|modifier|passer?|basculer?|mettre?\s*(?:sur|en|à)|mode|période|periode|period)\b/i.test(tl)) {
    state.modeLabel=detecterPeriode(texte);
    sauvegarderState(state);
    await say(`🔄 Période changée : *${state.modeLabel}*\nL'objectif reste à *${state.objectif.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€* et le buffer est conservé (${state.buffer.length}/3).`);
    return;
  }

  // ── AVANCÉE X SUR Y — fixe objectif Y avec X déjà fait ──────
  // "avancée 400 sur 20000" / "progression de 400 sur 20k" / "déjà 400 sur 20000"
  const RE_AVANCEE_KWORD = /\b(?:avanc[eé][ée]?s?|avancee|avancem[e]?nt|avanc[e]|progress(?:ion)?|progres|progr[eè]s|d[eé]j[àa](?:\s*fait)?|fait[e]?s?|on\s*(?:a|est\s*[àa])|j['']?ai\s*fait)\b/i;
  const mAvanceeSur = tl.match(new RegExp(RE_AVANCEE_KWORD.source + /\s*(?:de\s+)?(\d[\d\s,\.]*k?)\s*(?:sur|\/|de|sur\s*un\s*(?:objectif|obj|total)\s*(?:de)?)\s*(\d[\d\s,\.]*k?)/.source, "i"));
  if (mAvanceeSur) {
    const avance = extraireObjectif(mAvanceeSur[1].trim());
    const total  = extraireObjectif(mAvanceeSur[2].trim());
    if (!avance||!total||isNaN(avance)||isNaN(total)) { await say(`❌ Format non reconnu. Ex : \`@Money Lisa avancée 400 sur 20000\``); return; }
    const reste = total - avance;
    state.objectifDepart = total; state.objectif = reste; state.milestonesVus = [];
    const pctDeja = Math.round((avance/total)*100);
    for (const t of [25,50,75,100]) { if (pctDeja>=t && !state.milestonesVus.includes(t)) state.milestonesVus.push(t); }
    sauvegarderState(state);
    await say(`🎯 Objectif *${total.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€* — avancée de *${avance.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€* conservée → il reste *${reste.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€* _(${state.modeLabel})_`);
    return;
  }

  // ── AVANCÉE X seul — applique X sur l'objectif courant ───────
  // "avancée 400" / "avancement 400" / "j'ai fait 400" / "on est à 400" / "on a fait 400"
  const mAvanceeSeul = tl.match(new RegExp(RE_AVANCEE_KWORD.source + /\s*(?:de\s+|[àa]\s+)?(\d[\d\s,\.]*k?)/.source, "i"));
  if (mAvanceeSeul && !tl.match(/(?:sur|\/)\s*\d/)) {
    const avance = extraireObjectif(mAvanceeSeul[1].trim());
    if (!avance||isNaN(avance)||!state.objectifDepart) { await say(`❌ Montant non reconnu ou pas d'objectif fixé.`); return; }
    const total = state.objectifDepart;
    const reste = total - avance;
    state.objectif = reste; state.milestonesVus = [];
    const pctDeja = Math.round((avance/total)*100);
    for (const t of [25,50,75,100]) { if (pctDeja>=t && !state.milestonesVus.includes(t)) state.milestonesVus.push(t); }
    sauvegarderState(state);
    await say(`📍 Avancée de *${avance.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€* enregistrée sur l'objectif *${total.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€* → il reste *${Math.max(0,reste).toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€* _(${state.modeLabel})_`);
    return;
  }

  // ── OBJECTIF ────────────────────────────────────────────────
  const RE_OBJ = /\b(?:objectif[s]?|obj[e]?[c]?[t]?[i]?[f]?[s]?|objctif|obejctif|objetcif|ojbectif|objecti|obectif|objcetif|objectifr|goal|cible|target|vise[er]?|visee)\b/i;
  const mObj = texte.match(new RegExp(RE_OBJ.source + /\s*(.*)/.source, "i"));
  if (mObj) {
    const reste=mObj[1].trim();
    // "obj X sur Y" → avancée X, total Y
    const mSur = reste.match(/(?:de\s+)?(\d[\d\s,\.]*k?)\s*(?:sur|\/)\s*(\d[\d\s,\.]*k?)/i);
    if (mSur) {
      const avance = extraireObjectif(mSur[1].trim());
      const total  = extraireObjectif(mSur[2].trim());
      if (avance && total && !isNaN(avance) && !isNaN(total) && total > avance) {
        const restant = total - avance;
        const periode = detecterPeriode(reste);
        state.objectifDepart=total; state.objectif=restant; state.modeLabel=periode;
        state.buffer=[]; state.milestonesVus=[]; state.tsDejaComptes=[]; state.montantsComptes={}; state.nbCompteurs=0;
        state.objectifNbJours=null; state.objectifDateDebut=null;
        const pctDeja = Math.round((avance/total)*100);
        for (const t of [25,50,75,100]) { if (pctDeja>=t && !state.milestonesVus.includes(t)) state.milestonesVus.push(t); }
        sauvegarderState(state);
        await say(`🎯 Objectif *${total.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€* _(${periode})_ — avancée de *${avance.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€* prise en compte → il reste *${restant.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€*`);
        return;
      }
    }
    const nouvel=extraireObjectif(reste);
    if (!nouvel||isNaN(nouvel)){await say(`❌ Montant non reconnu. Ex : \`@Money Lisa objectif 9k pour la semaine\``);return;}
    const periode=detecterPeriode(reste);
    const matchJours = periode.match(/^les (\d+) prochains jours$/);
    const matchMois  = periode === "le mois";
    state.objectifDepart=nouvel; state.objectif=nouvel; state.modeLabel=periode;
    state.buffer=[]; state.milestonesVus=[]; state.tsDejaComptes=[]; state.montantsComptes={}; state.nbCompteurs=0;
    if (matchJours) {
      state.objectifNbJours=parseInt(matchJours[1]); state.objectifDateDebut=getDateStr();
    } else if (matchMois) {
      const now=new Date();
      state.objectifNbJours=new Date(now.getFullYear(),now.getMonth()+1,0).getDate()-now.getDate()+1;
      state.objectifDateDebut=getDateStr();
    } else { state.objectifNbJours=null; state.objectifDateDebut=null; }
    sauvegarderState(state);
    const explication = matchJours?` _(jour 1/${state.objectifNbJours}, se met à jour automatiquement)_`:matchMois?` _(${state.objectifNbJours} jours restants ce mois)_`:"";
    await say(`🎯 L'objectif pour *${periode}* est fixé à *${nouvel.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€*${explication}`);
    return;
  }

  // ── ADD ──────────────────────────────────────────────────────
  const mAdd=tl.match(/\b(?:add|ajout(?:e[rz]?)?|rajout(?:e[rz]?)?|ajoute|rajoute|augment(?:e[rz]?)?|monte[rz]?|hausse|boost(?:e[rz]?)?|incr[eé]ment(?:e[rz]?)?|mets?|mettre|mis)\b\s*[àaáâäde@\s]?\s*([\d,.\s]+k?)/i);
  if (mAdd) {
    const ajout=extraireObjectif(mAdd[1].trim());
    if (!ajout||isNaN(ajout)){await say(`❌ Montant non reconnu.`);return;}
    const ancien=state.objectifDepart;
    state.objectifDepart+=ajout; state.objectif+=ajout;
    sauvegarderState(state);
    await say(`➕ *${ajout.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€* ajoutés — nouvel objectif : *${state.objectifDepart.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€* _(était ${ancien.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€)_`);
    return;
  }

  // ── REMOVE ───────────────────────────────────────────────────
  const mRem=tl.match(/\b(?:remove|rmv|supprim(?:e[rz]?)?|retir(?:e[rz]?)?|effa(?:ce[rz]?)?|annul(?:e[rz]?)?|vir(?:e[rz]?)?|d[eé]duis?|deduis?|soustrai[tsr]?|soustraire|enlev(?:e[rz]?)?|enlève|baiss(?:e[rz]?)?|diminu(?:e[rz]?)?|[eé]crase[rz]?)\b\s*[àaáâäde@\s]?\s*([\d,.\s]+k?)/i);
  if (mRem) {
    const montant=extraireObjectif(mRem[1].trim());
    if (!montant||isNaN(montant)){await say(`❌ Montant non reconnu.`);return;}
    const ancien=state.objectif;
    state.objectif+=montant;
    sauvegarderState(state);
    await say(`↩️ *${montant.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€* retirés — objectif ajusté : *${state.objectif.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€* _(était ${ancien.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€)_`);
    return;
  }

  // ── STATUT ───────────────────────────────────────────────────
  if (/\b(?:statut|status|stat[s]?|reste|restant|bilan|avancement|avancem[e]?nt|ou\s*(?:en\s*)?est|où\s*(?:en\s*)?est|où\s*on\s*en|combien|progress|résumé|resume|compteur|recap|récap|show|voir|vois|update|upd8)\b/i.test(tl)) {
    await envoyerStatut(event.channel, app.client);
    return;
  }

  // ── RESET ────────────────────────────────────────────────────
  if (/\b(?:reset|reinit(?:ialise[rz]?)?|vider?|raz|repart(?:ir)?|vide[rz]?|nettoie[rz]?|nettoy(?:er)?|clear)\b/i.test(tl)) {
    state.buffer=[]; sauvegarderState(state);
    await say(`🔄 Buffer remis à zéro (0/3).`);
    return;
  }

  await say(
    `👋 *Commandes Money Lisa :*\n`+
    `• \`@Money Lisa objectif 9k pour la semaine\`\n`+
    `• \`@Money Lisa objectif aujourd'hui à 9k\`\n`+
    `• \`@Money Lisa switch semaine\` → changer la période\n`+
    `• \`@Money Lisa add 2000\`\n`+
    `• \`@Money Lisa remove 500\`\n`+
    `• \`@Money Lisa top sales daily\`\n`+
    `• \`@Money Lisa top sales valeur weekly\`\n`+
    `• \`@Money Lisa statut\`\n`+
    `• \`@Money Lisa reset buffer\``
  );
});

// ============================================================
// NOUVEAUX MESSAGES
// ============================================================
app.message(async ({message,client}) => {
  if (message.subtype||message.bot_id) return;
  if (message.thread_ts&&message.thread_ts!==message.ts) return;
  await traiterMessage({ts:message.ts,texte:message.text||"",userId:message.user,channel:message.channel,estEdition:false},client);
});

// ============================================================
// PLANIFICATEUR BOOSTER 🍑 — 16h les lun/mer/ven
// ------------------------------------------------------------
// Seul message automatique actif. Fire une fois par jour autorisé,
// à 16h00 Paris. On envoie dans le dernier channel où un close a
// été posté (state.lastChannel) pour coller au canal actif.
// ============================================================
function demarrerBoosterCadence16h(client) {
  setInterval(async () => {
    try {
      const { h, m, jour } = getNowParis();
      // Lun/Mer/Ven uniquement (1 jour ouvré sur 2)
      if (jour !== 1 && jour !== 3 && jour !== 5) return;
      if (h !== 16 || m !== 0) return;

      // Garde anti-doublon : on ne fire qu'une fois par jour civil Paris.
      const todayKey = new Intl.DateTimeFormat("fr-CA", {
        timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit"
      }).format(new Date());
      if (state.lastBoosterDate === todayKey) return;

      // Pas de channel mémorisé → on ne sait pas où poster, on skip.
      if (!state.lastChannel) {
        console.log("🍑 Booster 16h : pas de lastChannel, skip");
        state.lastBoosterDate = todayKey;
        sauvegarderState(state);
        return;
      }

      const msg = pick(MESSAGES_CADENCE_LENTE);
      await client.chat.postMessage({
        channel: state.lastChannel,
        text: `🍑 ${msg.header}`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `🍑  *${msg.header}*\n${msg.texte}` } },
          { type: "divider" },
          { type: "section", text: { type: "mrkdwn", text: `*${Math.max(0, state.objectif).toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€* restants sur *${state.objectifDepart.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€*  _(${state.modeLabel})_` } },
          { type: "section", text: { type: "mrkdwn", text: barreProgression(state.objectifDepart, state.objectif) } },
        ],
      });

      state.lastBoosterDate = todayKey;
      sauvegarderState(state);
      console.log(`🍑 Booster 16h envoyé (${todayKey})`);
    } catch (e) {
      console.log("Booster 16h erreur :", e.message);
    }
  }, 60 * 1000);
}

// ============================================================
// ÉDITÉS ET SUPPRIMÉS
// ============================================================
app.event("message", async ({event,client}) => {
  if (event.subtype==="message_deleted") {
    await traiterSuppression({ts:event.deleted_ts,channel:event.channel},client);
    return;
  }
  if (event.subtype==="message_changed") {
    if (!event.message||event.message.bot_id) return;
    if (event.message.thread_ts&&event.message.thread_ts!==event.message.ts) return;
    await traiterMessage({ts:event.message.ts,texte:event.message.text||"",userId:event.message.user,channel:event.channel,estEdition:true},client);
  }
});

// ============================================================
// DÉMARRAGE
// ============================================================
(async () => {
  const demarrer = async () => {
    try {
      await app.start();
      console.log("🚨 Money Lisa est en ligne !");
      console.log(`📊 Objectif  : ${state.objectif}€ / ${state.objectifDepart}€`);
      console.log(`📅 Période   : ${state.modeLabel}`);
      console.log(`📥 Buffer    : ${state.buffer.length}/3`);
      // ── Planificateur COMPLÈTEMENT DÉSACTIVÉ ───────────────────
      // AUCUN message pré-enregistré n'est envoyé. Le bot ne réagit
      // qu'aux closes postées par les commerciaux (flush tous les
      // 3 deals). Les milestones ne s'affichent QUE quand ils sont
      // attachés à un compteur (tous les 5 flushes ou palier franchi).
      //   - demarrerPlanificateur (ancien) : OFF
      //   - demarrerBoosterCadence16h (16h lun/mer/ven) : OFF
      // Pour réactiver : décommenter la ligne voulue.
      // demarrerBoosterCadence16h(app.client);
      console.log("🕒 Planificateur : TOTALEMENT DÉSACTIVÉ (zéro message auto)");
    } catch(e) {
      console.error("❌ Erreur, nouvelle tentative dans 5s...", e.message);
      setTimeout(demarrer, 5000);
    }
  };
  await demarrer();
})();