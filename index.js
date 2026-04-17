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
    objectifDateDebut: null, objectifNbJours: null,
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
  "Quitterie va kiffer le compte rendu de cette journée, vous êtes des monstres 😤",
];
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
  {header:"L'HEURE DU 🍑 A SONNÉ — ON ENVOIE 🔥",texte:"14h-15h c'est le moment parfait pour closer des 🍑. Vous êtes des monstres, montrez-le à l'objectif !"},
  {header:"CLOSE DU 🍑 TIME — TOUT LE MONDE EN MODE BEAST 🍑💥",texte:"On est en pleine après-midi et les closes du 🍑 vont faire la différence. Qui est le premier à en closer un ?"},
  {header:"LES CLOSES DU 🍑 C'EST MAINTENANT — GO GO GO 🚀",texte:"Philippe et les CEO regardent les chiffres. C'est l'heure de leur montrer ce que vous valez !"},
  {header:"MILIEU D'APRÈM — QUI CLOSE LE PROCHAIN 🍑 ? 👀🔥",texte:"On est dans le créneau parfait pour les closes du 🍑. L'objectif attend, l'équipe est là. Allez les tigres 🐯"},
];
const MESSAGES_CLOSE_Q = MESSAGES_BOOST_Q;
function detecterCloseQ(texte) { return /close\s+du\s+[qQ🍑]/i.test(texte)||/[qQ🍑]\s+clos[eé]/i.test(texte); }

const PRESSION = {
  retard: [
    {header:"OÙ EST-CE QU'ON EN EST LÀ 👀🔥",texte:()=>`On est à 75% de la journée et l'objectif est pas encore à moitié. ${pick(MESSAGES_PHILIPPE_PRESSION)} Allez les gars !`},
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
    {header:"30 MIN — C'EST MAINTENANT QU'ON ENVOIE LA FRAPPE 🔥",texte:()=>`Dernières 30 minutes. ${pick(MESSAGES_PHILIPPE_PRESSION)} Allez les tigres 🐯`},
  ],
};

function getMessagePression(pctJourneeEcoule, pctObjectifFait) {
  const {h,m,jour}=getNowParis();
  const nowMin=h*60+m, finMin=18*60+30, restant=Math.max(0,finMin-nowMin);
  if (pctObjectifFait>=100) return null;

  if (jour===5&&h===17&&m>=30) return pick([
    {header:"C'EST VENDREDI ET L'OBJECTIF NOUS REGARDE 🍺🔥",texte:"Tout ceux qui closent avant 18h30 je leur paye un verre au Brelan ce soir. C'est dit, c'est promis. Allez les gars !"},
    {header:"LE BRELAN VOUS ATTEND LES GARS 🍺🏆",texte:"Vendredi 17h30. Deal : vous closez, je paye la tournée au Brelan. C'est maintenant que les boss finals se révèlent 👑"},
    {header:"DERNIER PUSH DU VENDREDI — BRELAN OFFERT 🍺🔥",texte:"Chaque close avant 18h30 = un verre au Brelan. Qui est chaud ? 🙋"},
  ]);
  if (jour===5&&h>=14) return pick([
    {header:"C'EST VENDREDI — LE WEEKEND SE MÉRITE 💪🔥",texte:"Vendredi aprèm et l'objectif est pas encore là. Les cracks closent maintenant. Vous êtes dans quelle catégorie ?"},
    {header:"LE WEEKEND C'EST POUR LES GENS QUI ONT TOUT DONNÉ 🏆",texte:"Vendredi aprèm. Ceux qui closent avant 18h30 méritent leur weekend. Allez on finit fort !"},
  ]);
  if (jour===1&&h<11&&pctObjectifFait<5) return pick([
    {header:"C'EST LUNDI — QUELQU'UN VA OUVRIR LE BAL ? 😴☕",texte:"La semaine commence. Le compteur attend. Qui est le premier à envoyer de la frappe cette semaine ?"},
    {header:"RÉVEIL LUNDI — ON A UNE SEMAINE À GAGNER 🚀",texte:`Lundi matin. ${pick(MESSAGES_CEO)} Qui dégaine en premier ?`},
  ]);
  if (h<11&&pctObjectifFait<10) return pick([
    {header:"☕ ON DÉMARRE DOUCEMENT LÀ LES GARS",texte:"Le café c'est bon mais les deals c'est mieux. Qui est chaud pour ouvrir le score ce matin ?"},
    {header:"BONJOUR LES MONSTRES — L'OBJECTIF VOUS ATTEND ☕🔥",texte:`Bonne journée les gars. ${pick(MESSAGES_CEO)} Qui balance le premier deal ?`},
  ]);
  if (h===11&&pctObjectifFait<25) return pick([
    {header:"11H ET ON A ENCORE TOUT À FAIRE 👀🔥",texte:"On est à 11h et le compteur est pas encore chaud. C'est maintenant qu'on envoie de la frappe !"},
    {header:"MILIEU DE MATINÉE — LE COMPTEUR VEUT DU CONCRET 😤",texte:`11h du mat. ${pick(MESSAGES_PHILIPPE_PRESSION)} Allez les gars !`},
  ]);
  if (h>=14&&h<15&&pctObjectifFait<70) return pick(MESSAGES_BOOST_Q);
  if (h===14&&pctObjectifFait<30) return pick([
    {header:"14H ET ON EST DANS LE ROUGE — RÉVEIL GÉNÉRAL 🚨",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} Vous êtes des machines, montrez-le.`},
    {header:"ALERTE ROUGE — L'OBJECTIF EST EN DANGER 🚨😤",texte:"14h et moins de 30% de fait. On a besoin de tout le monde maintenant. ALLEZ !"},
  ]);
  if (h===14&&pctObjectifFait<40) return pick([
    {header:"LE DÉJEUNER C'EST FINI — RETOUR AU COMBAT 🍽️😤",texte:"Le déj c'est bon mais l'objectif attend personne. On digère en closant des deals. Allez !"},
    {header:"14H — ON REPART DE PLUS BELLE 🚀",texte:"Pause déj terminée. C'est l'après-midi qui va faire la différence. Tout le monde pousse !"},
  ]);
  if (h===15&&pctObjectifFait>=45&&pctObjectifFait<=55) return pick([
    {header:"15H — PILE À LA MOITIÉ MAIS Y'A MOINS DE 4H 😤⚡",texte:"On est à 50% mais il reste moins de 4h. Le rythme doit doubler maintenant !"},
    {header:"MOITIÉ FAITE À 15H — LE TURBO C'EST MAINTENANT 🔥",texte:`50% à 15h c'est bien mais c'est pas assez. ${pick(MESSAGES_CEO)} Tout le monde pousse !`},
  ]);
  if (h>=17&&pctObjectifFait>=80&&pctObjectifFait<90) return pick([
    {header:"ON SENT QUE ÇA VA TOMBER 🔥👀",texte:`80% à 17h c'est masterclass. ${pick(MESSAGES_PHILIPPE)} Qui finit le boulot ?`},
    {header:"LA VICTOIRE EST LÀ — ALLEZ LA CHERCHER 💥🏆",texte:`Plus que 20% et la journée est gagnée. ${pick(MESSAGES_CEO)} Finissez en beauté !`},
  ]);
  if (h===17&&m>=30&&pctObjectifFait>=90) return pick([
    {header:"ON EST À 2 DOIGTS DU BUT 🏁🔥",texte:`17h30 et 90% de fait. ${pick(MESSAGES_PHILIPPE)} Qui close le dernier deal ?`},
    {header:"DERNIER DEAL DE LA JOURNÉE — QUI LE PREND ? 🏁👑",texte:"On est à 2 doigts de l'objectif. Le dernier close de la journée appartient à qui ?"},
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
  "25":{emoji:"🔥",header:["PREMIER SANG — 25% DANS LA POCHE 🔥","ON EST LANCÉS — VOUS ENVOYEZ DE LA FRAPPE","25% — VOUS ÊTES DES MONSTRES LES GARS 💪","LE WARM-UP EST TERMINÉ, C'EST PARTI 🚀","PREMIER QUART — ON EST EN PLEIN DEDANS","25% — C'EST CARRÉ, ON CONTINUE","VOUS BALANCEZ DE LA FRAPPE PAR ICI 👀","ON EST SOUS TENSION — 25% BOUCLÉS ⚡"],texte:["Un quart de fait et vous envoyez déjà de la frappe. Gardez cette énergie, on lâche rien.",`25% c'est bien. 100% c'est mieux. ${pick(MESSAGES_CEO)} Vous savez ce qu'il reste à faire, les monstres.`,"Le moteur est chaud et ça se voit. Continuez à envoyer comme ça, on veut voir la suite.","Belle mise en route les gars. J'ai hâte de voir la suite, ça va être une dinguerie.","Quart bouclé. Trois autres à aller chercher. On est ensemble, allez les cracks 🦁","C'est carré pour le premier quart. Vous êtes sur du très lourd.","On sent la dynamique, c'est zinzin. C'est exactement ça qu'on veut voir.","Premier quart dans la poche. Le reste va tomber encore plus vite, vous êtes des machines."]},
  "50":{emoji:"⚡",header:["MI-CHEMIN — VOUS ÊTES DES MONSTRES ICI 😤","50% ET ÇA FAIT DÉJÀ MAL — VOUS ENVOYEZ DE LA FRAPPE","HALFWAY DONE — VOUS ÊTES DES GOAT 🐐","LA MOITIÉ DANS LA POCHE — C'EST MASTERCLASS","50% — ON EST SOUS TENSION LES GARS ⚡","L'OBJECTIF COMMENCE À FLIPPER 👀","MOITIÉ FAITE — VOUS BALANCEZ DE LA FRAPPE 🔥","50% — C'EST ZINZIN CE QUE VOUS FAITES LÀ"],texte:["La moitié c'est fait. L'autre moitié va tomber encore plus vite, je vous connais les cracks.",`50% bouclé et c'est masterclass. ${pick(MESSAGES_PHILIPPE)} Vous ne ralentissez surtout pas.`,"Mi-chemin franchi. Vous êtes sur du très lourd. Le finish est dans le viseur.","Vous avez la dynamique, gardez-la. Vous êtes des machines, tout le monde pousse.",`Moitié faite. ${pick(MESSAGES_CEO)} Je veux voir la même énergie jusqu'au bout.`,"50% — c'est carré. C'est exactement là où vous deviez être. Direction la lune 🚀","Le momentum est là, c'est zinzin. C'est maintenant qu'on double la cadence.","Halfway — et on sent que le reste va tomber vite. Vous êtes des GOAT ou pas ? 🐐"]},
  "75":{emoji:"💥",header:["TROIS QUARTS BOUCLÉS — LE FINISH EST LÀ 💥","75% — VOUS ÊTES DES TIGRES ICI 🐯","ON SENT LA VICTOIRE — C'EST LA DINGUERIE","LE DERNIER VIRAGE — VOUS ÊTES LES BOSS FINALS 👑","75% — ON EST DANS LE MONEY, FINISSEZ LE BOULOT","PRESQUE AU BOUT — C'EST MASTERCLASS LES GARS","LES DERNIERS MÈTRES — VOUS ÊTES DES MACHINES","75% — DIRECTION L'ASILE TELLEMENT VOUS ÊTES FORTS 😅"],texte:[`Trois quarts bouclés. ${pick(MESSAGES_PHILIPPE)} On lâche absolument rien. Le dernier quart va tomber.`,"75% c'est zinzin. Vous êtes des monstres. Maintenant on finit le travail proprement.","On voit la ligne d'arrivée. Vous sprintez, vous êtes des machines, on ne flanche pas.",`Si près du but. ${pick(MESSAGES_CEO)} C'est maintenant que les GOAT se révèlent 🐐`,"Dernier virage. C'est carré, gardez la tête froide et finissez fort. Come on !","25% restants — c'est presque rien pour des cracks comme vous. Allez les tigres 🐯","Vous avez fait le plus dur. Le reste c'est de l'appétit. Vous êtes sur du très lourd.","75% — j'ai le seum pour les objectifs tellement vous les détruisez 😤🔥"]},
  "100":{emoji:"🏆",header:["C'EST DANS LA BOÎTE — VOUS ÊTES DES GOAT 🐐🏆","OBJECTIF PULVÉRISÉ — VOUS ÊTES LES BOSS FINALS 👑","MISSION ACCOMPLIE — QUE DES MONSTRES ICI 😤","CHAMPAGNE — C'EST LA DINGUERIE TOTALE 🥂🥂","100% — C'EST MASTERCLASS, ON EST ENSEMBLE 🙌","GAME OVER ET C'EST NOUS QUI GAGNONS — TOUJOURS","oulaaaa vous avancez beaucoup trop vite là 😅🔥","DIRECTION L'ASILE TELLEMENT VOUS ÊTES FORTS 😅🏆"],texte:[`Objectif pulvérisé. ${pick(MESSAGES_CEO)} On célèbre et on repart encore plus fort. 🍾`,"L'objectif est tombé. Vous êtes des monstres. Quelle équipe, quel travail.",`Mission accomplie. C'est carré. ${pick(MESSAGES_PHILIPPE)} On lève le verre et on recommence.`,"100% bouclé. Vous êtes des cracks et j'ai le seum pour l'objectif tellement vous l'avez détruit.",`C'est dans la boîte. C'est zinzin ce que vous venez de faire. ${pick(MESSAGES_CEO)} 🐐`,"Objectif pulvérisé. Vous envoyez de la frappe à un niveau indécent. On célèbre et on repart.","Légendaire. Voilà ce que vous êtes. C'est la maxence totale. Je vous aime les gars 🏆","Game over — et c'est nous qui gagnons. Direction l'asile tellement vous êtes forts 😅🍾"]},
};

const MESSAGES_DEPASSEMENT = [
  {header:"oulaaaa vous avancez BEAUCOUP trop vite 😅🔥",texte:`Calma calma les gars, vous avez DÉPASSÉ l'objectif. ${pick(MESSAGES_CEO)} On fixe un nouvel objectif ?`},
  {header:"STOP STOP STOP — L'OBJECTIF EST DÉPASSÉ 🚨😅",texte:"Direction l'asile tellement vous êtes forts. J'avais pas prévu ça mais je suis pas contre 😤"},
  {header:"oulaaaa ça déborde de partout 🌊💰",texte:"Vous êtes des tigres. L'objectif ? Dépassé. Le plafond ? Inexistant. Calma calma mais continuez 🐯"},
  {header:"VOUS ÊTES DES GOAT C'EST OFFICIEL 🐐🏆",texte:`Objectif dépassé. ${pick(MESSAGES_PHILIPPE)} C'est masterclass.`},
  {header:"oulaaaa on va avoir besoin d'un plus grand compteur 📈😅",texte:"L'objectif ? Explosé. Vous envoyez de la frappe à un niveau indécent. Calma calma 😤"},
  {header:"C'EST LA DINGUERIE TOTALE LES GARS 💥🏆",texte:`Là c'est un autre niveau. ${pick(MESSAGES_CEO)} On fixe un nouvel objectif ?`},
  {header:"CALMA CALMA — MAIS CONTINUEZ 🔥😅",texte:"Vous avez dépassé l'objectif. C'est carré. C'est zinzin. On est ensemble les monstres 🙌"},
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
        ]);
        if (pctObjectif < 30) return pick([
          {emoji:"🔥",header:"BON DÉPART — ON TIENT CE RYTHME",texte:"Belle mise en route. On a toute la semaine devant nous, autant la commencer fort. Gardez cette cadence !"},
          {emoji:"💪",header:"LE RYTHME EST LÀ DÈS LE MATIN",texte:`${pick(MESSAGES_CEO)} Si on garde ça toute la semaine, c'est dans la boîte 😤`},
          {emoji:"⚡",header:"ON DÉMARRE SUR LES CHAPEAUX DE ROUES",texte:"La semaine commence bien. Ce rythme-là sur 5 jours et l'objectif va tomber largement. Allez !"},
          {emoji:"🎯",header:"C'EST PARTI — ON LÂCHE RIEN",texte:"Belle mise en route ce matin. Chaque deal de plus maintenant c'est de la marge pour la suite de la semaine 💪"},
        ]);
      }
      if (h >= 12 && h < 15) {
        if (pctObjectif < 20) return pick([
          {emoji:"🚨",header:"LE MATIN EST PASSÉ — L'APRÈM COMMENCE",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} Le compteur est encore froid. La semaine se joue maintenant. Tout le monde dessus 😤`},
          {emoji:"💥",header:"ON A L'APRÈM POUR POSER LES BASES",texte:"Le matin était calme, c'est pas un problème. L'aprèm c'est le moment de se rattraper. Closes en série, allez !"},
          {emoji:"🚨",header:"L'OBJECTIF NOUS REGARDE — ON LUI RÉPOND",texte:"Le compteur attend des chiffres concrets. L'aprèm commence, c'est maintenant qu'on envoie la frappe 🔥"},
          {emoji:"⚡",header:"LA REMONTADA COMMENCE",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} On a encore tout l'aprèm. Chaque close maintenant compte double pour le moral 💪`},
        ]);
        if (pctObjectif < 40) return pick([
          {emoji:"⚡",header:"ON CONTINUE SUR LA LANCÉE",texte:"Bonne matinée. L'aprèm c'est pour consolider. On ne lâche rien 💪"},
          {emoji:"🔥",header:"LE MOMENTUM EST LÀ — GARDEZ LA PRESSION",texte:`Si on ferme la journée avec ce rythme, la semaine va être belle. ${pick(MESSAGES_CEO)}`},
          {emoji:"💪",header:"ON EST DANS LES CLOUS — ON ACCÉLÈRE",texte:"Bon positionnement en début d'aprèm. Maintenant on met le turbo pour finir la journée fort 🎯"},
          {emoji:"🎯",header:"BELLE MISE EN ROUTE — ON POUSSE ENCORE",texte:"Le rythme est bon. Si on double la cadence cet aprèm, on finit la semaine avec de la marge. Allez !"},
        ]);
      }
      if (h >= 15) {
        if (pctObjectif < 25) return pick([
          {emoji:"🚨",header:"DERNIER PUSH AVANT DEMAIN",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} Le reste de la semaine va devoir compenser. On donne tout jusqu'à la fermeture 🔥`},
          {emoji:"💥",header:"ON SERRE LES DENTS ET ON FINIT FORT",texte:"Le compteur est trop froid. Chaque close maintenant c'est du concret pour la semaine. Allez les gars 😤"},
          {emoji:"🚨",header:"LA SEMAINE COMMENCE MAL — ON INVERSE",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} Dernier window de la journée. On envoie tout ce qu'on a maintenant 💪`},
          {emoji:"⚡",header:"LES VRAIS CLOSENT EN FIN DE JOURNÉE",texte:"C'est maintenant que ça se passe. Chaque deal avant 18h c'est de l'avance sur demain. Qui est chaud ? 🔥"},
        ]);
        if (pctObjectif >= 25) return pick([
          {emoji:"💪",header:"ON FERME CETTE JOURNÉE PROPREMENT",texte:`Belle journée. On pose des bases solides pour la semaine. ${pick(MESSAGES_CEO)} 😤`},
          {emoji:"🔥",header:"LE DÉMARRAGE EST SOLIDE — ON CONTINUE DEMAIN",texte:"On ferme la journée avec du concret. Si on reste sur cette lancée, la semaine est gagnée. Des GOAT 🐐"},
          {emoji:"🏆",header:"BELLE JOURNÉE — ON REMET ÇA DEMAIN",texte:`${pick(MESSAGES_CEO)} On pose les bases aujourd'hui, demain on accélère 💪`},
          {emoji:"⚡",header:"C'EST COMME ÇA QU'ON COMMENCE UNE SEMAINE",texte:"Finir la journée avec des chiffres solides, c'est ce qu'on veut. Demain on remet ça 🎯"},
        ]);
      }
    }

    // MARDI
    if (jour === 2) {
      if (h < 12) {
        if (pctObjectif < 15) return pick([
          {emoji:"🚨",header:"ON EST EN RETARD — LA SEMAINE COMMENCE MAINTENANT",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} Le compteur est encore froid. Aujourd'hui on rattrape. Tout le monde sur le pont 😤`},
          {emoji:"⚡",header:"LE RÉVEIL GÉNÉRAL C'EST MAINTENANT",texte:"On a pas assez fait hier. Aujourd'hui c'est le jour J. Closes en série dès ce matin. Allez !"},
          {emoji:"💥",header:"LA SEMAINE DOIT DÉMARRER MAINTENANT",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} Chaque close ce matin c'est de la marge pour la suite. On envoie la frappe !`},
          {emoji:"🚨",header:"LA REMONTADA COMMENCE CE MATIN",texte:"Le compteur est trop froid pour où on en est. Ce matin on inverse la tendance. Qui ouvre le bal ? 🔥"},
        ]);
        if (pctObjectif < 35) return pick([
          {emoji:"💪",header:"ON EST DANS LES CLOUS — ON ACCÉLÈRE",texte:"Bon rythme pour où on en est. Continuez comme ça et l'objectif de la semaine va tomber 🎯"},
          {emoji:"🔥",header:"LE MOMENTUM EST LÀ",texte:`Si on garde ce rythme aujourd'hui, demain on sera en avance. C'est exactement ce qu'on veut. ${pick(MESSAGES_CEO)}`},
          {emoji:"⚡",header:"ON EST SUR LA BONNE TRAJECTOIRE",texte:"Le rythme est bon. On reste dessus et la semaine va être belle. Qui balance le prochain deal ? 💪"},
          {emoji:"🎯",header:"BELLE PROGRESSION — ON LÂCHE RIEN",texte:`${pick(MESSAGES_CEO)} On est sur la bonne trajectoire. Accélération maintenant pour prendre de l'avance 🚀`},
        ]);
      }
      if (h >= 12 && h < 15) {
        if (pctObjectif < 25) return pick([
          {emoji:"🚨",header:"ON DOIT ACCÉLÉRER — MAINTENANT",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} Le reste de la semaine va être tendu si on n'accélère pas là. Closes en série, on y va 😤`},
          {emoji:"💥",header:"LA REMONTADA COMMENCE MAINTENANT",texte:"On a encore 3 jours et demi devant nous. C'est largement suffisant si on y met du sien. Allez les cracks !"},
          {emoji:"🚨",header:"L'APRÈM DOIT ÊTRE CHARGÉE",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} On a le temps de rattraper ça. Mais faut commencer maintenant. Tout le monde dessus 🔥`},
          {emoji:"⚡",header:"3 JOURS POUR TOUT DONNER",texte:"On a encore largement le temps de rattraper. Mais ça commence maintenant. Qui sort le prochain close ? 💪"},
        ]);
        if (pctObjectif < 45) return pick([
          {emoji:"⚡",header:"ON EST SUR LE FIL — L'APRÈM DOIT ÊTRE FORTE",texte:"On est dans les clous mais juste. L'aprèm doit être chargée. On pousse ensemble 💪"},
          {emoji:"🔥",header:"LE GAME EST OUVERT",texte:"Bon positionnement à cette heure. L'aprèm va faire la différence. Qui sort le prochain close ? 🎯"},
          {emoji:"💪",header:"ON CONTINUE — DEAL APRÈS DEAL",texte:`${pick(MESSAGES_CEO)} On reste focusés et ça va tomber. L'aprèm commence, on accélère 🚀`},
          {emoji:"🎯",header:"LE RYTHME EST LÀ — ON DOUBLE LA CADENCE",texte:"On est bien positionnés. Si on met le turbo cet aprèm, demain on sera en avance sur l'objectif. Allez !"},
        ]);
      }
      if (h >= 15) {
        if (pctObjectif < 30) return pick([
          {emoji:"🚨",header:"DERNIER PUSH — LA SEMAINE SE JOUE LÀ",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} Le reste de la semaine doit être parfait. Allez, dernier push avant demain 🔥`},
          {emoji:"💥",header:"LES PROCHAINS JOURS VONT ÊTRE DÉCISIFS",texte:"On est en retard sur l'objectif. Demain c'est le jour de la remontada. Dernier deal du jour, qui le prend ? 😤"},
          {emoji:"🚨",header:"ON A ENCORE LE TEMPS — MAIS IL FAUT DÉMARRER",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} 3 jours restants. Chaque close maintenant est critique. On envoie la frappe 💪`},
          {emoji:"⚡",header:"DERNIER WINDOW DE LA JOURNÉE",texte:"C'est l'heure où les vrais closent. Chaque deal avant 18h c'est du concret pour la semaine. Allez !"},
        ]);
        if (pctObjectif >= 30) return pick([
          {emoji:"💪",header:"ON FERME BIEN CETTE JOURNÉE",texte:`Bonne journée. On est dans le game. Demain on continue et l'objectif va tomber. ${pick(MESSAGES_CEO)} 🎯`},
          {emoji:"🔥",header:"BELLE JOURNÉE — LES BASES SONT POSÉES",texte:`On ferme en bonne posture. ${pick(MESSAGES_CEO)} 👑 On continue demain !`},
          {emoji:"🏆",header:"ON EST SUR LA BONNE TRAJECTOIRE",texte:"Finir la journée avec ce niveau c'est ce qu'on veut. Demain on remet ça et l'objectif va tomber 🎯"},
          {emoji:"⚡",header:"C'EST COMME ÇA QU'ON GAGNE UNE SEMAINE",texte:"Deal après deal, journée après journée. On reste sur cette lancée et la semaine est dans la boîte 💪"},
        ]);
      }
    }

    // MERCREDI
    if (jour === 3) {
      if (h < 12) {
        if (pctObjectif < 30) return pick([
          {emoji:"🚨",header:"MI-SEMAINE ET L'OBJECTIF EST ENCORE LOIN",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} On est au milieu et on a fait que 30%. On inverse la tendance MAINTENANT. Allez !`},
          {emoji:"💥",header:"LA SEMAINE SE JOUE MAINTENANT",texte:"Mi-semaine, mi-objectif à faire. C'est le moment de tout donner. Les boss finals closent maintenant 👑"},
          {emoji:"🚨",header:"ON EST EN RETARD — LA REMONTADA COMMENCE",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} 2 jours et demi pour tout rattraper. Ça commence ce matin. Allez les cracks !`},
          {emoji:"⚡",header:"LE SPRINT DE MI-SEMAINE DÉMARRE",texte:"On est à mi-chemin de la semaine avec trop peu de fait. Le sprint commence maintenant. Qui ouvre ? 🔥"},
        ]);
        if (pctObjectif < 50) return pick([
          {emoji:"⚡",header:"ON EST PILE SUR LE FIL — ON DOIT ACCÉLÉRER",texte:"Mi-semaine et pile à la moitié de l'objectif. C'est le minimum. L'aprèm doit être plus forte. Allez !"},
          {emoji:"🔥",header:"LE RYTHME EST BON — ON LE TIENT",texte:"On est dans les clous. La deuxième moitié de semaine commence. On garde le rythme et ça va tomber !"},
          {emoji:"💪",header:"ON EST DANS LA COURSE — ON ACCÉLÈRE",texte:`${pick(MESSAGES_CEO)} Mi-semaine et dans les clous. Si on pousse maintenant, jeudi et vendredi seront tranquilles 🎯`},
          {emoji:"🎯",header:"LE MOMENTUM EST LÀ — ON EN PROFITE",texte:"On est bien positionnés. La deuxième moitié de semaine est là pour creuser l'écart. Allez !"},
        ]);
        if (pctObjectif >= 50) return pick([
          {emoji:"💪",header:"DÉJÀ 50%+ C'EST ZINZIN",texte:`Mi-semaine et déjà plus de la moitié de l'objectif. ${pick(MESSAGES_CEO)} 👑🔥`},
          {emoji:"🏆",header:"VOUS ÊTES EN AVANCE SUR L'OBJECTIF",texte:`Mi-semaine et largement dans les clous. Cette équipe c'est des monstres. ${pick(MESSAGES_PHILIPPE)} 😤`},
          {emoji:"🚀",header:"ON EST EN AVANCE — ON CREUSE L'ÉCART",texte:"Plus de 50% à mi-semaine c'est masterclass. L'objectif va tomber avant vendredi si on continue 🏆"},
          {emoji:"💥",header:"LES CHIFFRES PARLENT D'EUX-MÊMES",texte:`${pick(MESSAGES_CEO)} 50%+ à mi-semaine, c'est une semaine de feu qui se profile. On lâche rien 🔥`},
        ]);
      }
      if (h >= 12) {
        if (pctObjectif < 40) return pick([
          {emoji:"🚨",header:"L'OBJECTIF EST EN DANGER — ON RÉAGIT",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} 2 jours restants. On envoie la frappe MAINTENANT. Pas le temps d'attendre 😤`},
          {emoji:"💥",header:"LA REMONTADA OU JAMAIS",texte:"On est en retard sur l'objectif. Les 2 prochains jours doivent être parfaits. Chaque close est critique. Allez !"},
          {emoji:"🚨",header:"ON SE RÉVEILLE OU ON RÉGRESSE",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} Jeudi et vendredi pour tout rattraper. Ça commence maintenant 🔥`},
          {emoji:"⚡",header:"DEUX JOURS POUR TOUT INVERSER",texte:"On a encore 2 jours et demi. C'est largement le temps de rattraper si on s'y met maintenant. Allez les cracks !"},
        ]);
        if (pctObjectif < 60) return pick([
          {emoji:"⚡",header:"ON EST DANS LA COURSE — ON DOUBLE LA CADENCE",texte:"On est encore dans le game. Les 2 prochains jours vont être décisifs. On accélère maintenant 💪"},
          {emoji:"🔥",header:"LE MOMENTUM EST LÀ — ON EN PROFITE",texte:`On est bien positionnés pour la fin de semaine. ${pick(MESSAGES_CEO)} On lâche rien 💪`},
          {emoji:"💪",header:"ON EST DANS LES CLOUS — ON POUSSE ENCORE",texte:"Bon positionnement à mi-semaine. Jeudi et vendredi pour finir fort. Qui balance le prochain deal ? 🎯"},
          {emoji:"🎯",header:"LE GAME EST OUVERT — ON L'EMPORTE",texte:"Mi-semaine et dans la course. Les 2 prochains jours peuvent tout faire basculer dans le bon sens. Allez !"},
        ]);
        if (pctObjectif >= 60) return pick([
          {emoji:"🏆",header:"L'OBJECTIF EST À PORTÉE — ON FINIT LE BOULOT",texte:`Plus de 60% à mi-semaine c'est masterclass. 2 jours pour finir proprement. ${pick(MESSAGES_PHILIPPE)} 🐐`},
          {emoji:"💪",header:"ON A FAIT L'ESSENTIEL — ON FINIT FORT",texte:`${pick(MESSAGES_CEO)} 60%+ à mi-semaine. Jeudi et vendredi pour finir cette semaine en beauté 👑`},
          {emoji:"🚀",header:"ON EST EN AVANCE — ON CREUSE L'ÉCART",texte:"60% à mi-semaine et 2 jours devant nous. L'objectif va tomber bien avant vendredi soir. Des GOAT 🐐"},
          {emoji:"💥",header:"QUELLE SEMAINE ON EST EN TRAIN DE FAIRE",texte:`${pick(MESSAGES_CEO)} 60%+ aujourd'hui c'est une semaine de feu. On garde le rythme 🔥`},
        ]);
      }
    }

    // JEUDI
    if (jour === 4) {
      if (h < 12) {
        if (pctObjectif < 40) return pick([
          {emoji:"🚨",header:"L'AFTERWORK AU 7 EST EN DANGER 🍺",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} Le 7 ce soir ça va être compliqué si on n'accélère pas dès maintenant. ALLEZ 😤`},
          {emoji:"💥",header:"LE DERNIER VRAI SPRINT DE LA SEMAINE COMMENCE",texte:"L'objectif est loin et le temps presse. On a encore aujourd'hui et demain pour tout donner. Allez les gars !"},
          {emoji:"🚨",header:"IL RESTE DEUX JOURS — ON SE RÉVEILLE MAINTENANT",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} Chaque close de ce matin est critique pour finir la semaine. On y va 🔥`},
          {emoji:"⚡",header:"LE SPRINT FINAL COMMENCE",texte:"On est en retard sur l'objectif et le temps tourne. Aujourd'hui c'est le jour de la remontada. Allez !"},
        ]);
        if (pctObjectif < 65) return pick([
          {emoji:"🔥",header:"ON EST DANS LE GAME — ON FINIT LE BOULOT",texte:`L'afterwork au 7 se mérite avec les closes d'aujourd'hui. ${pick(MESSAGES_CEO)} 🍺`},
          {emoji:"⚡",header:"ON EST BIEN POSITIONNÉS — ON CLÔTURE",texte:"Ce matin on finit de poser les bases, l'aprèm on clôture. L'objectif est à portée si on reste focusés 👑"},
          {emoji:"💪",header:"LA SEMAINE SE GAGNE MAINTENANT",texte:`${pick(MESSAGES_PHILIPPE)} On est dans les clous. Chaque deal de ce matin rapproche du 7 ce soir 🍺`},
          {emoji:"🎯",header:"L'OBJECTIF EST À PORTÉE — ON FINIT PROPREMENT",texte:"On est dans la course et on a encore toute la journée. Si on reste dessus, cette semaine est gagnée. Allez !"},
        ]);
        if (pctObjectif >= 65) return pick([
          {emoji:"🏆",header:"ON A QUASI TOUT FAIT — ON FINALISE",texte:`65%+ ce matin c'est une semaine de feu. Le 7 ce soir vous l'avez amplement mérité. Finissez proprement 🍺🔥`},
          {emoji:"💪",header:"L'OBJECTIF VA TOMBER AUJOURD'HUI",texte:`On a 65%+ et toute la journée devant nous. Quelques closes et c'est dans la boîte. ${pick(MESSAGES_CEO)} 🐐`},
          {emoji:"🚀",header:"CETTE SEMAINE EST DÉJÀ GAGNÉE",texte:"65% à cette heure, c'est masterclass. L'objectif va tomber avant ce soir. Finissez en beauté 🏆"},
          {emoji:"💥",header:"VOUS AVEZ ÉCRASÉ LA MI-SEMAINE",texte:`${pick(MESSAGES_CEO)} 65%+ ce matin. Finissez cette journée proprement et c'est une semaine parfaite 🔥`},
        ]);
      }
      if (h >= 12) {
        if (pctObjectif < 50) return pick([
          {emoji:"🚨",header:"URGENCE MAXIMALE — DERNIER SPRINT 🚨",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} Encore à moins de 50%. On a l'aprèm et vendredi. C'est maintenant que les vrais closent. Allez 😤`},
          {emoji:"💥",header:"LES DERNIÈRES HEURES COMPTENT DOUBLE",texte:"On a encore du temps mais il faut tout donner dès maintenant. Closes en série, pas le temps d'attendre 🔥"},
          {emoji:"🚨",header:"IL FAUT INVERSER MAINTENANT",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} Aprèm chargée obligatoire. Tout le monde sur le pont, on envoie la frappe 💪`},
          {emoji:"⚡",header:"LA REMONTADA OU JAMAIS",texte:"On est à moins de 50% avec une journée et demie. C'est tendu mais faisable. Allez les cracks, tout le monde dessus !"},
        ]);
        if (pctObjectif < 75) return pick([
          {emoji:"🔥",header:"ON Y EST PRESQUE — ON FINIT LE BOULOT",texte:`Chaque close maintenant = un pas vers le 7 ce soir. ${pick(MESSAGES_CEO)} Qui balance le prochain deal ? 🍺`},
          {emoji:"⚡",header:"LE FINISH EST LÀ",texte:"On est dans la course. Les boss finals closent maintenant pour finir la semaine en beauté 👑"},
          {emoji:"💪",header:"L'OBJECTIF EST À PORTÉE — ON ACCÉLÈRE",texte:`${pick(MESSAGES_PHILIPPE)} On approche. Chaque deal maintenant peut faire basculer la semaine dans la victoire 🎯`},
          {emoji:"🎯",header:"ON EST DANS LES CLOUS — ON CLOSE",texte:"Bon positionnement à cette heure. L'objectif va tomber si on reste focusés jusqu'à ce soir. Allez !"},
        ]);
        if (pctObjectif >= 75) return pick([
          {emoji:"🏆",header:"L'OBJECTIF VA TOMBER CE SOIR 🍺🔥",texte:`75%+ et toute l'aprèm devant nous. Le 7 ce soir vous l'avez mérité. Finissez proprement et on célèbre 🥂`},
          {emoji:"💪",header:"QUELLE SEMAINE ON EST EN TRAIN DE FAIRE",texte:`75%+ de fait et encore du temps. Demain on met le point final et c'est une semaine parfaite. ${pick(MESSAGES_CEO)} 🐐`},
          {emoji:"🚀",header:"L'OBJECTIF EST QUASIMENT DANS LA BOÎTE",texte:"75%+ à cette heure c'est masterclass. Quelques closes et c'est plié. Vous êtes des GOAT 🐐"},
          {emoji:"💥",header:"VOUS ALLEZ FINIR CETTE SEMAINE EN BEAUTÉ",texte:`${pick(MESSAGES_CEO)} 75%+ et une journée et demie devant vous. Cette semaine va être parfaite 🔥`},
        ]);
      }
    }

    // VENDREDI
    if (jour === 5) {
      if (h < 12) {
        if (pctObjectif < 50) return pick([
          {emoji:"🚨",header:"DERNIER JOUR — L'OBJECTIF EST ENCORE LOIN 🚨",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} Le Brelan ce soir ça se mérite MAINTENANT. Tout le monde dessus 🍺🔥`},
          {emoji:"💥",header:"LA SEMAINE SE GAGNE CE MATIN",texte:"L'objectif est encore loin et c'est le dernier jour. Faut pas que Philippe voie ce compteur ce soir. On accélère ALLEZ 😤"},
          {emoji:"🚨",header:"C'EST MAINTENANT OU JAMAIS",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} Dernier matin de la semaine. Closes en série dès maintenant. Tout le monde dessus 🔥`},
          {emoji:"⚡",header:"LE DERNIER MATIN DE LA SEMAINE — ON L'UTILISE",texte:"On a encore ce matin et cet aprèm. C'est suffisant si on y met tout. Qui ouvre le bal ce matin ? 💪"},
        ]);
        if (pctObjectif < 75) return pick([
          {emoji:"🔥",header:"ON EST DANS LE GAME — ON FINIT LA SEMAINE",texte:`Chaque close ce matin = un verre au Brelan ce soir. ${pick(MESSAGES_CEO)} Qui est chaud ? 🍺`},
          {emoji:"⚡",header:"L'OBJECTIF EST À PORTÉE",texte:"On est bien positionnés pour finir fort. Ce matin on attaque, l'aprèm on clôture 💪"},
          {emoji:"💪",header:"LA SEMAINE SE FINIT EN BEAUTÉ",texte:`${pick(MESSAGES_PHILIPPE)} On est dans les clous. Ce matin on ferme ce qui reste et le Brelan est validé 🍺`},
          {emoji:"🎯",header:"ON EST À UN SPRINT DU BUT",texte:"On est dans la course et il reste toute la journée. L'objectif va tomber si on reste focusés. Allez !"},
        ]);
        if (pctObjectif >= 75) return pick([
          {emoji:"🏆",header:"QUELLE SEMAINE ON VIENT DE FAIRE 🔥",texte:`75%+ et le dernier matin devant nous. Quelques closes et c'est dans la boîte. Le Brelan est validé 🍺🎉`},
          {emoji:"💪",header:"ON FINIT CETTE SEMAINE EN BEAUTÉ",texte:`Vendredi matin avec 75%+. ${pick(MESSAGES_CEO)} On finit proprement et on célèbre 👑`},
          {emoji:"🚀",header:"L'OBJECTIF EST QUASIMENT DANS LA BOÎTE",texte:"75%+ vendredi matin c'est une semaine de feu. Finissez et cette semaine rejoint le hall of fame 🏆"},
          {emoji:"💥",header:"CETTE SEMAINE EST DÉJÀ GAGNÉE",texte:`${pick(MESSAGES_CEO)} 75%+ vendredi matin. Finissez proprement et profitez du weekend, vous l'avez mérité 🥂`},
        ]);
      }
      if (h >= 12) {
        if (pctObjectif < 50) return pick([
          {emoji:"🚨",header:"C'EST MAINTENANT OU JAMAIS 🚨",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} Dernier aprèm de la semaine. Le Brelan ce soir c'est pour ceux qui closent LÀ. ALLEZ 🍺🔥`},
          {emoji:"💥",header:"LES PROCHAINES HEURES DÉCIDENT DE LA SEMAINE",texte:"Dernier aprèm de la semaine. Faut pas que Philippe voie ce compteur ce soir. On donne tout MAINTENANT 😤"},
          {emoji:"🚨",header:"DERNIER PUSH DE LA SEMAINE",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} Il reste quelques heures. Tout le monde dessus, closes en série 🔥`},
          {emoji:"⚡",header:"ON A L'APRÈM POUR TOUT CHANGER",texte:"Dernier aprèm de la semaine et on a encore du temps. Mais ça commence maintenant. Qui sort le prochain close ? 💪"},
        ]);
        if (pctObjectif < 80) return pick([
          {emoji:"🔥",header:"ON FINIT LE BOULOT 🍺",texte:`Chaque close maintenant = un verre au Brelan. ${pick(MESSAGES_CEO)} Qui balance le prochain deal ?`},
          {emoji:"⚡",header:"L'OBJECTIF EST À PORTÉE DE MAIN",texte:"On y est presque. Quelques closes et cette semaine est dans la boîte. Vous êtes des monstres 💪"},
          {emoji:"💪",header:"ON EST À UN DEAL DU BUT",texte:`${pick(MESSAGES_PHILIPPE)} L'objectif est à portée. Finissez ce que vous avez commencé. Le Brelan vous attend 🍺`},
          {emoji:"🎯",header:"LE FINISH EST LÀ — ON CLOSE",texte:"Dernier aprèm et on approche. Les boss finals ferment les deals maintenant. Qui est le prochain ? 👑"},
        ]);
        if (pctObjectif >= 80) return pick([
          {emoji:"🏆",header:"ON FINIT CETTE SEMAINE EN BEAUTÉ 🍺🎉",texte:`80%+ et le weekend qui arrive. Le Brelan ce soir c'est validé. Finissez proprement et on célèbre 🥂`},
          {emoji:"💥",header:"QUELLE SEMAINE LES GARS 🔥",texte:`${pick(MESSAGES_CEO)} 80%+ vendredi aprèm. On finit fort et on profite du weekend 🏆`},
          {emoji:"🚀",header:"L'OBJECTIF EST QUASIMENT PLIÉ",texte:"80%+ vendredi aprèm c'est une semaine de feu. Finissez proprement et cette semaine rejoint le hall of fame 🐐"},
          {emoji:"💪",header:"ON EST DES MONSTRES — OFFICIELLEMENT",texte:`${pick(MESSAGES_PHILIPPE)} 80%+ vendredi aprèm. Finissez et le weekend se mérite amplement. Bravo les gars 🙌`},
        ]);
      }
    }

    // WEEK-END (samedi / dimanche) — rare mais possible
    if (jour === 6 || jour === 0) {
      if (pctObjectif < 50) return pick([
        {emoji:"💪",header:"LA SEMAINE PROCHAINE ON FRAPPE FORT",texte:`On finit à ${pctObjectif}%. Le weekend c'est pour recharger et revenir lundi en mode berserker 🔥`},
        {emoji:"🎯",header:"ON ANALYSE ET ON REVIENT PLUS FORTS",texte:`${pctObjectif}% cette semaine. Weekend pour recharger les batteries, lundi pour attaquer 💪`},
        {emoji:"⚡",header:"ON RECHARGE ET ON REVIENT",texte:`${pctObjectif}% cette semaine. La semaine prochaine on fait mieux. Bon weekend les gars 😤`},
        {emoji:"🔥",header:"LE PROCHAIN SPRINT COMMENCE LUNDI",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} ${pctObjectif}% cette semaine. On analyse, on ajuste, et lundi c'est reparti 🚀`},
      ]);
      return pick([
        {emoji:"🏆",header:"BELLE SEMAINE LES GARS",texte:`${pctObjectif}% — c'est une semaine solide. Profitez du weekend, vous le méritez. Lundi on repart de plus belle 🙌`},
        {emoji:"🔥",header:"VOUS AVEZ BIEN TRAVAILLÉ CETTE SEMAINE",texte:`${pick(MESSAGES_CEO)} ${pctObjectif}% cette semaine c'est du solide. Bon weekend ! 👑`},
        {emoji:"💪",header:"LE WEEKEND C'EST POUR LES GENS QUI ONT TOUT DONNÉ",texte:`${pctObjectif}% — le weekend se mérite et vous l'avez mérité. Rechargez les batteries et revenez lundi en mode killer 🔥`},
        {emoji:"🏆",header:"BELLE PERFORMANCE CETTE SEMAINE",texte:`${pick(MESSAGES_PHILIPPE)} ${pctObjectif}% au compteur. Bon weekend, et lundi on repart encore plus fort 💪`},
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
        {emoji:"💪",header:"ON DÉMARRE — QUI OUVRE ?",texte:`${pick(MESSAGES_CEO)} Le compteur attend. Premier close de la journée, qui est chaud ? ☕`},
      ]);
      if (pctObjectif < 30) return pick([
        {emoji:"🔥",header:"BON DÉBUT — ON TIENT CE RYTHME",texte:"Belle mise en route ce matin. Si on garde ce rythme l'objectif va tomber avant 17h. Allez les cracks !"},
        {emoji:"💪",header:"LE RYTHME EST LÀ — ON ACCÉLÈRE",texte:`${pick(MESSAGES_CEO)} On démarre bien. On continue et l'objectif va tomber aujourd'hui 😤`},
        {emoji:"⚡",header:"ON DÉMARRE SUR LES CHAPEAUX DE ROUES",texte:"Belle mise en route. Chaque deal de plus maintenant c'est de la marge pour l'aprèm. On lâche rien !"},
        {emoji:"🎯",header:"C'EST PARTI — ON LÂCHE RIEN",texte:`Bon début de journée. ${pick(MESSAGES_PHILIPPE)} Si on garde ce rythme, l'objectif va tomber avant 17h 💪`},
      ]);
    }

    // MILIEU DE JOURNÉE (12h-15h)
    if (h >= 12 && h < 15) {
      if (pctObjectif < 30) return pick([
        {emoji:"🚨",header:"L'APRÈM COMMENCE — ON DOIT ACCÉLÉRER",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} On a l'aprèm pour tout rattraper. Closes en série, allez 😤`},
        {emoji:"💥",header:"LE SPRINT DE L'APRÈM COMMENCE",texte:"On est à la moitié de la journée et l'objectif est loin. Il faut inverser MAINTENANT. Tout le monde dessus 🔥"},
        {emoji:"🚨",header:"ON A L'APRÈM — ON L'UTILISE",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} L'objectif est loin mais l'aprèm est longue. Closes en série, pas le temps d'attendre 💪`},
        {emoji:"⚡",header:"LA REMONTADA COMMENCE",texte:"Moitié de journée, encore beaucoup à faire. Mais l'aprèm peut tout changer. On y met tout, ALLEZ !"},
      ]);
      if (pctObjectif < 50) return pick([
        {emoji:"⚡",header:"ON EST SUR LE FIL — L'APRÈM EST DÉCISIVE",texte:"Moitié de journée, moins de moitié de l'objectif. L'aprèm va faire la différence. Tout le monde pousse !"},
        {emoji:"🔥",header:"LE MOMENTUM EST LÀ — ON EN PROFITE",texte:"On est dans la course. L'aprèm va faire la différence. On finit cette journée en beauté 🎯"},
        {emoji:"💪",header:"ON EST DANS LES CLOUS — ON ACCÉLÈRE",texte:`${pick(MESSAGES_CEO)} Bon positionnement à midi. L'aprèm pour creuser l'écart. Allez !`},
        {emoji:"🎯",header:"LE GAME EST OUVERT — ON LE GAGNE",texte:"Bien positionnés à mi-journée. L'aprèm pour tout finir. Qui sort le prochain close ? 💪"},
      ]);
      if (pctObjectif >= 50) return pick([
        {emoji:"🏆",header:"DÉJÀ 50%+ — VOUS ÊTES DES MONSTRES",texte:`Moitié de journée et plus de la moitié de l'objectif. ${pick(MESSAGES_CEO)} 👑`},
        {emoji:"💪",header:"ON EST EN AVANCE — ON CREUSE L'ÉCART",texte:"En avance sur l'objectif journalier à midi. Si on continue comme ça on va le pulvériser. Des GOAT 🐐"},
        {emoji:"🚀",header:"L'OBJECTIF VA TOMBER CET APRÈM",texte:`50%+ à midi c'est masterclass. ${pick(MESSAGES_PHILIPPE)} L'aprèm pour finir en beauté 🔥`},
        {emoji:"💥",header:"QUELLE MATINÉE VOUS VENEZ DE FAIRE",texte:`${pick(MESSAGES_CEO)} 50%+ avant midi. L'objectif va tomber bien avant 18h si on continue 🏆`},
      ]);
    }

    // FIN DE JOURNÉE (15h+)
    if (h >= 15) {
      if (pctObjectif < 40) return pick([
        {emoji:"🚨",header:"SPRINT TOTAL — IL RESTE PEU DE TEMPS",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} C'est maintenant que les vrais se révèlent. ALLEZ, tout le monde dessus 🔥`},
        {emoji:"💥",header:"C'EST MAINTENANT OU JAMAIS",texte:"Il reste peu de temps et l'objectif est encore loin. Closes en série immédiatement. Allez les monstres !"},
        {emoji:"🚨",header:"LES DERNIÈRES HEURES SONT LÀ",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} Chaque deal maintenant compte triple. On ferme tout ce qu'on peut avant 18h 💪`},
        {emoji:"⚡",header:"ON A LES DERNIÈRES HEURES — ON LES UTILISE",texte:"Il reste du temps. Closes en série maintenant et l'objectif peut encore tomber. Allez les cracks !"},
      ]);
      if (pctObjectif < 70) return pick([
        {emoji:"🔥",header:"ON EST DANS LA COURSE — ON FINIT LE BOULOT",texte:"On approche. Chaque close maintenant est décisif. Vous êtes des machines, finissez ce que vous avez commencé 💪"},
        {emoji:"⚡",header:"LE FINISH EST LÀ",texte:`L'objectif est à portée. Les derniers closes de la journée appartiennent aux boss finals. ${pick(MESSAGES_CEO)} 👑`},
        {emoji:"💪",header:"ON Y EST PRESQUE — ON FINIT",texte:`${pick(MESSAGES_PHILIPPE)} On approche de l'objectif. Qui sort le dernier close ? 🎯`},
        {emoji:"🎯",header:"L'OBJECTIF EST ACCESSIBLE — ON CLOSE",texte:"On est bien positionnés pour finir cette journée fort. Quelques closes et c'est dans la boîte. Allez !"},
      ]);
      if (pctObjectif >= 70) return pick([
        {emoji:"🏆",header:"L'OBJECTIF VA TOMBER AUJOURD'HUI 🔥",texte:`70%+ en fin de journée c'est énorme. ${pick(MESSAGES_CEO)} Finissez proprement et cette journée sera parfaite 🐐`},
        {emoji:"💥",header:"VOUS ALLEZ PULVÉRISER L'OBJECTIF",texte:"On est si proches que c'est douloureux 😤 Quelques closes et c'est dans la boîte. Allez les monstres !"},
        {emoji:"🚀",header:"L'OBJECTIF EST QUASIMENT PLIÉ",texte:`${pick(MESSAGES_PHILIPPE)} 70%+ en fin de journée. Finissez et cette journée rejoint le hall of fame 🏆`},
        {emoji:"💪",header:"VOUS ÊTES DES MONSTRES — OFFICIELLEMENT",texte:`${pick(MESSAGES_CEO)} 70%+ et encore du temps. Cette journée va être parfaite 🔥`},
      ]);
    }
  }

  // Fallback
  return null;
}

// ============================================================
// VÉRIFICATION MILESTONES
// ============================================================
function verifierMilestone(objectifDepart, objectif) {
  if (!objectifDepart || objectifDepart <= 0) return null;
  const pct = Math.round((1 - Math.max(0, objectif) / objectifDepart) * 100);

  let triggered = null;
  for (const threshold of [25, 50, 75, 100]) {
    if (pct >= threshold && !state.milestonesVus.includes(threshold)) {
      state.milestonesVus.push(threshold);
      const m = MILESTONES[String(threshold)];
      triggered = {
        emoji: m.emoji,
        header: pick(m.header),
        texte: pick(m.texte),
      };
    }
  }

  if (triggered) {
    sauvegarderState(state);
    return triggered;
  }

  return getMilestoneAdaptatif(pct);
}

function getMilestoneForce(objectifDepart, objectif) {
  const m = verifierMilestone(objectifDepart, objectif);
  if (m) return m;
  const pct = objectifDepart > 0 ? Math.round((1 - Math.max(0, objectif) / objectifDepart) * 100) : 0;
  return getMilestoneAdaptatif(pct) || pick([
    {emoji:"🔥",header:"ON CONTINUE — DEAL APRÈS DEAL",texte:`${pick(MESSAGES_PHILIPPE)} Chaque close compte, on lâche rien. 💪`},
    {emoji:"⚡",header:"LE MOMENTUM EST LÀ — ON EN PROFITE",texte:`${pick(MESSAGES_CEO)} Gardez la cadence les gars !`},
    {emoji:"💪",header:"C'EST COMME ÇA QU'ON CONSTRUIT UN OBJECTIF",texte:"Deal après deal, close après close. C'est le game et vous êtes dans le game 🎯"},
    {emoji:"🚀",header:"VOUS ENVOYEZ DE LA FRAPPE — CONTINUEZ",texte:`${pick(MESSAGES_CEO)} On est sur la bonne trajectoire 📈`},
    {emoji:"😤",header:"LES MONSTRES SONT EN TRAIN DE CLOSER",texte:`${pick(MESSAGES_PHILIPPE)} C'est exactement ce qu'on veut voir. 🐐`},
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
// ============================================================
function construireMessage(deals, ancienObjectif, restant, objectifDepart, milestone, closeQ=false) {
  const depasse     = restant<0;
  const depasseAff  = Math.abs(restant).toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2});
  const pctObjectif = Math.round((1-Math.max(0,restant)/objectifDepart)*100);
  const temps       = getTempsRestant();
  const pression    = getMessagePression(temps.pctJourneeEcoule, pctObjectif);
  const calcul      = construireCalcul(deals, ancienObjectif, restant);
  const blocks      = [];

  // ── 1. TITRE ─────────────────────────────────────────────
  blocks.push({type:"section",text:{type:"mrkdwn",text:`🚨  *COMPTEUR MONEY LISA*  🚨`}});

  // ── 2. MILESTONE / PRESSION / CLOSE Q sous le titre ──────
  if (milestone) {
    blocks.push({type:"section",text:{type:"mrkdwn",text:`${milestone.emoji}  *${milestone.header}*  ${milestone.emoji}\n_${milestone.texte}_`}});
  } else if (closeQ) {
    const msgQ = pick(MESSAGES_CLOSE_Q);
    blocks.push({type:"section",text:{type:"mrkdwn",text:`🍑  *${msgQ.header}*\n_${msgQ.texte}_`}});
  } else if (pression&&!depasse) {
    blocks.push({type:"section",text:{type:"mrkdwn",text:`⚡  *${pression.header}*\n_${typeof pression.texte==="function"?pression.texte():pression.texte}_`}});
  }

  blocks.push({type:"divider"});

  // ── 3. DÉPASSEMENT ───────────────────────────────────────
  if (depasse) {
    const msg = pick(MESSAGES_DEPASSEMENT);
    blocks.push({type:"section",text:{type:"mrkdwn",text:calcul}});
    blocks.push({type:"section",text:{type:"mrkdwn",text:barreProgression(objectifDepart,restant)}});
    blocks.push({type:"divider"});
    blocks.push({type:"section",text:{type:"mrkdwn",text:`🏆  *${msg.header}*\n> *Objectif pour ${state.modeLabel} : ${state.objectifDepart.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€*\n> *+${depasseAff}€ AU-DESSUS DE L'OBJECTIF* 🔥\n\n_${msg.texte}_`}});
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

  const pctObjectif = Math.round((1-Math.max(0,state.objectif)/state.objectifDepart)*100);
  const temps       = getTempsRestant();
  const pression    = getMessagePression(temps.pctJourneeEcoule, pctObjectif);
  const milestone   = verifierMilestone(state.objectifDepart, state.objectif);

  const calcul = mrrBuffer>0
    ? `*${ancienObjectif.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€*  ${bufferSnapshot.flatMap(d=>(d.leads&&d.leads.length>1?d.leads:[d.montant])).map(l=>`−  ${l.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€`).join("  ")}  =  *${Math.max(0,state.objectif).toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€*  /  ${state.objectifDepart.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€  _(${state.modeLabel})_`
    : `*${Math.max(0,state.objectif).toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€*  /  ${state.objectifDepart.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€  _(${state.modeLabel})_`;

  const blocks = [];

  // ── 1. TITRE ─────────────────────────────────────────────
  blocks.push({type:"section",text:{type:"mrkdwn",text:`🚨  *COMPTEUR MONEY LISA*  🚨`}});

  // ── 2. MILESTONE ou PRESSION sous le titre ───────────────
  if (milestone) {
    blocks.push({type:"section",text:{type:"mrkdwn",text:`${milestone.emoji}  *${milestone.header}*  ${milestone.emoji}\n_${milestone.texte}_`}});
  } else if (pression) {
    blocks.push({type:"section",text:{type:"mrkdwn",text:`⚡  *${pression.header}*\n_${typeof pression.texte==="function"?pression.texte():pression.texte}_`}});
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
    {type:"section",text:{type:"mrkdwn",text:`${isSuppression?"🗑️":"✏️"}  _${msgTexte}_`}},
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
  "Continuez comme ça les monstres 😤🔥","Voilà ce qu'on veut voir. Vous êtes des cracks 💪",
  "C'est masterclass. Quitterie et Emmanuelle sont fières 👑","Le classement c'est bien, le 100% c'est mieux. On continue 🚀",
  "Philippe va adorer ce classement. Gardez ce rythme 😤","Vous envoyez de la frappe les gars. C'est exactement ça 🔥",
  "C'est carré. Maintenant on double la mise 💥","Des GOAT. Voilà ce que vous êtes 🐐🏆",
  "C'est zinzin ce classement. Continuez à envoyer 🙌","Top 3 de feu. Le reste du classement va devoir se réveiller 😅🔥",
  "Ça c'est un classement de boss finals 👑","C'est la maxence totale. Je vous aime les gars 🏆",
  "Direction l'asile tellement vous êtes bons 😅💥","Vous êtes des tigres. Philippe peut être fier 🐯😤",
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
  return `🏆  *TOP SALES — ${periodeLabel.toUpperCase()} (${modeLabel})*\n\n${lignes}\n\n_${pick(MESSAGES_TOP_SALES_FIN)}_`;
}

// ============================================================
// MESSAGES PLANIFIÉS
// ============================================================
// MESSAGES_PLANIFIES — headers sans jour ni heure, texte dynamique via fonction (pct, modeLabel)
const MESSAGES_PLANIFIES = {
  matin:{
    lundi:[
      {header:"LA SEMAINE COMMENCE MAINTENANT 🚀",texte:(p,ml)=>`Le weekend c'est fini, les closes c'est maintenant. ${p>0?`Déjà ${p}% de l'objectif ${ml} au compteur. `:""}Qui ouvre le score cette semaine ?`},
      {header:"QUI OUVRE LE BAL CETTE SEMAINE ? ☕",texte:(p,ml)=>`Nouveau lundi, nouvelles opportunités. ${pick(MESSAGES_CEO)} On a toute la semaine pour atteindre l'objectif ${ml}. Allez !`},
      {header:"ON A UNE SEMAINE À GAGNER 💪",texte:(p,ml)=>`La semaine commence. L'objectif ${ml} nous attend. ${p>0?`${p}% déjà fait, `:""}On continue de monter 🎯`},
      {header:"LE COMPTEUR TOURNE — QUI ENVOIE LA FRAPPE ? 🔥",texte:(p,ml)=>`Lundi matin et l'objectif ${ml} est là. ${pick(MESSAGES_PHILIPPE)} Premier close de la semaine, qui se lance ?`},
    ],
    mardi:[
      {header:"LA SEMAINE PREND FORME — ON ACCÉLÈRE 🔥",texte:(p,ml)=>`La semaine avance. ${p>0?`On est à ${p}% de l'objectif ${ml}. `:""}C'est maintenant qu'on envoie la frappe pour se mettre à l'aise.`},
      {header:"L'OBJECTIF NOUS REGARDE — ON LUI RÉPOND 👀",texte:(p,ml)=>`${p>0?`${p}% de fait sur l'objectif ${ml}. `:""}Chaque deal maintenant c'est de l'avance. Qui envoie la frappe ce matin ?`},
      {header:"ON EST LANCÉS — ON LÂCHE RIEN 💪",texte:(p,ml)=>`${pick(MESSAGES_CEO)} ${p>0?`${p}% au compteur sur l'objectif ${ml}. `:""}On continue de pousser et la semaine va être belle !`},
      {header:"L'OBJECTIF DE LA SEMAINE EST À PORTÉE 🎯",texte:(p,ml)=>`${p>=40?`${p}% de fait, on est en bonne posture sur l'objectif ${ml}. Gardez le rythme !`:`On est à ${p}% de l'objectif ${ml}. C'est maintenant qu'on met le turbo. Allez !`}`},
    ],
    mercredi:[
      {header:"PIVOT DE MI-SEMAINE — TOUT LE MONDE POUSSE ⚡",texte:(p,ml)=>`Milieu de semaine et on est à ${p}% de l'objectif ${ml}. ${p>=50?"On est dans les clous, on garde le rythme !":"L'aprèm doit être forte. Tout le monde pousse !"}`},
      {header:"LA SEMAINE SE JOUE MAINTENANT 🔥",texte:(p,ml)=>`${p>=50?`${p}% de fait à mi-semaine — c'est masterclass. ${pick(MESSAGES_CEO)}`:`On est à ${p}% à mi-semaine. ${pick(MESSAGES_PHILIPPE_PRESSION)} C'est maintenant qu'on bascule !`}`},
      {header:"CE QUI SE PASSE AUJOURD'HUI DÉFINIT LA FIN DE SEMAINE 💥",texte:(p,ml)=>`Milieu de semaine, objectif ${ml} à ${p}%. ${p>=50?"Bien positionné. On continue à ce rythme et vendredi on célèbre.":"Il reste encore de la marge. Ce matin on accélère, l'aprèm on finit le boulot."}`},
      {header:"HUMP DAY — ON BASCULE OU ON RESTE ? 🏆",texte:(p,ml)=>`${pick(MESSAGES_CEO)} On est à ${p}% de l'objectif ${ml}. ${p>=45?"Belle semaine en cours, on continue 💪":"Le momentum doit s'accélérer maintenant. Allez les cracks !"}`},
    ],
    jeudi:[
      {header:"L'AFTERWORK AU 7 ÇA SE MÉRITE 🍺🔥",texte:(p,ml)=>`L'afterwork au 7 ce soir ça se mérite avec des closes. On est à ${p}% de l'objectif ${ml}. ${p>=65?"Quelques closes et c'est plié. Allez !":"On a encore tout le temps. Qui ouvre ce matin ?"}`},
      {header:"AVANT-DERNIER JOUR — ON ENVOIE TOUT 💥",texte:(p,ml)=>`${p>=65?`${p}% de fait sur l'objectif ${ml} — on est en avance. Finissons proprement !`:`${p}% sur l'objectif ${ml}. Il reste aujourd'hui et demain pour tout donner. ${pick(MESSAGES_PHILIPPE_PRESSION)}`}`},
      {header:"LE 7 VOUS ATTEND SI VOUS CLOSEZ 🍺😤",texte:(p,ml)=>`${pick(MESSAGES_PHILIPPE)} On est à ${p}% de l'objectif ${ml}. L'afterwork au 7 ce soir, c'est pour ceux qui closent maintenant.`},
      {header:"DERNIER SPRINT DE LA SEMAINE — AUJOURD'HUI OU JAMAIS 🔥",texte:(p,ml)=>`On a aujourd'hui et demain. ${p}% de l'objectif ${ml} au compteur. ${p>=60?"L'objectif va tomber cette semaine. Finissons en beauté !":"On a besoin d'un gros push ces 2 jours. Tout le monde dessus !"}`},
    ],
    vendredi:[
      {header:"DERNIER JOUR — ON FINIT FORT 🔥",texte:(p,ml)=>`Dernière journée de la semaine. On est à ${p}% de l'objectif ${ml}. ${p>=75?"Quelques closes et c'est dans la boîte. Le Brelan est validé 🍺":"On a toute la journée pour tout donner. Allez !"}`},
      {header:"LE WEEKEND SE MÉRITE — ALORS ON CLOSE 💪",texte:(p,ml)=>`${p>=75?`${p}% de fait — quelle semaine ! Le Brelan ce soir c'est validé. Finissez proprement 🍺🎉`:`La semaine se finit aujourd'hui. ${p}% au compteur sur l'objectif ${ml}. On donne tout et on célèbre ce soir !`}`},
      {header:"FINISSONS CETTE SEMAINE EN BEAUTÉ 🏆",texte:(p,ml)=>`${pick(MESSAGES_CEO)} On est à ${p}% de l'objectif ${ml}. Aujourd'hui on finit ce qu'on a commencé. Le Brelan vous attend 🍺`},
      {header:"DERNIER BAL DE LA SEMAINE — QUI DANSE ? 💃🔥",texte:(p,ml)=>`Vendredi matin. ${p}% sur l'objectif ${ml}. ${p>=65?"On est sur une belle trajectoire. Finissons fort et on fête ça ce soir !":"L'objectif est encore atteignable. Closes en série dès maintenant, on y va !"}`},
    ],
  },
  finMatinee:{
    lundi:[
      {header:"LE COMPTEUR COMMENCE À CHAUFFER ? 👀",texte:(p,ml)=>`${p>0?`${p}% de l'objectif ${ml} déjà au compteur.`:"Le compteur attend ses premiers deals."} Qui a déjà envoyé de la frappe ce matin ?`},
      {header:"ON EST BIEN PARTIS ? 🎯",texte:(p,ml)=>`${p>=20?`${p}% au compteur — beau début ! Si on garde ce rythme, la semaine va être belle.`:`${p}% sur l'objectif ${ml}. L'aprèm doit être plus chargée. Allez les gars !`}`},
      {header:"LA MATINÉE TIRE À SA FIN ⚡",texte:(p,ml)=>`${pick(MESSAGES_CEO)} ${p}% de l'objectif ${ml} fait ce matin. L'aprèm commence bientôt — on va doubler la cadence !`},
    ],
    mardi:[
      {header:"ON Y EST — QUI CLOSE MAINTENANT ? 🔥",texte:(p,ml)=>`${p}% de l'objectif ${ml} au compteur. Le reste de la semaine se construit deal par deal. Allez les cracks !`},
      {header:"LA MATINÉE AVANCE VITE ⚡",texte:(p,ml)=>`${pick(MESSAGES_PHILIPPE)} ${p}% fait sur l'objectif ${ml}. L'aprèm c'est le moment de passer la 2ème vitesse !`},
      {header:"LE MOMENTUM EST LÀ — ON EN PROFITE 💪",texte:(p,ml)=>`${p}% sur l'objectif ${ml}. Si on continue à cette cadence, l'objectif va tomber bien avant vendredi !`},
    ],
    mercredi:[
      {header:"ON EST AU COEUR DE LA SEMAINE ⚡",texte:(p,ml)=>`Milieu de semaine, milieu de matinée. ${p}% de l'objectif ${ml}. C'est le bon moment pour envoyer la frappe les gars !`},
      {header:"LE PIVOT C'EST MAINTENANT 🔥",texte:(p,ml)=>`${p}% au compteur sur l'objectif ${ml}. ${p>=45?"On est dans les clous. L'aprèm pour finir fort !":"On accélère maintenant et demain on est en avance."}`},
      {header:"MI-SEMAINE — L'HEURE DE VÉRITÉ 📊",texte:(p,ml)=>`${pick(MESSAGES_CEO)} ${p}% de l'objectif ${ml} fait. ${p>=50?"Masterclass à mi-semaine. On continue !":`Il faut pousser maintenant pour finir la semaine en beauté.`}`},
    ],
    jeudi:[
      {header:"LE 7 CE SOIR C'EST POUR LES CLOSERS 🍺😤",texte:(p,ml)=>`${p}% de l'objectif ${ml}. L'afterwork au 7 se mérite deal par deal. Qui est en train de se l'offrir là ?`},
      {header:"AVANT-DERNIÈRE MATINÉE DE LA SEMAINE 💥",texte:(p,ml)=>`${pick(MESSAGES_PHILIPPE)} ${p}% sur l'objectif ${ml}. Il reste aujourd'hui et demain pour finir fort. On pousse maintenant !`},
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
      {header:"L'APRÈM COMMENCE — QUI OUVRE ? 🎯",texte:(p,ml)=>`${pick(MESSAGES_PHILIPPE)} ${p}% de l'objectif ${ml}. L'aprèm commence, c'est maintenant qu'on envoie de la frappe !`},
    ],
    mardi:[
      {header:"CLOSES DU 🍑 EN SÉRIE — C'EST L'HEURE 💪",texte:(p,ml)=>`${p}% sur l'objectif ${ml}. L'aprèm de mardi c'est le meilleur moment pour closer. Qui balance le prochain deal ?`},
      {header:"C'EST MAINTENANT QU'ON ENVOIE 🔥",texte:(p,ml)=>`${pick(MESSAGES_CEO)} ${p}% de l'objectif ${ml} fait. L'aprèm commence — deals en série, on lâche rien !`},
      {header:"L'APRÈM DÉCIDE DE LA SEMAINE ⚡",texte:(p,ml)=>`${p}% au compteur sur l'objectif ${ml}. Cette aprèm peut tout changer. Tout le monde pousse maintenant !`},
    ],
    mercredi:[
      {header:"PIVOT TOTAL — C'EST MAINTENANT 🔥",texte:(p,ml)=>`Milieu de journée, milieu de semaine. ${p}% de l'objectif ${ml}. C'est LE moment charnière. Tout le monde pousse !`},
      {header:"L'APRÈM DE MI-SEMAINE EST DÉCISIVE 💥",texte:(p,ml)=>`${p}% sur l'objectif ${ml}. Cette aprèm définit jeudi et vendredi. On envoie la frappe maintenant !`},
      {header:"CE QUI SE PASSE LÀ DÉFINIT LA FIN DE SEMAINE 🎯",texte:(p,ml)=>`${pick(MESSAGES_PHILIPPE)} ${p}% de l'objectif ${ml}. L'aprèm est là pour inverser ou consolider. Allez les cracks !`},
    ],
    jeudi:[
      {header:"LE 7 SE MÉRITE MAINTENANT 🍺🔥",texte:(p,ml)=>`${p}% sur l'objectif ${ml}. L'afterwork au 7 se gagne deal par deal. C'est maintenant qu'on le mérite. Allez !`},
      {header:"AVANT-DERNIÈRE APRÈM DE LA SEMAINE 💥",texte:(p,ml)=>`${p}% de l'objectif ${ml}. Il reste cet aprèm et demain. ${p>=65?"On est bien positionnés. On finit proprement !":"On donne tout maintenant. Pas le temps d'attendre !"}`},
      {header:"L'URGENCE C'EST MAINTENANT 🚨",texte:(p,ml)=>`${pick(MESSAGES_PHILIPPE_PRESSION)} ${p}% de l'objectif ${ml}. Cette aprèm est critique pour finir la semaine en beauté. ALLEZ !`},
    ],
    vendredi:[
      {header:"LE BRELAN VOUS ATTEND 🍺😤",texte:(p,ml)=>`${p}% de l'objectif ${ml}. Le Brelan ce soir c'est pour ceux qui closent maintenant. Qui est dans la course ?`},
      {header:"DERNIÈRE APRÈM DE LA SEMAINE 🔥",texte:(p,ml)=>`${p}% au compteur sur l'objectif ${ml}. Dernier aprèm. Tout ce qu'on close maintenant c'est de la semaine gagnée. ALLEZ !`},
      {header:"C'EST L'HEURE DU FINISH 🏁💥",texte:(p,ml)=>`${pick(MESSAGES_CEO)} ${p}% sur l'objectif ${ml}. Le Brelan ce soir = chaque close cet aprèm. Qui balance le prochain deal ? 🍺`},
    ],
  },
  soir:{
    lundi:[
      {header:"ON FAIT LE BILAN — ET ON REPART DEMAIN 📊",texte:(p,ml)=>`Fin de journée. ${p}% de l'objectif ${ml} au compteur. ${p>=20?"Belle journée de lundi ! Demain on continue sur cette lancée.":"La journée est terminée. Demain on remonte les manches et on repart plus fort !"}`},
      {header:"LA JOURNÉE EST DANS LA BOÎTE 🙌",texte:(p,ml)=>`${p}% sur l'objectif ${ml} après le premier jour. ${pick(MESSAGES_PHILIPPE)} Reposez-vous — demain on remet le couvert !`},
      {header:"ROUND 1 TERMINÉ — À DEMAIN POUR LE ROUND 2 💪",texte:(p,ml)=>`${p}% de l'objectif ${ml} au bout du premier jour. ${p>=20?"Bon départ !":"Pas le meilleur départ, mais demain c'est une nouvelle page."} À demain les monstres !`},
    ],
    mardi:[
      {header:"LA JOURNÉE EST TERMINÉE — À DEMAIN 💪",texte:(p,ml)=>`${p}% sur l'objectif ${ml}. ${p>=40?"Bonne progression. Demain on continue !":" Encore du chemin mais on a le temps. Demain on repart encore plus fort !"}`},
      {header:"ON FAIT LE POINT — ET ON REVIENT DEMAIN 📊",texte:(p,ml)=>`${p}% de l'objectif ${ml}. ${pick(MESSAGES_CEO)} Reposez-vous, demain la semaine se joue pour de vrai.`},
      {header:"JOURNÉE DANS LA BOÎTE — DEMAIN ON ACCÉLÈRE 🔥",texte:(p,ml)=>`${p}% sur l'objectif ${ml}. ${p>=35?"On est dans les clous.":"Il va falloir accélérer demain."} À demain les cracks !`},
    ],
    mercredi:[
      {header:"LE CAP EST PASSÉ — LA DESCENTE VERS LE WEEKEND 🏆",texte:(p,ml)=>`${p}% sur l'objectif ${ml}. La moitié de la semaine est derrière nous. Les deux derniers jours vont être décisifs !`},
      {header:"MI-SEMAINE BOUCLÉE 🎯",texte:(p,ml)=>`${p}% de l'objectif ${ml}. ${p>=50?"On est en bonne posture pour finir la semaine fort. Demain on accélère !":"Il reste jeudi et vendredi pour tout donner. Reposez-vous et revenez demain en mode berserker !"}`},
      {header:"ON A PASSÉ LE MIL DE MI-SEMAINE 💥",texte:(p,ml)=>`${pick(MESSAGES_PHILIPPE)} ${p}% sur l'objectif ${ml}. Demain jeudi, avant-dernier jour — c'est là que les vrais se révèlent. À demain !`},
    ],
    jeudi:[
      {header:"L'AFTERWORK AU 7 SE MÉRITE 🍺🔥",texte:(p,ml)=>`${p}% de l'objectif ${ml} au compteur. L'afterwork au 7 ce soir c'est pour ceux qui ont tout donné. Vous y étiez ?`},
      {header:"AVANT-DERNIER JOUR BOUCLÉ 💪",texte:(p,ml)=>`${p}% sur l'objectif ${ml}. Demain c'est le grand final. Reposez-vous et revenez vendredi en mode finish.`},
      {header:"DEMAIN C'EST LE GRAND FINAL 🏆",texte:(p,ml)=>`${p}% de l'objectif ${ml}. Demain vendredi = dernier jour. ${p>=65?"On est en bonne posture. Finissons en beauté !":"Il reste tout à donner demain. Dormez bien, demain on est là."}`},
    ],
    vendredi:[
      {header:"DERNIER PUSH AVANT LE BRELAN 🍺🔥",texte:(p,ml)=>`${p}% de l'objectif ${ml}. Tout ceux qui closent avant 18h30 je leur paye un verre au Brelan. C'est dit, c'est promis. Allez !`},
      {header:"LE BRELAN VOUS ATTEND 🍺💪",texte:(p,ml)=>`Plus qu'une heure. ${p}% sur l'objectif ${ml}. Chaque close avant 18h30 = un verre au Brelan offert. Qui est chaud ?`},
      {header:"L'HEURE DU FINISH — QUI CLOSE ? 🏁🔥",texte:(p,ml)=>`${pick(MESSAGES_PHILIPPE)} ${p}% de l'objectif ${ml}. Les derniers closes de la semaine appartiennent aux boss finals. Qui les prend ?`},
    ],
  },
  cloture:{
    lundi:[
      {header:"BONNE SOIRÉE — À DEMAIN 🙌",texte:(p,ml)=>`Fin de journée. ${p}% de l'objectif ${ml}. On rentre, on recharge, et demain on revient encore plus forts !`},
      {header:"LA JOURNÉE EST TERMINÉE — REPOS MÉRITÉ 💪",texte:(p,ml)=>`${p}% sur l'objectif ${ml} au bout du premier jour. ${pick(MESSAGES_CEO)} À demain les monstres !`},
    ],
    mardi:[
      {header:"À DEMAIN LES MONSTRES 💪",texte:(p,ml)=>`${p}% de l'objectif ${ml}. Encore deux jours et demi. On rentre et demain on remet le couvert encore plus fort !`},
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
      {header:"WEEKEND — RECHARGEZ LES BATTERIES 🔋🙌",texte:(p,ml)=>`${p}% de l'objectif ${ml} cette semaine. ${pick(MESSAGES_CEO)} Bon weekend les monstres — lundi on repart plus forts !`},
      {header:"LA SEMAINE EST DANS LA BOÎTE 🏆",texte:(p,ml)=>`${p}% sur l'objectif ${ml}. ${pick(MESSAGES_PHILIPPE)} Rechargez les batteries et revenez lundi en mode berserker. Bon weekend !`},
    ],
  },
};

const JOURS = ["dimanche","lundi","mardi","mercredi","jeudi","vendredi","samedi"];

function demarrerPlanificateur(client) {
  setInterval(async () => {
    const {h,m,jour}=getNowParis();
    if (jour===0||jour===6) return;
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
        {type:"section",text:{type:"mrkdwn",text:`⏰  *${msg.header}*\n_${texte}_`}},
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
  if (!estEdition&&state.tsDejaComptes.includes(ts)) return;
  if (/^\s*<@[A-Z0-9]+>\s*(?:objectif|obj|add|ajoute|remove|supprime|switch|change|statut|stat|top|reset)/i.test(texte)) return;

  const mrr    = extraireMRR(texte);
  const closeQ = detecterCloseQ(texte);

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
        const milestone = verifierMilestone(state.objectifDepart, state.objectif);
        const pctObjectif = Math.round((1-Math.max(0,state.objectif)/state.objectifDepart)*100);
        const temps = getTempsRestant();
        const pression = getMessagePression(temps.pctJourneeEcoule, pctObjectif);
        const calcul = `*${state.objectifDepart.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€*  →  *${Math.max(0,state.objectif).toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€*  /  ${state.objectifDepart.toLocaleString("fr-FR",{minimumFractionDigits:0,maximumFractionDigits:2})}€  _(${state.modeLabel})_`;
        const blocks = [];
        blocks.push({type:"section",text:{type:"mrkdwn",text:`🚨  *COMPTEUR MONEY LISA*  🚨`}});
        if (milestone) {
          blocks.push({type:"section",text:{type:"mrkdwn",text:`${milestone.emoji}  *${milestone.header}*  ${milestone.emoji}\n_${milestone.texte}_`}});
        } else if (pression) {
          blocks.push({type:"section",text:{type:"mrkdwn",text:`⚡  *${pression.header}*\n_${typeof pression.texte==="function"?pression.texte():pression.texte}_`}});
        }
        blocks.push({type:"divider"});
        blocks.push({type:"section",text:{type:"mrkdwn",text:`✏️  _${pick(MESSAGES_MODIF)}_`}});
        blocks.push({type:"section",text:{type:"mrkdwn",text:calcul}});
        blocks.push({type:"section",text:{type:"mrkdwn",text:barreProgression(state.objectifDepart,state.objectif)}});
        await client.chat.postMessage({channel,text:`✏️ Compteur ajusté`,blocks});
      }
      return;
    }
    if (!mrr) return;
  }

  if (!mrr) return;

  let userName="Commercial";
  try {const u=await client.users.info({user:userId});userName=u.user.real_name||u.user.name;} catch(e){}

  const now=new Date(),dateStr=now.toISOString().split("T")[0],weekStr=getWeekKey(now);
  if (!state.salesStats[userId]) state.salesStats[userId]={name:userName,closes:[]};
  state.salesStats[userId].name=userName;
  if (!state.salesStats[userId].closes.some(c=>c.ts===ts))
    state.salesStats[userId].closes.push({ts,montant:mrr,date:dateStr,week:weekStr});

  state.buffer.push({user:userName,userId,montant:mrr,leads:extraireTousMRR(texte),ts,closeQ});
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
    const hasCloseQ=deals.some(d=>d.closeQ);
    state.objectif=ancienObjectif-totalMRR;
    state.buffer=[];
    deals.forEach(d=>{state.tsDejaComptes.push(d.ts);state.montantsComptes[d.ts]=d.montant;});
    if (state.tsDejaComptes.length>200) state.tsDejaComptes=state.tsDejaComptes.slice(-200);
    state.nbCompteurs = (state.nbCompteurs || 0) + 1;
    sauvegarderState(state);
    const milestone = (state.nbCompteurs % 3 === 0)
      ? getMilestoneForce(state.objectifDepart, state.objectif)
      : verifierMilestone(state.objectifDepart, state.objectif);
    const blocks=construireMessage(deals,ancienObjectif,state.objectif,state.objectifDepart,milestone,hasCloseQ);
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
      demarrerPlanificateur(app.client);
    } catch(e) {
      console.error("❌ Erreur, nouvelle tentative dans 5s...", e.message);
      setTimeout(demarrer, 5000);
    }
  };
  await demarrer();
})();