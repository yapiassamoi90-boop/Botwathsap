0192import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import pino from 'pino';
import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

let currentQrImage = null; // Stocke l'image base64 du QR code
let isConnected = false;

// Page Web pour afficher le QR Code sous forme d'image propre
app.get('/', async (req, res) => {
  if (isConnected) {
    return res.send(`
      <div style="text-align:center; font-family:sans-serif; padding-top:50px;">
        <h1 style="color:green;">✅ Bot connecté avec succès !</h1>
        <p>Le bot WhatsApp est actif et modère vos groupes.</p>
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
// 🤖 BOT WHATSAPP
// ==========================================
const programmes = {
  mois: "📅 *Programme du mois :*\n• Semaine 1 : Réunion d'ouverture\n• Semaine 2 : Formation technique\n• Semaine 3 : Évaluation intermédiaire\n• Semaine 4 : Bilan mensuel",
  annee: "📅 *Programme Annuel 2026 :*\n• T1 : Phase de planification\n• T2 : Exécution des projets\n• T3 : Audit & Optimisation\n• T4 : Clôture & Festivités"
};

const MOTS_INTERDITS = ['insulte1', 'insulte2', 'arnaque', 'spam'];

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📱 Nouveau QR Code généré');
      qrcodeTerminal.generate(qr, { small: true });
      // Convertit le QR Code en image Data URL pour la page Web Render
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
      console.log('✅ Bot Administrateur & Modérateur connecté avec succès !');
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

      if (isGroup) {
        try {
          const groupMetadata = await sock.groupMetadata(remoteJid);
          const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
          
          const botIsAdmin = groupMetadata.participants.some(
            (p) => p.id === botId && (p.admin === 'admin' || p.admin === 'superadmin')
          );

          const senderIsAdmin = groupMetadata.participants.some(
            (p) => p.id === sender && (p.admin === 'admin' || p.admin === 'superadmin')
          );

          const containsForbiddenLink = /(chat\.whatsapp\.com\/|wa\.me\/)/i.test(textMessage);
          const containsBadWord = MOTS_INTERDITS.some((word) => lowerText.includes(word));

          if ((containsForbiddenLink || containsBadWord) && !senderIsAdmin) {
            if (botIsAdmin) await sock.sendMessage(remoteJid, { delete: msg.key });

            await sock.sendMessage(remoteJid, {
              text: `⚠️ @${sender.split('@')[0]}, votre message enfreint les règles du groupe.`,
              mentions: [sender]
            });

            if (containsBadWord && botIsAdmin) {
              await sock.sendMessage(remoteJid, {
                text: `🚫 Expulsion de @${sender.split('@')[0]} pour non-respect des règles.`,
                mentions: [sender]
              });
              await sock.groupParticipantsUpdate(remoteJid, [sender], 'remove');
            }
            continue;
          }
        } catch (err) {
          console.error('Erreur lors de la modération du groupe :', err);
        }
      }

      if (lowerText === '!programme mois' || lowerText === '!programme') {
        await sock.sendMessage(remoteJid, { text: programmes.mois }, { quoted: msg });
      } else if (lowerText === '!programme annee') {
        await sock.sendMessage(remoteJid, { text: programmes.annee }, { quoted: msg });
      } else if (lowerText.startsWith('!setprogramme ')) {
        if (!isGroup) continue;

        const groupMetadata = await sock.groupMetadata(remoteJid);
        const senderIsAdmin = groupMetadata.participants.some(
          (p) => p.id === sender && (p.admin === 'admin' || p.admin === 'superadmin')
        );

        if (!senderIsAdmin) {
          await sock.sendMessage(remoteJid, {
            text: "❌ Seuls les administrateurs peuvent modifier le programme."
          }, { quoted: msg });
          continue;
        }

        const newProgram = textMessage.replace('!setprogramme ', '').trim();
        programmes.mois = `📅 *Nouveau Programme du mois :*\n\n${newProgram}`;

        await sock.sendMessage(remoteJid, { text: "✅ Le programme du mois a été mis à jour !" }, { quoted: msg });
      } else if (lowerText.startsWith('!kick') && isGroup) {
        const groupMetadata = await sock.groupMetadata(remoteJid);
        const senderIsAdmin = groupMetadata.participants.some(
          (p) => p.id === sender && (p.admin === 'admin' || p.admin === 'superadmin')
        );

        if (!senderIsAdmin) {
          await sock.sendMessage(remoteJid, { text: "❌ Vous devez être administrateur pour utiliser cette commande." });
          continue;
        }

        const mentionedJid = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
        if (mentionedJid && mentionedJid.length > 0) {
          await sock.groupParticipantsUpdate(remoteJid, [mentionedJid[0]], 'remove');
          await sock.sendMessage(remoteJid, { text: `🚪 Utilisateur expulsé avec succès.` });
        } else {
          await sock.sendMessage(remoteJid, { text: "⚠️ Veuillez mentionner la personne à expulser (ex: !kick @nom)." });
        }
      }
    }
  });
}

connectToWhatsApp();
