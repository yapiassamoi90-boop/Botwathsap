import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import pino from 'pino';
import express from 'express';
import cron from 'node-cron';
import { GoogleGenerativeAI } from '@google/generative-ai';
import admin from 'firebase-admin';
import { readFileSync, existsSync } from 'fs';

const app = express();
const PORT = process.env.PORT || 3000;

let currentQrImage = null;
let isConnected = false;
let sockInstance = null;

const ID_GROUPE_WHATSAPP = "22567647800-1546850208@g.us";

// --- FIREBASE ---
if (!admin.apps.length) {
    try {
        const secretPath = '/etc/secrets/serviceAccountKey.json';
        if (existsSync(secretPath)) {
            const serviceAccount = JSON.parse(readFileSync(secretPath, 'utf8'));
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            console.log("✅ Firebase OK (via Secret File Render)");
        } else if (existsSync('./serviceAccountKey.json')) {
            const serviceAccount = JSON.parse(readFileSync('./serviceAccountKey.json', 'utf8'));
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            console.log("✅ Firebase OK (local)");
        }
    } catch (e) { console.error("⚠ Firebase error:", e.message); }
}
const db = admin.apps.length ? admin.firestore() : null;

// --- GEMINI ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const systemInstruction = `
Tu es Hbot1, un assistant intelligent, bienveillant, drôle et polyvalent, créé pour le groupe de l'Église Assemblées de Dieu - Temple de la Restauration Divine, mais tu sais parler de TOUT.

REGLES:
1. Tu peux parler de TOUT : vie quotidienne, école, travail, amour, science, tech, humour, blagues, conseils, sport, cuisine, études, etc. Tu n'es PAS limité à la religion.
2. Si on te demande une blague, raconte une bonne blague drôle et propre avec des émojis !
3. Si une question spirituelle ou biblique est posée -> réponds avec un verset et un encouragement chrétien.
4. Si un autre sujet est abordé -> réponds normalement comme un assistant généraliste intelligent et utile.
5. Reste toujours respectueux, sans jugement, comme un grand frère proche des jeunes.
6. Parle en français simple, naturel, avec des emojis utiles.
`;

// Serveur Web
app.get('/', async (req, res) => {
  if (isConnected) {
    return res.send(`
      <div style="text-align:center; font-family:sans-serif; padding-top:50px;">
        <h1 style="color:green;">✅ Hbot1 Connecté et Opérationnel !</h1>
        <p>Le bot WhatsApp gère le programme, les cotisations, les veillées et l'IA Gemini avec succès.</p>
      </div>
    `);
  }

  if (currentQrImage) {
    return res.send(`
      <div style="text-align:center; font-family:sans-serif; padding-top:30px;">
        <h2>📱 Scannez ce QR Code avec WhatsApp</h2>
        <img src="${currentQrImage}" alt="QR Code WhatsApp" style="border: 10px solid white; box-shadow: 0 0 10px rgba(0,0,0,0.1); width: 280px;" />
        <p><i>Rafraîchissez la page si le QR code expire.</i></p>
      </div>
    `);
  }

  res.send(`
    <div style="text-align:center; font-family:sans-serif; padding-top:50px;">
      <h2>⏳ Génération du QR Code en cours...</h2>
      <p>Veuillez rafraîchir la page dans quelques secondes.</p>
    </div>
  `);
});

app.listen(PORT, () => {
  console.log(`🌍 Serveur Web actif sur le port ${PORT}`);
});

// ==========================================
// 🤖 PROGRAMME DE L'ÉGLISE & COTISATIONS
// ==========================================
let texteProgrammeMois = `⛪ *ÉGLISE DES ASSEMBLÉES DE DIEU - TEMPLE DE LA RESTAURATION DIVINE*

📅 *PROGRAMME DE SEPTEMBRE 2026*
• *06/09/26* : Adoration: Anne | Célébration: Mme M'Bro | 1ère & 2e Offrande: Mme Diby
• *13/09/26* : Adoration: Nancy | Célébration: Bérénice | 1ère & 2e Offrande: Evodie
• *20/09/26* : Adoration: Mme M'Bro | Célébration: Anne | 1ère & 2e Offrande: Joanne
• *27/09/26* : Adoration: Mme Assamoi | Célébration: Nancy | 1ère & 2e Offrande: Anne

📅 *PROGRAMME D'OCTOBRE 2026*
• *04/10/26* : Adoration: Evodie | Célébration: Mme M'Bro | 2e Offrande: Nancy
• *11/10/26* : Adoration: Bérénice | Célébration: Mme Diallo | 2e Offrande: Marie-Ange
• *18/10/26* : Adoration: Joanne | Célébration: Nancy | 2e Offrande: Evodie
• *25/10/26* : Adoration: Ange/Marina | Célébration: Bérénice | 2e Offrande: Mme M'Bro`;

function getProgrammeDuDimanche() {
  const aujourdHui = new Date();
  const jour = String(aujourdHui.getDate()).padStart(2, '0');
  const mois = String(aujourdHui.getMonth() + 1).padStart(2, '0');
  const annee = String(aujourdHui.getFullYear()).slice(-2);
  const dateStr = `${jour}/${mois}/${annee}`;

  const lignes = texteProgrammeMois.split('\n');
  const ligneTrouvee = lignes.find(ligne => ligne.includes(dateStr));

  if (ligneTrouvee) {
    return `🗓️ *PROGRAMME DE CE DIMANCHE (${dateStr})* ⛪\n\n${ligneTrouvee}\n\nQue Dieu vous bénisse ! 🙏`;
  }

  return `⛪ *PROGRAMME ACTUEL* 📅\n\n${texteProgrammeMois}`;
}

async function getCotisationsReport() {
    if (!db) return "❌ Firebase non disponible pour le moment.";
    try {
        const snap = await db.collection("transactions").orderBy("timestamp", "desc").limit(5).get();
        if (snap.empty) return `🟢 Aucun paiement récent enregistré.\n\n💡 Rappel : Cotisation 100F chaque dimanche pour le studio & l'agapé.`;
        let out = `📊 *DERNIERS PAIEMENTS COTISATIONS* 🪙\n\n`;
        snap.forEach(d => {
            const x = d.data();
            const name = x.name || x.memberName || "Membre";
            const amount = x.amount || x.montant || "500";
            const dt = x.timestamp?.toDate ? x.timestamp.toDate() : new Date(x.timestamp || Date.now());
            out += `✅ *${name}* : +${amount} FCFA _(${dt.toLocaleString('fr-FR')})_\n`;
        });
        return out + "\n💡 Merci pour votre fidélité ! 🙏✨";
    } catch (e) { return `❌ Erreur Firebase: ${e.message}`; }
}

const cotisationsMessage = `💰 *RAPPEL COTISATION* 🎵\n\n🪙 100 FCFA chaque dimanche pour le studio & l'agapé !\n👔 Prenons soin de nos uniformes et de notre groupe.\n🤝 Demeurons unis !\n\nTape !cotisation pour voir les paiements.\n*Psaumes 133:1* 🙏`;

// Fonction pour détecter si c'est le 1er ou le dernier vendredi du mois (les 2 veillées)
function isFirstOrLastFriday(date) {
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    return date.getDate() <= 7 || date.getDate() > lastDay - 7;
}

// ==========================================
// ⏰ PLANIFICATIONS AUTOMATIQUES (CRON)
// ==========================================

// 1. Verset biblique du matin (Tous les jours à 06h30)
async function envoyerVersetMatinal() {
  if (!isConnected || !sockInstance) return;
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const prompt = "Génère un court verset biblique inspirant du jour suivi d'un très bref encouragement (max 4 lignes) pour bien commencer la journée.";
    const result = await model.generateContent(prompt);
    const versetMsg = `🌅 *MÉDITATION DU MATIN* ☀️\n\n${result.response.text()}\n\nExcellente journée à tous ! 🙏✨`;
    
    await sockInstance.sendMessage(ID_GROUPE_WHATSAPP, { text: versetMsg });
    console.log("✅ Verset matinal envoyé !");
  } catch (err) { console.error("❌ Erreur verset matinal :", err); }
}
cron.schedule('30 6 * * *', () => { envoyerVersetMatinal(); }, { timezone: "Africa/Abidjan" });

// 2. Rappel des veillées de répétition (Les vendredis à 14h00, uniquement si c'est le 1er ou le dernier vendredi du mois)
async function envoyerRappelVeillee() {
  if (!isConnected || !sockInstance) return;
  if (isFirstOrLastFriday(new Date())) {
    const msgVeillee = `🌙 *RAPPEL VEILLÉE RÉPÉTITION CE SOIR!* 🎵\n\nVenez nombreux préparer nos cœurs et nos chants pour la gloire de Dieu ! 🙏✨`;
    try {
      await sockInstance.sendMessage(ID_GROUPE_WHATSAPP, { text: msgVeillee });
      console.log("✅ Rappel de veillée envoyé !");
    } catch (err) { console.error("❌ Erreur rappel veillée :", err); }
  }
}
cron.schedule('0 14 * * 5', () => { envoyerRappelVeillee(); }, { timezone: "Africa/Abidjan" });

// 3. Rappel du programme du week-end (Les vendredis et samedis à 14h00)
async function envoyerRappelProgramme() {
  if (!isConnected || !sockInstance) return;
  const messageRappel = `🔔 *PROGRAMME WEEK-END* ⛪\n\n${getProgrammeDuDimanche()}`;
  try {
    await sockInstance.sendMessage(ID_GROUPE_WHATSAPP, { text: messageRappel });
    console.log("✅ Rappel programme envoyé !");
  } catch (err) { console.error("❌ Erreur rappel programme :", err); }
}
cron.schedule('0 14 * * 5,6', () => { envoyerRappelProgramme(); }, { timezone: "Africa/Abidjan" });

// 4. Rappels cotisations (Samedis à 16h00 et Dimanches à 11h30)
cron.schedule('0 16 * * 6', async () => { 
  if (isConnected && sockInstance) await sockInstance.sendMessage(ID_GROUPE_WHATSAPP, { text: cotisationsMessage }); 
}, { timezone: "Africa/Abidjan" });

cron.schedule('30 11 * * 0', async () => { 
  if (isConnected && sockInstance) await sockInstance.sendMessage(ID_GROUPE_WHATSAPP, { text: cotisationsMessage }); 
}, { timezone: "Africa/Abidjan" });

// ==========================================
// 🤖 CONNEXION WHATSAPP & MESSAGES
// ==========================================
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' })
  });

  sockInstance = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try { currentQrImage = await QRCode.toDataURL(qr); } catch (err) {}
    }

    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect =
        (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) connectToWhatsApp();
    } else if (connection === 'open') {
      isConnected = true;
      currentQrImage = null;
      console.log('✅ Hbot1 connecté avec succès !');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue;

      const remoteJid = msg.key.remoteJid;
      const isGroup = remoteJid.endsWith('@g.us');
      const sender = msg.key.participant || msg.key.remoteJid;

      const textMessage =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '';

      const lowerText = textMessage.trim().toLowerCase();
      if (!textMessage) continue;

      // 1. Commande ID
      if (lowerText === '!id') {
        await sock.sendMessage(remoteJid, { text: `L'ID de cette discussion est :\n\`${remoteJid}\`` }, { quoted: msg });
        continue;
      }

      // 2. Commande Aide / Présentation
      if (lowerText.includes('qui est hbot') || lowerText === 'hbot' || lowerText === '!help' || lowerText === '!aide') {
        const help = `🤖 *Je suis Hbot1, ton grand frère assistant!*

Je peux parler de TOUT avec toi:
🧠 Cours, devoirs, science, tech
❤️ Conseils vie, amour, amitié
🍛 Cuisine, sport, musique
📖 Bible, prière, versets
😂 Blagues, humour

💡 *Commandes:*
• !programme -> chantres du dimanche / planning
• !cotisation -> voir les derniers paiements
• !id -> voir l'ID du groupe

Pose-moi n'importe quelle question, je suis là! 🙏✨`;
        await sock.sendMessage(remoteJid, { text: help }, { quoted: msg });
        continue;
      }

      // 3. Commande Cotisation
      if (lowerText === '!cotisation' || lowerText === '!cotisations' || lowerText === '!c') {
        await sock.presenceSubscribe(remoteJid);
        await sock.sendPresenceUpdate('composing', remoteJid);
        const report = await getCotisationsReport();
        await sock.sendMessage(remoteJid, { text: report }, { quoted: msg });
        continue;
      }

      // 4. Commandes Programme
      if (lowerText === '!programme' || lowerText === '!programme mois' || lowerText === '!p') {
        await sock.sendMessage(remoteJid, { text: getProgrammeDuDimanche() }, { quoted: msg });
        continue;
      } 
      
      if (lowerText === '!programme complet') {
        await sock.sendMessage(remoteJid, { text: texteProgrammeMois }, { quoted: msg });
        continue;
      } 
      
      if (lowerText.startsWith('!setprogramme ')) {
        if (!isGroup) continue;

        const groupMetadata = await sock.groupMetadata(remoteJid);
        const senderIsAdmin = groupMetadata.participants.some(
          (p) => p.id === sender && (p.admin === 'admin' || p.admin === 'superadmin')
        );

        if (!senderIsAdmin) {
          await sock.sendMessage(remoteJid, { text: "❌ Seuls les administrateurs peuvent modifier le programme." }, { quoted: msg });
          continue;
        }

        texteProgrammeMois = textMessage.replace('!setprogramme ', '').trim();
        await sock.sendMessage(remoteJid, { text: "✅ Le programme du mois a été mis à jour !" }, { quoted: msg });
        continue;
      }

      // 5. INTELLIGENCE ARTIFICIELLE GEMINI (Pour discuter de tout, raconter des blagues, etc.)
      try {
        await sock.presenceSubscribe(remoteJid);
        await sock.sendPresenceUpdate('composing', remoteJid);

        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const fullPrompt = `${systemInstruction}\n\nUtilisateur dit: ${textMessage}\nRéponds de façon naturelle, utile et amicale.`;
        
        const result = await model.generateContent(fullPrompt);
        let reply = result.response.text() || "Je n'ai pas bien saisi, peux-tu reformuler ? 🙏";

        if (reply.length > 3500) reply = reply.substring(0, 3500) + "\n...";
        await sock.sendMessage(remoteJid, { text: reply }, { quoted: msg });
      } catch (err) {
        console.error("❌ Erreur Gemini :", err.message);
      }
    }
  });
}

connectToWhatsApp();
