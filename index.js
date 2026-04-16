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

const STATE_FILE  = "./state.json";
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
    buffer: [], milestonesVus: [], tsDejaComptes: [], montantsComptes: {}, salesStats: {},
  };
}
function sauvegarderState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

let state = chargerState();
if (!state.tsDejaComptes)   state.tsDejaComptes   = [];
if (!state.montantsComptes) state.montantsComptes  = {};
if (!state.salesStats)      state.salesStats       = {};

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
  const matchK = texte.match(/(\d+)[,.](\d+)\s*k/i);
  if (matchK) return parseInt(matchK[1],10)*1000 + parseInt(matchK[2],10)*100;
  const matchK2 = texte.match(/(\d+)\s*k/i);
  if (matchK2) return parseInt(matchK2[1],10)*1000;
  const matchN = texte.match(/(\d[\d\s]*)/);
  if (matchN) return parseInt(matchN[1].replace(/\s/g,""),10);
  return null;
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
  const t = texte.toLowerCase().replace(/[^a-zàâäéèêëîïôùûü0-9\s']/g," ");
  const mots = t.split(/\s+/).filter(Boolean);
  const proche = (mot,cibles) => cibles.some(c=>similarite(mot,c)<=2);
  const mSemaine = ["semaine","semaien","smeaine","smaine","semiane","semmaine","semainne","semain","seamine","semaie","weekly","wekly"];
  const mJournee = ["journee","journée","jounree","jounrée","jorunee","journé","journe","daily","dayli","daly"];
  const mJour    = ["jour","jours","day","today"];
  const mMois    = ["mois","mosi","mios","mis","month"];
  const mFin     = ["fin","fiin","fni","end"];
  const mAujourd = ["aujourd","aujrd","ajd","auj","aujo"];

  if (/aujourd'?hui|ajd\b|aujrd\b/i.test(t)) return "la journée";
  if (/\b(?:de\s+la|cette|la)\s+semaine\b/i.test(t)) return "la semaine";
  if (/\bsemaine\b/i.test(t)) return "la semaine";
  if (/\bweekly\b/i.test(t)) return "la semaine";
  if (/\b(?:de\s+la|la)\s+journ[eé]e\b/i.test(t)) return "la journée";
  if (/\bdaily\b/i.test(t)) return "la journée";

  for (let i=0;i<mots.length-1;i++)
    if (proche(mots[i],mFin) && mots.slice(i+1).some(m=>proche(m,mSemaine))) return "la fin de semaine";
  if (/fin.{0,8}s[eé]m/i.test(t)) return "la fin de semaine";

  const mS = t.match(/(\d+)\s*semaines?/);
  if (mS) return `les ${mS[1]} prochaines semaines`;
  const mJ = t.match(/(\d+)\s*(?:prochains?\s+)?jours?/);
  if (mJ && parseInt(mJ[1])>1) return `les ${mJ[1]} prochains jours`;

  const mJusq = t.match(/(?:jusqu'?|jusq'?|jusqua|juska)\s*(?:au?|à|a)?\s+(.{2,20}?)(?:\s|$)/);
  if (mJusq) return `la période jusqu'au ${mJusq[1].trim()}`;
  const mAv = t.match(/(?:avant|avnat|avat)\s+(.{2,20}?)(?:\s|$)/);
  if (mAv) return `la période avant ${mAv[1].trim()}`;
  const mDici = t.match(/(?:d'ici|dici)\s+(.{2,20}?)(?:\s|$)/);
  if (mDici) return `la période d'ici ${mDici[1].trim()}`;

  for (const mot of mots) {
    if (proche(mot,mAujourd)) return "la journée";
    if (proche(mot,mJournee)) return "la journée";
    if (proche(mot,mJour))    return "la journée";
    if (proche(mot,mSemaine)) return "la semaine";
    if (proche(mot,mMois))    return "le mois";
  }
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

  // ── 3. Cherche MRR explicite ─────────────────────────────
  const mrrReg = /(\d[\d\s]*)\s*€?\s*(?:de\s+)?(?:m\.?r\.?r?\.?|mrr|mmr|rmr)\s*(?:annuel(?:le)?)?|(?:m\.?r\.?r?\.?|mrr|mmr|rmr)\s*(?:annuel(?:le)?\s*)?[:\-]?\s*(\d[\d\s]*)/gi;

  const resultats = [];
  let match;
  while ((match = mrrReg.exec(sanFaux)) !== null) {
    const raw = (match[1]||match[2]||"").replace(/\s/g,"");
    const montant = parseInt(raw,10);
    if (isNaN(montant)||montant<=0||montant>=100000) continue;
    if (!resultats.some(r=>Math.abs(r.index-match.index)<20))
      resultats.push({montant,index:match.index});
  }

  // ── 4. Cherche UPSELL explicite ──────────────────────────
  // Reconnaît : upsell, up-sell, upgrade, montée en gamme,
  // extension, ajout module, augmentation contrat, extension contrat
  const upsellReg = /(?:upsell|up[\s\-]?sell|upgr[ae]de|mont[eé]e?\s*en\s*gamme|extension|ajout\s*(?:module|option|utilisateur|user|licence|licences?)|augmentation\s*(?:contrat|abonnement|licence)|cross[\s\-]?sell|addon|add[\s\-]?on)\s*[:\-]?\s*[+]?\s*(\d[\d\s]*)\s*€?|[+]?\s*(\d[\d\s]*)\s*€?\s*(?:d[e']?\s*)?(?:upsell|up[\s\-]?sell|upgr[ae]de|extension|ajout)/gi;

  while ((match = upsellReg.exec(sanFaux)) !== null) {
    const raw = (match[1]||match[2]||"").replace(/\s/g,"");
    const montant = parseInt(raw,10);
    if (isNaN(montant)||montant<=0||montant>=100000) continue;
    if (!resultats.some(r=>Math.abs(r.index-match.index)<20))
      resultats.push({montant,index:match.index,isUpsell:true});
  }

  if (resultats.length>0) {
    const montants = resultats.map(r=>r.montant);
    console.log(`✅ MRR/Upsell : ${montants.join(" + ")} = ${montants.reduce((s,m)=>s+m,0)}€`);
    return montants;
  }

  // ── 5. 1 seul montant en € = MRR ─────────────────────────
  const euros = [...sanFaux.matchAll(/\b(\d[\d\s]*)\s*€/g)]
    .filter(m=>!m.input.slice(m.index-10,m.index+20).includes("IGNORE"));
  if (euros.length===1) {
    const montant = parseInt(euros[0][1].replace(/\s/g,""),10);
    if (!isNaN(montant)&&montant>0&&montant<100000) return [montant];
  }

  // ── 6. Message "Close/Upsell [nom] [montant]" sans € ─────
  if (/^\s*(?:close|deal|won|vendu|sign[eé]|upsell|upgrade|extension)\b/i.test(sanFaux)) {
    const nums = [...sanFaux.matchAll(/\b(\d{2,4})\b/g)]
      .filter(m=>!m.input.slice(m.index-5,m.index+15).includes("IGNORE"));
    if (nums.length===1) {
      const montant = parseInt(nums[0][1],10);
      if (!isNaN(montant)&&montant>10&&montant<10000) return [montant];
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
  const now=new Date(), nowMin=now.getHours()*60+now.getMinutes();
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
    {header:"OÙ EST-CE QU'ON EN EST LÀ 👀🔥",texte:`On est à 75% de la journée et l'objectif est pas encore à moitié. ${pick(MESSAGES_PHILIPPE_PRESSION)} Allez les gars !`},
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
    {header:"30 MIN — C'EST MAINTENANT QU'ON ENVOIE LA FRAPPE 🔥",texte:`Dernières 30 minutes. ${pick(MESSAGES_PHILIPPE_PRESSION)} Allez les tigres 🐯`},
  ],
};

function getMessagePression(pctJourneeEcoule, pctObjectifFait) {
  const now=new Date(), h=now.getHours(), m=now.getMinutes();
  const nowMin=h*60+m, finMin=18*60+30, restant=Math.max(0,finMin-nowMin), jour=now.getDay();
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
  const now  = new Date();
  const h    = now.getHours();
  const jour = now.getDay(); // 1=lun, 2=mar, 3=mer, 4=jeu, 5=ven
  const isHebdo = !["la journée"].includes(state.modeLabel);

  // ── OBJECTIF HEBDOMADAIRE ────────────────────────────────

  if (isHebdo) {

    // LUNDI
    if (jour === 1) {
      if (pctObjectif < 10) return pick([
        {emoji:"🚀",header:"LUNDI ET ON DÉMARRE À PEINE — ON S'ACTIVE",texte:"C'est lundi, la semaine vient de commencer et l'objectif nous attend. Qui ouvre le bal ? Quitterie et Emmanuelle regardent 👑"},
        {emoji:"☕",header:"LUNDI MATIN — LE COMPTEUR EST À 0, PAS NORMAL",texte:"On est lundi et on a quasiment rien fait. La semaine se gagne dès le premier jour. Allez les gars, on se réveille !"},
      ]);
      if (pctObjectif < 30) return pick([
        {emoji:"💪",header:"LUNDI — ON EST PARTIS MAIS C'EST PAS ASSEZ",texte:"Bon début mais le rythme doit s'accélérer. On a toute la semaine devant nous, autant la commencer fort. Allez !"},
        {emoji:"🔥",header:"LUNDI — LE RYTHME EST LÀ, ON CONTINUE",texte:"Belle mise en route. Si on garde ce rythme toute la semaine, Philippe va être plus que content 😤"},
      ]);
    }

    // MARDI
    if (jour === 2) {
      if (pctObjectif < 20) return pick([
        {emoji:"🚨",header:"MARDI ET ON EST À PEINE À 20% — RÉVEIL GÉNÉRAL",texte:"Mardi matin et l'objectif de la semaine est à peine entamé. Philippe ne va pas être content si ça continue comme ça. On accélère MAINTENANT 😤"},
        {emoji:"⚡",header:"MARDI — ON EST EN RETARD SUR LA SEMAINE",texte:"On est mardi et on a pas fait assez. Le reste de la semaine va devoir compenser. Tout le monde sur le pont, on envoie la frappe !"},
      ]);
      if (pctObjectif < 40) return pick([
        {emoji:"💪",header:"MARDI — ON AVANCE MAIS C'EST JUSTE",texte:"C'est mardi et on est à moins de 40%. Pour atteindre l'objectif de la semaine il va falloir mettre le turbo. Allez les cracks !"},
        {emoji:"🔥",header:"MARDI — LE MOMENTUM EST LÀ, ON LÂCHE RIEN",texte:"Bon rythme pour un mardi. Si on continue comme ça la semaine va être belle. Quitterie va être fière 👑"},
      ]);
    }

    // MERCREDI
    if (jour === 3) {
      if (pctObjectif < 30) return pick([
        {emoji:"🚨",header:"MERCREDI MI-SEMAINE ET ON EST À 30% — C'EST CHAUD",texte:"On est au milieu de la semaine et on a fait que 30% de l'objectif. Faut pas que Philippe voie ça... On inverse la tendance MAINTENANT. Allez !"},
        {emoji:"💥",header:"MERCREDI — LA SEMAINE SE JOUE MAINTENANT",texte:"Milieu de semaine, milieu de l'objectif à faire. C'est le moment de tout donner. Les boss finals closent maintenant 👑"},
      ]);
      if (pctObjectif < 50) return pick([
        {emoji:"⚡",header:"MERCREDI — ON EST PILE SUR LE FIL",texte:"Mi-semaine et à moitié de l'objectif. C'est bien mais c'est pas assez. Les 2 derniers jours vont être décisifs. On double la cadence !"},
        {emoji:"🔥",header:"HUMP DAY — L'OBJECTIF EST À PORTÉE",texte:"Mercredi et on est dans les clous. La descente vers la fin de semaine commence. On garde le rythme et ça va tomber !"},
      ]);
      if (pctObjectif >= 50) return pick([
        {emoji:"💪",header:"MERCREDI — VOUS ÊTES EN AVANCE SUR LA SEMAINE",texte:"Mi-semaine et déjà plus de 50% de l'objectif. C'est zinzin. Quitterie et Emmanuelle vont kiffer ce compteur 👑🔥"},
        {emoji:"🏆",header:"HUMP DAY — VOUS ENVOYEZ DE LA FRAPPE",texte:"Mercredi et on est largement dans les clous. Cette équipe c'est des monstres. Philippe peut être fier 😤"},
      ]);
    }

    // JEUDI
    if (jour === 4) {
      if (pctObjectif < 40) return pick([
        {emoji:"🚨",header:"JEUDI ET ON EST À 40% — L'AFTERWORK AU 7 EST EN DANGER 🍺",texte:"On est jeudi et à moins de 40%. Le 7 ce soir ça va être compliqué si on n'accélère pas. Tout le monde sur le pont, MAINTENANT 😤"},
        {emoji:"💥",header:"JEUDI — DERNIER VRAI SPRINT DE LA SEMAINE",texte:`C'est jeudi, avant-dernier jour. L'objectif est loin et le temps presse. ${pick(MESSAGES_PHILIPPE_PRESSION)} Allez les gars !`},
      ]);
      if (pctObjectif < 70) return pick([
        {emoji:"🔥",header:"JEUDI — ON Y EST PRESQUE, FINISSONS LE BOULOT",texte:"On est jeudi et on approche. L'afterwork au 7 se mérite avec ces derniers closes. Qui balance le prochain deal ? 🍺"},
        {emoji:"⚡",header:"JEUDI — LE FINISH EST LÀ",texte:"Avant-dernier jour et on est dans la course. Les boss finals closent maintenant pour finir la semaine en beauté 👑"},
      ]);
      if (pctObjectif >= 70) return pick([
        {emoji:"🏆",header:"JEUDI — VOUS AVEZ PRESQUE TOUT FAIT 🍺🔥",texte:"70%+ jeudi c'est masterclass. Le 7 ce soir vous l'avez mérité. Finissez proprement et on célèbre 🍺"},
        {emoji:"💪",header:"JEUDI — L'OBJECTIF VA TOMBER CETTE SEMAINE",texte:"On est jeudi, 70%+ de fait. Demain on finit ça proprement. Vous êtes des GOAT 🐐"},
      ]);
    }

    // VENDREDI
    if (jour === 5) {
      if (pctObjectif < 50) return pick([
        {emoji:"🚨",header:"VENDREDI ET ON EST À MOINS DE 50% — C'EST MAINTENANT OU JAMAIS",texte:"Dernier jour de la semaine et on est à moins de 50%. Le Brelan ce soir c'est pour ceux qui closent MAINTENANT. Tout le monde dessus 🍺🔥"},
        {emoji:"💥",header:"VENDREDI — LA SEMAINE SE FINIT AUJOURD'HUI",texte:"C'est vendredi et l'objectif est encore loin. Faut pas que Philippe voie ce compteur en fin de journée... On accélère, ALLEZ 😤"},
      ]);
      if (pctObjectif < 80) return pick([
        {emoji:"🔥",header:"VENDREDI — ON EST DANS LE GAME, FINISSONS 🍺",texte:"Vendredi et on approche. Chaque close maintenant = un verre au Brelan. Qui est chaud pour finir la semaine en beauté ?"},
        {emoji:"⚡",header:"VENDREDI — L'OBJECTIF EST À PORTÉE DE MAIN",texte:"On y est presque. Vendredi après-midi et l'objectif va tomber. Vous êtes des monstres, finissez le travail 💪"},
      ]);
      if (pctObjectif >= 80) return pick([
        {emoji:"🏆",header:"VENDREDI — VOUS ALLEZ FINIR LA SEMAINE EN BEAUTÉ 🍺🎉",texte:"80%+ vendredi c'est une semaine de feu. Le Brelan ce soir c'est validé. Finissez proprement et on célèbre 🥂"},
        {emoji:"💥",header:"VENDREDI — QUELLE SEMAINE LES GARS 🔥",texte:"Vendredi et on est à 80%+. Quitterie et Emmanuelle vont adorer ce compteur. On finit fort et on profite du weekend 🏆"},
      ]);
    }
  }

  // ── OBJECTIF JOURNALIER ──────────────────────────────────

  if (!isHebdo) {

    // MATIN (avant 12h)
    if (h < 12) {
      if (pctObjectif < 10) return pick([
        {emoji:"☕",header:"ON EST LE MATIN ET ON A QUASI RIEN FAIT",texte:"La journée vient de commencer et l'objectif nous regarde. Chaque close maintenant c'est de l'avance. Qui ouvre le bal ?"},
        {emoji:"🚀",header:"MATIN — LE COMPTEUR ATTEND",texte:"On est encore tôt et c'est bien. Mais l'objectif journalier attend pas. Premier deal de la journée, qui se lance ?"},
      ]);
      if (pctObjectif < 30) return pick([
        {emoji:"🔥",header:"BON DÉBUT DE JOURNÉE — ON CONTINUE",texte:"Belle mise en route ce matin. Si on garde ce rythme l'objectif va tomber avant 17h. Allez les cracks !"},
        {emoji:"💪",header:"MATIN — LE RYTHME EST LÀ",texte:"On démarre bien. Philippe va sourire en voyant ces chiffres ce soir 😤"},
      ]);
    }

    // MILIEU DE JOURNÉE (12h-15h)
    if (h >= 12 && h < 15) {
      if (pctObjectif < 30) return pick([
        {emoji:"🚨",header:"MIDI ET ON EST À MOINS DE 30% — C'EST CHAUD",texte:"On est à la moitié de la journée et l'objectif est loin. Il faut inverser la tendance MAINTENANT. Tout le monde sur le pont 😤"},
        {emoji:"💥",header:"MILIEU DE JOURNÉE — LE SPRINT COMMENCE",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} On a l'aprèm pour rattraper ça. Closes du 🍑 en série, allez !`},
      ]);
      if (pctObjectif < 50) return pick([
        {emoji:"⚡",header:"MIDI — ON EST SUR LE FIL",texte:"Moitié de journée, moins de moitié de l'objectif. L'aprèm va être décisif. Tout le monde pousse maintenant !"},
        {emoji:"🔥",header:"MILIEU DE JOURNÉE — LE MOMENTUM EST LÀ",texte:"On est dans la course. L'aprèm va faire la différence. Closes du 🍑 et on finit cette journée en beauté !"},
      ]);
      if (pctObjectif >= 50) return pick([
        {emoji:"🏆",header:"MIDI ET DÉJÀ PLUS DE 50% — VOUS ÊTES DES MONSTRES",texte:"Moitié de journée et plus de la moitié de l'objectif. C'est masterclass. Quitterie va kiffer ce compteur 👑"},
        {emoji:"💪",header:"MILIEU DE JOURNÉE — VOUS ÊTES EN AVANCE",texte:"On est en avance sur l'objectif journalier. Si on continue comme ça on va le pulvériser. Des GOAT 🐐"},
      ]);
    }

    // FIN DE JOURNÉE (15h-18h30)
    if (h >= 15) {
      if (pctObjectif < 40) return pick([
        {emoji:"🚨",header:"FIN DE JOURNÉE ET ON EST À 40% — SPRINT TOTAL",texte:"Il reste peu de temps et l'objectif est encore loin. C'est maintenant que les vrais se révèlent. ALLEZ, tout le monde dessus 🔥"},
        {emoji:"💥",header:"DERNIÈRES HEURES — C'EST MAINTENANT OU JAMAIS",texte:`${pick(MESSAGES_PHILIPPE_PRESSION)} Les boss finals closent dans les prochaines heures. Come on !`},
      ]);
      if (pctObjectif < 70) return pick([
        {emoji:"🔥",header:"FIN DE JOURNÉE — ON EST DANS LA COURSE",texte:"On approche. Chaque close maintenant est décisif. Vous êtes des machines, finissez ce que vous avez commencé 💪"},
        {emoji:"⚡",header:"DERNIÈRES HEURES — LE FINISH EST LÀ",texte:"L'objectif est à portée. Les derniers closes de la journée appartiennent aux boss finals. Qui les prend ? 👑"},
      ]);
      if (pctObjectif >= 70) return pick([
        {emoji:"🏆",header:"FIN DE JOURNÉE — L'OBJECTIF VA TOMBER 🔥",texte:"70%+ en fin de journée c'est énorme. Finissez proprement et cette journée sera parfaite. Vous êtes des GOAT 🐐"},
        {emoji:"💥",header:"DERNIÈRES HEURES — VOUS ALLEZ PULVÉRISER L'OBJECTIF",texte:"On est si proches que c'est douloureux 😤 Quelques closes et c'est dans la boîte. Allez les monstres !"},
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

// ============================================================
// CONSTRUCTION DU CALCUL
// ============================================================
function construireCalcul(deals, ancienObjectif, restant) {
  const debut  = `*${ancienObjectif.toLocaleString("fr-FR")}€*`;
  const soustr = deals.flatMap(d=>(d.leads&&d.leads.length>1?d.leads:[d.montant])).map(l=>`−  ${l.toLocaleString("fr-FR")}€`).join("  ");
  const res    = `*${restant.toLocaleString("fr-FR")}€*`;
  const obj    = `${state.objectifDepart.toLocaleString("fr-FR")}€  _(${state.modeLabel})_`;
  return `${debut}  ${soustr}  =  ${res}  /  ${obj}`;
}

// ============================================================
// CONSTRUCTION DU MESSAGE
// ============================================================
function construireMessage(deals, ancienObjectif, restant, objectifDepart, milestone, closeQ=false) {
  const depasse     = restant<0;
  const depasseAff  = Math.abs(restant).toLocaleString("fr-FR");
  const pctObjectif = Math.round((1-Math.max(0,restant)/objectifDepart)*100);
  const temps       = getTempsRestant();
  const pression    = getMessagePression(temps.pctJourneeEcoule, pctObjectif);
  const calcul      = construireCalcul(deals, ancienObjectif, restant);
  const blocks      = [];

  // ── 1. TITRE ─────────────────────────────────────────────
  blocks.push({type:"section",text:{type:"mrkdwn",text:`🚨  *COMPTEUR MONEY LISA*  🚨`}});

  // ── 2. MILESTONE / PRESSION / CLOSE Q sous le titre ──────
  if (milestone) {
    blocks.push({type:"section",text:{type:"mrkdwn",text:`${milestone.emoji}  *${milestone.header}*\n_${milestone.texte}_`}});
  } else if (closeQ) {
    const msgQ = pick(MESSAGES_CLOSE_Q);
    blocks.push({type:"section",text:{type:"mrkdwn",text:`🍑  *${msgQ.header}*\n_${msgQ.texte}_`}});
  } else if (pression&&!depasse) {
    blocks.push({type:"section",text:{type:"mrkdwn",text:`⚡  *${pression.header}*\n_${pression.texte}_`}});
  }

  blocks.push({type:"divider"});

  // ── 3. DÉPASSEMENT ───────────────────────────────────────
  if (depasse) {
    const msg = pick(MESSAGES_DEPASSEMENT);
    blocks.push({type:"section",text:{type:"mrkdwn",text:calcul}});
    blocks.push({type:"section",text:{type:"mrkdwn",text:barreProgression(objectifDepart,restant)}});
    blocks.push({type:"divider"});
    blocks.push({type:"section",text:{type:"mrkdwn",text:`🏆  *${msg.header}*\n> *Objectif pour ${state.modeLabel} : ${state.objectifDepart.toLocaleString("fr-FR")}€*\n> *+${depasseAff}€ AU-DESSUS DE L'OBJECTIF* 🔥\n\n_${msg.texte}_`}});
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
    ? `*${ancienObjectif.toLocaleString("fr-FR")}€*  ${state.buffer.length>0?state.buffer.flatMap(d=>(d.leads&&d.leads.length>1?d.leads:[d.montant])).map(l=>`−  ${l.toLocaleString("fr-FR")}€`).join("  "):`−  ${mrrBuffer.toLocaleString("fr-FR")}€`}  =  *${Math.max(0,state.objectif).toLocaleString("fr-FR")}€*  /  ${state.objectifDepart.toLocaleString("fr-FR")}€  _(${state.modeLabel})_`
    : `*${Math.max(0,state.objectif).toLocaleString("fr-FR")}€*  /  ${state.objectifDepart.toLocaleString("fr-FR")}€  _(${state.modeLabel})_`;

  const blocks = [];

  // ── 1. TITRE ─────────────────────────────────────────────
  blocks.push({type:"section",text:{type:"mrkdwn",text:`🚨  *COMPTEUR MONEY LISA*  🚨`}});

  // ── 2. MILESTONE ou PRESSION sous le titre ───────────────
  if (milestone) {
    blocks.push({type:"section",text:{type:"mrkdwn",text:`${milestone.emoji}  *${milestone.header}*\n_${milestone.texte}_`}});
  } else if (pression) {
    blocks.push({type:"section",text:{type:"mrkdwn",text:`⚡  *${pression.header}*\n_${pression.texte}_`}});
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
  const calcul = `*${objectifDepart.toLocaleString("fr-FR")}€*  →  *${Math.max(0,restant).toLocaleString("fr-FR")}€*  _(${state.modeLabel})_`;
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
    ?`${medals[i]}  *${s.name}* — ${s.mrr.toLocaleString("fr-FR")}€ MRR (${s.closes} close${s.closes>1?"s":""})`
    :`${medals[i]}  *${s.name}* — ${s.closes} close${s.closes>1?"s":""} (${s.mrr.toLocaleString("fr-FR")}€ MRR)`
  ).join("\n");
  return `🏆  *TOP SALES — ${periodeLabel.toUpperCase()} (${modeLabel})*\n\n${lignes}\n\n_${pick(MESSAGES_TOP_SALES_FIN)}_`;
}

// ============================================================
// MESSAGES PLANIFIÉS
// ============================================================
const MESSAGES_PLANIFIES = {
  matin:{
    lundi:[{header:"C'EST LUNDI — LA SEMAINE COMMENCE MAINTENANT 🚀",texte:"Nouveau lundi, nouvelles opportunités. Quitterie et Emmanuelle comptent sur vous. Qui ouvre le score ?"},{header:"RÉVEIL LUNDI — ON A UNE SEMAINE À GAGNER 🔥",texte:"C'est lundi les gars. Le weekend c'est fini, les closes c'est maintenant. On ouvre le bal !"}],
    mardi:[{header:"MARDI — ON EST LANCÉS, ON CONTINUE 🔥",texte:"C'est mardi et la semaine prend forme. C'est maintenant qu'on envoie la frappe pour se mettre à l'aise."},{header:"C'EST MARDI — ET L'OBJECTIF NOUS REGARDE 👀",texte:"Mardi matin. La semaine se construit maintenant. Chaque deal compte. Qui envoie la frappe ce matin ?"}],
    mercredi:[{header:"MERCREDI — MILIEU DE SEMAINE, PIVOT POINT ⚡",texte:"On est au milieu de la semaine les gars. C'est maintenant qu'on voit si on est dans les clous. Tout le monde pousse !"},{header:"HUMP DAY — C'EST MAINTENANT QU'ON BASCULE 🔥",texte:"Mercredi. Le pivot de la semaine. Ce qui se passe aujourd'hui définit la fin de semaine. Envoyez la frappe !"}],
    jeudi:[{header:"JEUDI — L'AFTERWORK AU 7 ÇA SE MÉRITE 🍺🔥",texte:"C'est jeudi les gars. L'afterwork au 7 ce soir ça se mérite avec des closes. Qui est chaud pour ouvrir ce matin ?"},{header:"JEUDI — LE 7 VOUS ATTEND SI VOUS CLOSEZ 🍺😤",texte:"Jeudi matin. Le 7 ce soir c'est pour ceux qui ont mis les bouchées doubles aujourd'hui. Qui est dans cette catégorie ?"}],
    vendredi:[{header:"VENDREDI — LE WEEKEND SE MÉRITE 🔥",texte:"C'est vendredi les gars ! Dernière ligne droite de la semaine. On finit fort et on mérite notre weekend. Allez !"},{header:"DERNIER JOUR — FINISSONS LA SEMAINE EN BEAUTÉ 💪",texte:"Vendredi matin. La semaine se termine aujourd'hui. C'est le moment de tout donner pour finir sur une belle note."}],
  },
  finMatinee:{
    lundi:[{header:"11H30 LUNDI — ON EST BIEN PARTIS ? 👀",texte:"Milieu de matinée du lundi. Le compteur doit commencer à chauffer. Qui a déjà envoyé de la frappe ce matin ?"}],
    mardi:[{header:"MARDI 11H30 — C'EST BIENTÔT LE WEEKEND... DANS 3 JOURS 😅🔥",texte:"C'est mardi, le weekend c'est vendredi. Mais entre les deux y'a des deals à closer. Allez les cracks !"}],
    mercredi:[{header:"MERCREDI 11H30 — ON EST AU COEUR DE LA SEMAINE ⚡",texte:"Milieu de semaine, milieu de matinée. Double pivot. C'est le bon moment pour envoyer la frappe les gars !"}],
    jeudi:[{header:"JEUDI 11H30 — LE 7 CE SOIR C'EST POUR LES CLOSERS 🍺😤",texte:"11h30 jeudi. L'afterwork au 7 se mérite deal par deal. Qui est en train de se l'offrir là ?"}],
    vendredi:[{header:"VENDREDI 11H30 — LE BRELAN S'APPROCHE 🍺🔥",texte:"11h30 vendredi. Le Brelan ce soir c'est pour ceux qui closent maintenant. Qui est chaud ?"}],
  },
  apresLunch:{
    lundi:[{header:"LUNDI APRÈM — ON REPART DE PLUS BELLE 🚀",texte:"Le déj c'est fini. Le lundi aprèm commence. C'est maintenant qu'on met le turbo sur la semaine !"}],
    mardi:[{header:"MARDI APRÈM — C'EST MAINTENANT QU'ON ENVOIE 💪",texte:"14h mardi. La semaine est encore longue mais l'aprèm c'est maintenant. Closes du 🍑 en série !"}],
    mercredi:[{header:"MERCREDI APRÈM — PIVOT TOTAL 🔥",texte:"14h mercredi. Milieu de semaine milieu de journée. C'est LE moment charnière. Tout le monde pousse !"}],
    jeudi:[{header:"JEUDI APRÈM — LE 7 SE MÉRITE MAINTENANT 🍺🔥",texte:"14h jeudi. L'afterwork au 7 se gagne deal par deal. C'est maintenant qu'on le mérite. Allez !"}],
    vendredi:[{header:"VENDREDI APRÈM — LE BRELAN VOUS ATTEND 🍺😤",texte:"14h vendredi. Le Brelan ce soir c'est pour ceux qui closent maintenant. Qui est dans la course ?"}],
  },
  soir:{
    lundi:[{header:"FIN DE JOURNÉE LUNDI — ON FAIT LE BILAN 📊",texte:"17h30 lundi. Le premier jour de la semaine se termine. Demain on remet le couvert !"}],
    mardi:[{header:"MARDI SOIR — C'EST BIENTÔT LE WEEKEND... ENFIN PRESQUE 😅",texte:"17h30 mardi. Encore 3 jours. Mais aujourd'hui c'est dans la boîte. Demain on repart encore plus fort !"}],
    mercredi:[{header:"MERCREDI SOIR — LE CAP EST PASSÉ 🏆",texte:"17h30 mercredi. La moitié de la semaine est derrière nous. Les deux derniers jours vont être décisifs !"}],
    jeudi:[{header:"JEUDI SOIR — L'AFTERWORK AU 7 SE MÉRITE 🍺🔥",texte:"17h30 jeudi. L'afterwork au 7 ce soir c'est pour ceux qui ont tout donné aujourd'hui. Vous y étiez ?"}],
    vendredi:[{header:"VENDREDI 17H30 — DERNIER PUSH AVANT LE BRELAN 🍺🔥",texte:"17h30 vendredi. Tout ceux qui closent avant 18h30 je leur paye un verre au Brelan. C'est dit, c'est promis. Allez !"},{header:"DERNIER PUSH DU VENDREDI — LE BRELAN VOUS ATTEND 🍺💪",texte:"Plus qu'une heure. Chaque close avant 18h30 = un verre au Brelan offert. Qui est chaud pour finir en beauté ?"}],
  },
  cloture:{
    lundi:[{header:"BONNE SOIRÉE — À DEMAIN POUR LE ROUND 2 🙌",texte:"18h30 lundi. La journée est terminée. On rentre et on revient demain encore plus forts !"}],
    mardi:[{header:"MARDI TERMINÉ — À DEMAIN LES MONSTRES 💪",texte:"18h30 mardi. Encore deux jours et demi. On rentre et demain on remet le couvert !"}],
    mercredi:[{header:"MERCREDI BOUCLÉ — LA DESCENTE VERS LE WEEKEND COMMENCE 🔥",texte:"18h30 mercredi. Le plus dur est derrière vous. Deux jours pour finir fort. À demain les cracks !"}],
    jeudi:[{header:"JEUDI TERMINÉ — DEMAIN C'EST LE GRAND FINAL 🏆",texte:"18h30 jeudi. Demain c'est vendredi. On arrive frais et on finit en beauté !"}],
    vendredi:[{header:"BON WEEKEND LES GARS — VOUS L'AVEZ MÉRITÉ 🎉🍺",texte:"18h30 vendredi. La semaine est terminée. Profitez bien du weekend, vous avez bossé dur. À lundi !"},{header:"WEEKEND — RECHARGEZ LES BATTERIES 🔋🙌",texte:"C'est fini pour cette semaine. Quitterie, Emmanuelle et Philippe sont fiers. Bon weekend les monstres !"}],
  },
};

const JOURS = ["dimanche","lundi","mardi","mercredi","jeudi","vendredi","samedi"];

function demarrerPlanificateur(client) {
  setInterval(async () => {
    const now=new Date(), h=now.getHours(), m=now.getMinutes(), jour=now.getDay();
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
    await client.chat.postMessage({
      channel:`#${CANAL_SORTIE}`, text:msg.header,
      blocks:[
        {type:"section",text:{type:"mrkdwn",text:`⏰  *${msg.header}*\n_${msg.texte}_`}},
        {type:"divider"},
        {type:"section",text:{type:"mrkdwn",text:`🚨  *COMPTEUR MONEY LISA*  🚨`}},
        {type:"section",text:{type:"mrkdwn",text:barreProgression(state.objectifDepart,state.objectif)}},
        {type:"section",text:{type:"mrkdwn",text:`*${Math.max(0,state.objectif).toLocaleString("fr-FR")}€* restants sur *${state.objectifDepart.toLocaleString("fr-FR")}€*`}},
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
        const calcul = `*${state.objectifDepart.toLocaleString("fr-FR")}€*  →  *${Math.max(0,state.objectif).toLocaleString("fr-FR")}€*  /  ${state.objectifDepart.toLocaleString("fr-FR")}€  _(${state.modeLabel})_`;
        const blocks = [];
        blocks.push({type:"section",text:{type:"mrkdwn",text:`🚨  *COMPTEUR MONEY LISA*  🚨`}});
        if (milestone) {
          blocks.push({type:"section",text:{type:"mrkdwn",text:`${milestone.emoji}  *${milestone.header}*\n_${milestone.texte}_`}});
        } else if (pression) {
          blocks.push({type:"section",text:{type:"mrkdwn",text:`⚡  *${pression.header}*\n_${pression.texte}_`}});
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
    sauvegarderState(state);
    const milestone=verifierMilestone(state.objectifDepart,state.objectif);
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
  const texte=event.text, tl=texte.toLowerCase();
  console.log("🔔 Mention :",texte);

  if (/top\s*sal[e|s]?|top\s*vent|meilleur|classement|ranking/i.test(tl)) {
    await say(formaterTopSales(calculerTopSales(detecterPeriodeTopSales(tl),detecterModeTopSales(tl)),detecterPeriodeTopSales(tl),detecterModeTopSales(tl)));
    return;
  }

  if (/switch|change|changer|passer|basculer|switcher|swithc|chnage|chagne/i.test(tl)) {
    state.modeLabel=detecterPeriode(texte);
    sauvegarderState(state);
    await say(`🔄 Période changée : *${state.modeLabel}*\nL'objectif reste à *${state.objectif.toLocaleString("fr-FR")}€* et le buffer est conservé (${state.buffer.length}/3).`);
    return;
  }

  const mObj=texte.match(/(?:objectif|obj|objctif|obejctif|objetcif|ojbectif|objecti|obectif)\s*(.*)/i);
  if (mObj) {
    const reste=mObj[1].trim();
    const nouvel=extraireObjectif(reste);
    if (!nouvel||isNaN(nouvel)){await say(`❌ Montant non reconnu. Ex : \`@Money Lisa objectif 9k pour la semaine\``);return;}
    const periode=detecterPeriode(reste);
    state.objectifDepart=nouvel;state.objectif=nouvel;state.modeLabel=periode;
    state.buffer=[];state.milestonesVus=[];state.tsDejaComptes=[];state.montantsComptes={};
    sauvegarderState(state);
    await say(`🎯 L'objectif pour *${periode}* est fixé à *${nouvel.toLocaleString("fr-FR")}€*`);
    return;
  }

  const mAdd=tl.match(/(?:add|ajoute[rz]?|rajoute[rz]?|ajout|rajout|mets?|mettre)\s*[àaáâäde@\s]?\s*([\d,.\s]+k?)/i);
  if (mAdd) {
    const ajout=extraireObjectif(mAdd[1].trim());
    if (!ajout||isNaN(ajout)){await say(`❌ Montant non reconnu.`);return;}
    const ancien=state.objectifDepart;
    state.objectifDepart+=ajout;state.objectif+=ajout;
    sauvegarderState(state);
    await say(`➕ *${ajout.toLocaleString("fr-FR")}€* ajoutés — nouvel objectif : *${state.objectifDepart.toLocaleString("fr-FR")}€* _(était ${ancien.toLocaleString("fr-FR")}€)_`);
    return;
  }

  const mRem=tl.match(/(?:remove|rmv|supprime[rz]?|retire[rz]?|efface[rz]?|annule[rz]?|vire[rz]?|déduis|deduis|soustrai[st]|soustraire)\s*[àaáâäde@\s]?\s*([\d,.\s]+k?)/i);
  if (mRem) {
    const montant=extraireObjectif(mRem[1].trim());
    if (!montant||isNaN(montant)){await say(`❌ Montant non reconnu.`);return;}
    const ancien=state.objectif;
    state.objectif+=montant;state.objectifDepart+=montant;
    sauvegarderState(state);
    await say(`↩️ *${montant.toLocaleString("fr-FR")}€* retirés — objectif ajusté : *${state.objectif.toLocaleString("fr-FR")}€* _(était ${ancien.toLocaleString("fr-FR")}€)_`);
    return;
  }

  if (/statut|status|reste|stat|bilan|avancement|ou en est|où en est/i.test(tl)) {
    await envoyerStatut(event.channel, app.client);
    return;
  }

  if (/reset|reinit|vider|raz/i.test(tl)) {
    state.buffer=[];sauvegarderState(state);
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