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

const app = express();
const PORT = process.env.PORT || 3000;

let currentQrImage = null;
let isConnected = false;
let sockInstance = null;

const ID_GROUPE_WHATSAPP = "22567647800-1546850208@g.us";

// --- CONFIGURATION GEMINI ---
// Utilise la clé API configurée dans tes variables d'environnement sur Render
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const systemInstruction = `
Tu es Hbot1, un assistant intelligent, bienveillant, drôle et polyvalent, créé pour le groupe de l'Église Assemblées de Dieu - Temple de la Restauration Divine, mais tu sais parler de TOUT.

REGLES:
1. Tu peux parler de TOUT : vie quotidienne, école, travail, amour, science, tech, humour, conseils, sport, cuisine, études, etc. Tu n'es PAS limité à la religion.
2. Si une question spirituelle ou biblique est posée -> réponds avec un verset et un encouragement chrétien.
3. Si un autre sujet est abordé -> réponds normalement comme un assistant généraliste intelligent et utile.
4. Reste toujours respectueux, sans jugement, comme un grand frère proche des jeunes.
5. Parle en français simple, naturel, avec des emojis utiles.
`;

// Serveur Web
app.get('/', async (req, res) => {
  if (isConnected) {
    return res.send(`
      <div style="text-align:center; font-family:sans-serif; padding-top:50px;">
        <h1 style="color:green;">✅ Hbot1 Connecté et Opérationnel !</h1>
        <p>Le bot WhatsApp gère le programme et l'IA Gemini avec succès.</p>
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
// 🤖 PROGRAMME DE L'ÉGLISE
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

// Fonction intelligente pour trouver le programme du dimanche en cours
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

  return `⛪ *PROGRAMME ACTUEL (Aucun événement spécifique repéré aujourd'hui)* 📅\n\n${texteProgrammeMois}`;
}

// Fonction pour envoyer le rappel automatique
async function envoyerRappelProgramme() {
  if (!isConnected || !sockInstance) {
    console.log("⚠️ Impossible d'envoyer le rappel : le bot n'est pas connecté.");
    return;
  }

  if (ID_GROUPE_WHATSAPP === "VOTRE_ID_DE_GROUPE_ICI@g.us") {
    console.log("⚠️ Veuillez configurer l'ID de votre groupe WhatsApp dans index.js.");
    return;
  }

  const messageRappel = `📢 *RAPPEL DU PROGRAMME DE CE DIMANCHE* 📢\n\n${getProgrammeDuDimanche()}`;

  try {
    await sockInstance.sendMessage(ID_GROUPE_WHATSAPP, { text: messageRappel });
    console.log("✅ Rappel de programme envoyé au groupe avec succès !");
  } catch (err) {
    console.error("❌ Erreur lors de l'envoi du rappel :", err);
  }
}

// ⏰ PLANIFICATION (CRON)
cron.schedule('0 14 * * 5', () => {
  console.log('⏰ Exécution du rappel du vendredi 14h');
  envoyerRappelProgramme();
}, { timezone: "Africa/Abidjan" });

cron.schedule('0 14 * * 6', () => {
  console.log('⏰ Exécution du samedi 14h');
  envoyerRappelProgramme();
}, { timezone: "Africa/Abidjan" });

// ==========================================
// 🤖 CONNEXION WHATSAPP & GESTION DES MESSAGES
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
      console.log('📱 Nouveau QR Code généré.');
      try {
        currentQrImage = await QRCode.toDataURL(qr);
      } catch (err) {
        console.error('Erreur génération QR image :', err);
      }
    }

    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect =
        (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) connectToWhatsApp();
    } else if (connection === 'open') {
      isConnected = true;
      currentQrImage = null;
      console.log('✅ Bot connecté avec succès !');
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

      // 1. Commande pour afficher l'ID du groupe
      if (lowerText === '!id') {
        await sock.sendMessage(remoteJid, { text: `L'ID de cette discussion est :\n\`${remoteJid}\`` }, { quoted: msg });
        continue;
      }

      // 2. Commande de présentation Hbot1
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
• !programme complet -> tout le mois
• !id -> voir l'ID du groupe

Pose-moi n'importe quelle question, je suis là! 🙏✨`;
        await sock.sendMessage(remoteJid, { text: help }, { quoted: msg });
        continue;
      }

      // 3. Commandes de consultation et de modification du programme
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

      // 4. INTELLIGENCE ARTIFICIELLE GEMINI (Répond à tout le reste si on le sollicite)
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
        // On ne bloque pas le bot si l'IA rencontre un petit souci technique passager
      }
    }
  });
}

connectToWhatsApp();
