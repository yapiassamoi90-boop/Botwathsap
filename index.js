import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import express from 'express';

// ==========================================
// 🌐 SERVEUR HTTP POUR RENDER
// ==========================================
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('🤖 Bot WhatsApp Modérateur est actif et en cours d\'exécution !');
});

app.listen(PORT, () => {
  console.log(`🌍 Serveur HTTP à l'écoute sur le port ${PORT}`);
});

// ==========================================
// 🤖 CONFIGURATION DU BOT WHATSAPP
// ==========================================

// Base de données simplifiée pour les programmes
const programmes = {
  mois: "📅 *Programme du mois :*\n• Semaine 1 : Réunion d'ouverture\n• Semaine 2 : Formation technique\n• Semaine 3 : Évaluation intermédiaire\n• Semaine 4 : Bilan mensuel",
  annee: "📅 *Programme Annuel 2026 :*\n• T1 : Phase de planification\n• T2 : Exécution des projets\n• T3 : Audit & Optimisation\n• T4 : Clôture & Festivités"
};

// Mots interdits pour la modération
const MOTS_INTERDITS = ['insulte1', 'insulte2', 'arnaque', 'spam'];

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true // Permet d'afficher le QR Code dans les logs Render
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      console.log('📱 SCANNEZ CE QR CODE DANS VOS LOGS RENDER :');
      qrcode.generate(qr, { small: true });
    }
    
    if (connection === 'close') {
      const shouldReconnect =
        (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connexion fermée. Reconnexion en cours...', shouldReconnect);
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
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

      // ==========================================
      // 🛡️ SECTION 1 : AUTO-MODÉRATION (GROUPE)
      // ==========================================
      if (isGroup) {
        try {
          const groupMetadata = await sock.groupMetadata(remoteJid);
          const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
          
          // Vérifier si le bot est admin
          const botIsAdmin = groupMetadata.participants.some(
            (p) => p.id === botId && (p.admin === 'admin' || p.admin === 'superadmin')
          );

          // Vérifier si l'expéditeur du message est admin
          const senderIsAdmin = groupMetadata.participants.some(
            (p) => p.id === sender && (p.admin === 'admin' || p.admin === 'superadmin')
          );

          // 1. Détection de liens WhatsApp / Spam (Non-admins uniquement)
          const containsForbiddenLink = /(chat\.whatsapp\.com\/|wa\.me\/)/i.test(textMessage);
          
          // 2. Détection de mots interdits
          const containsBadWord = MOTS_INTERDITS.some((word) => lowerText.includes(word));

          if ((containsForbiddenLink || containsBadWord) && !senderIsAdmin) {
            // Supprimer le message si le bot est admin
            if (botIsAdmin) {
              await sock.sendMessage(remoteJid, { delete: msg.key });
            }

            // Avertir le groupe
            await sock.sendMessage(remoteJid, {
              text: `⚠️ @${sender.split('@')[0]}, votre message enfreint les règles du groupe.`,
              mentions: [sender]
            });

            // Expulsion si mot interdit grave
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

      // ==========================================
      // 📅 SECTION 2 : COMMANDES DU PROGRAMME
      // ==========================================

      // Afficher le programme du mois
      if (lowerText === '!programme mois' || lowerText === '!programme') {
        await sock.sendMessage(remoteJid, { text: programmes.mois }, { quoted: msg });
      }

      // Afficher le programme de l'année
      else if (lowerText === '!programme annee') {
        await sock.sendMessage(remoteJid, { text: programmes.annee }, { quoted: msg });
      }

      // Mise à jour du programme (réservé aux administrateurs)
      else if (lowerText.startsWith('!setprogramme ')) {
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

        await sock.sendMessage(remoteJid, {
          text: "✅ Le programme du mois a été mis à jour !"
        }, { quoted: msg });
      }

      // Commande manuelle d'expulsion par un admin (!kick @mention)
      else if (lowerText.startsWith('!kick') && isGroup) {
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
          const target = mentionedJid[0];
          await sock.groupParticipantsUpdate(remoteJid, [target], 'remove');
          await sock.sendMessage(remoteJid, { text: `🚪 Utilisateur expulsé avec succès.` });
        } else {
          await sock.sendMessage(remoteJid, { text: "⚠️ Veuillez mentionner la personne à expulser (ex: !kick @nom)." });
        }
      }
    }
  });
}

connectToWhatsApp();
