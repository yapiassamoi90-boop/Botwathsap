const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const cron = require('node-cron');
const QRCode = require('qrcode');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration du groupe WhatsApp
const GROUP_ID = '22567647800-1546850208@g.us';

// Initialisation de Firebase Admin
if (!admin.apps.length) {
    admin.initializeApp({
        projectId: "registre-eglise"
    });
}
const db = admin.firestore();

let qrCodeData = null;
let isConnected = false;
let sock = null;

// Versets pour la méditation matinale de 6h30
const verses = [
    { verse: "Josué 1:8", text: "Que ce livre de la loi ne s'éloigne point de ta bouche; médite-le jour et nuit, pour agir fidèlement selon tout ce qui y est écrit; car c'est alors que tu réussiras dans tes entreprises." },
    { verse: "Psaumes 119:105", text: "Ta parole est une lampe à mes pieds, Et une lumière sur mon sentier." },
    { verse: "Psaumes 23:1", text: "L'Éternel est mon berger: je ne manquerai de rien." },
    { verse: "Ésaïe 40:31", text: "Mais ceux qui s'confient en l'Éternel renouvelleront leur force; ils prennent leur vol comme les aigles; ils courront et ne se lasseront point, ils marcheront et ne s'épuiseront point." },
    { verse: "Proverbes 3:5-6", text: "Confie-toi en l'Éternel de tout ton cœur, et ne t'appuie pas sur ton intelligence; reconnais-le dans toutes tes voies, et il aplanira tes sentiers." },
    { verse: "Romains 8:28", text: "Nous savons, du reste, que toutes choses concourent au bien de ceux qui aiment Dieu, de ceux qui sont appelés selon son dessein." },
    { verse: "Philippiens 4:13", text: "Je puis tout par celui qui me fortifie." },
    { verse: "Psaumes 46:2", text: "Dieu est pour nous un refuge et un appui, Un secours qui ne manque jamais dans la détresse." }
];

// Programme mensuel
function getMonthlyProgramText() {
    return `⛪ *ÉGLISE DES ASSEMBLÉES DE DIEU - TEMPLE DE LA RESTAURATION DIVINE*

📅 *PROGRAMME DU MOIS*
• *04/10/26* : Adoration: Evodie | Célébration: Mme M'Bro | 2e Offrande: Nancy
• *11/10/26* : Adoration: Bérénice | Célébration: Mme Diallo | 2e Offrande: Marie-Ange
• *18/10/26* : Adoration: Joanne | Célébration: Nancy | 2e Offrande: Evodie
• *25/10/26* : Adoration: Ange/Marina | Célébration: Bérénice | 2e Offrande: Mme M'Bro`;
}

// Fonction pour récupérer le rapport des cotisations avec sécurité (timeout)
async function getCotisationsReport() {
    try {
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error("Timeout Firebase")), 7000)
        );

        const fetchPromise = db.collection("members").get();
        const snapshot = await Promise.race([fetchPromise, timeoutPromise]);
        
        const now = new Date();
        let paidMembers = [];
        let pendingMembers = [];

        snapshot.forEach((doc) => {
            const data = doc.data();
            const isPaid = data.paidUntil && new Date(data.paidUntil) > now;
            
            if (isPaid) {
                const dateFormatted = new Date(data.paidUntil).toLocaleDateString('fr-FR');
                paidMembers.push(`✅ *${data.name}* (jusqu'au ${dateFormatted})`);
            } else {
                pendingMembers.push(`⏳ ${data.name}`);
            }
        });

        let response = `📊 *SUIVI EN TEMPS RÉEL DES COTISATIONS* 🪙\n\n`;

        if (paidMembers.length > 0) {
            response += `🟢 *MEMBRES À JOUR (${paidMembers.length}) :*\n` + paidMembers.join('\n') + `\n\n`;
        } else {
            response += `🟢 *MEMBRES À JOUR :* Aucun pour le moment.\n\n`;
        }

        if (pendingMembers.length > 0) {
            response += `🔴 *EN ATTENTE (${pendingMembers.length}) :*\n` + pendingMembers.join('\n') + `\n\n`;
        }

        response += `💡 *Rappel :* Cotisation de 100 FCFA/semaine pour nos sorties en studio et moments d'agapé. Merci pour votre fidélité ! 🙏✨`;

        return response;
    } catch (error) {
        console.error("Erreur Firebase:", error);
        return "❌ Connexion à Firebase un peu lente, veuillez réessayer dans un instant.";
    }
}

// Message de rappel de cotisation pour le samedi et le dimanche
const cotisationsMessage = `💰 *RAPPEL IMPORTANT & ENCOURAGEMENT* 🎵

Chers membres du groupe musical,

1. 🪙 *Cotisation hebdomadaire :* N'oublions pas notre cotisation de *100 FCFA chaque dimanche*. Cet effort collectif permet de financer nos *sorties en studio* et nos *moments d'agapé* !
2. 👔 *Uniformes :* Prenons grand soin de nos tenues et uniformes du groupe afin d'honorer le Seigneur dans la présentation.
3. 🤝 *Unité :* Demeurons unis, dans l'amour et la fraternité pour le service de Dieu.

💡 *Astuce :* Tapez *!cotisation* pour voir la liste des membres à jour !

*« Qu'il est doux, qu'il est agréable pour des frères de demeurer ensemble ! »* — *Psaumes 133:1* 🙏✨`;

// Vérification du 1er et dernier vendredi du mois
function isFirstOrLastFriday(date) {
    const day = date.getDate();
    const month = date.getMonth();
    const isFirstFriday = day <= 7;
    const nextWeek = new Date(date);
    nextWeek.setDate(day + 7);
    const isLastFriday = nextWeek.getMonth() !== month;
    return isFirstFriday || isLastFriday;
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCodeData = await QRCode.toDataURL(qr);
            isConnected = false;
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            isConnected = false;
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            isConnected = true;
            qrCodeData = null;
            console.log('✅ Bot connecté à WhatsApp !');
        }
    });

    // Écoute des messages entrants
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const lowerText = textMessage.trim().toLowerCase();

        // Commande !programme
        if (lowerText === '!programme') {
            const programText = getMonthlyProgramText();
            await sock.sendMessage(remoteJid, { text: programText }, { quoted: msg });
        }

        // Commande !cotisation
        if (lowerText === '!cotisation' || lowerText === '!cotisations') {
            await sock.sendPresenceUpdate('composing', remoteJid);
            const report = await getCotisationsReport();
            await sock.sendMessage(remoteJid, { text: report }, { quoted: msg });
        }

        // Commande de présentation
        if (lowerText.includes('qui est hbot') || lowerText.includes('c\'est quoi hbot') || lowerText.includes('qui es tu hbot') || lowerText === 'hbot') {
            const presentationText = `🤖 *Bonjour ! Je suis Hbot1, l'assistant virtuel du groupe.*

📌 *Mes fonctions :*
• 📖 *Méditation matinale :* Un verset biblique chaque matin à 06h30.
• 🔔 *Rappels du week-end :* Envoi du programme les vendredis et samedis à 14h00.
• 🌙 *Veillées de répétition :* Rappel les 1er et derniers vendredis du mois à 14h00.
• 💰 *Cotisation & Unité :* Rappels les samedis à 16h00 et dimanches à 11h30.

💡 *Commandes disponibles :*
• Tapez *!programme* pour voir le planning des passages.
• Tapez *!cotisation* pour voir les membres à jour dans l'application.
• Tapez *qui est hbot* pour revoir ce message.

Que le Seigneur vous bénisse ! 🙏✨`;

            await sock.sendMessage(remoteJid, { text: presentationText }, { quoted: msg });
        }
    });
}

// TÂCHES AUTOMATIQUES (CRON JOBS)
cron.schedule('30 6 * * *', async () => {
    if (isConnected && sock) {
        const randomVerse = verses[Math.floor(Math.random() * verses.length)];
        const meditationMessage = `📖 *MÉDITATION DU MATIN* ☀️

*« ${randomVerse.text} »*
— *${randomVerse.verse}*

Que le Seigneur vous bénisse et vous guide tout au long de cette journée ! 🙏✨`;

        try {
            await sock.sendMessage(GROUP_ID, { text: meditationMessage });
            console.log('✅ Méditation envoyée à 6h30');
        } catch (err) {
            console.error('Erreur méditation:', err);
        }
    }
}, { timezone: "Africa/Abidjan" });

cron.schedule('0 14 * * 5', async () => {
    const today = new Date();
    if (isFirstOrLastFriday(today) && isConnected && sock) {
        const veilléeMessage = `🌙 *RAPPEL : VEILLÉE DE RÉPÉTITION CE SOIR !* 🎵

Chers frères et sœurs, nous vous rappelons que nous avons notre *veillée de répétition* ce soir.

Venez nombreux afin de préparer nos cœurs et nos voix pour le service du Seigneur ! 🙏🎶`;

        try {
            await sock.sendMessage(GROUP_ID, { text: veilléeMessage });
            console.log('✅ Rappel de veillée envoyé');
        } catch (err) {
            console.error('Erreur rappel veillée:', err);
        }
    }
}, { timezone: "Africa/Abidjan" });

cron.schedule('0 14 * * 5,6', async () => {
    if (isConnected && sock) {
        const programText = `🔔 *RAPPEL DU PROGRAMME DU WEEK-END* ⛪\n\n` + getMonthlyProgramText();
        try {
            await sock.sendMessage(GROUP_ID, { text: programText });
            console.log('✅ Rappel du week-end envoyé');
        } catch (err) {
            console.error('Erreur rappel programme:', err);
        }
    }
}, { timezone: "Africa/Abidjan" });

cron.schedule('0 16 * * 6', async () => {
    if (isConnected && sock) {
        try {
            await sock.sendMessage(GROUP_ID, { text: cotisationsMessage });
            console.log('✅ Rappel cotisation du samedi envoyé');
        } catch (err) {
            console.error('Erreur rappel samedi:', err);
        }
    }
}, { timezone: "Africa/Abidjan" });

cron.schedule('30 11 * * 0', async () => {
    if (isConnected && sock) {
        try {
            await sock.sendMessage(GROUP_ID, { text: cotisationsMessage });
            console.log('✅ Rappel cotisation du dimanche envoyé');
        } catch (err) {
            console.error('Erreur rappel dimanche:', err);
        }
    }
}, { timezone: "Africa/Abidjan" });

// Serveur Web
app.get('/', (req, res) => {
    if (isConnected) {
        res.send(`
            <div style="text-align:center; padding:50px; font-family:sans-serif;">
                <h1 style="color:green;">✅ Bot connecté avec succès !</h1>
                <p>Hbot1 est actif et synchronisé avec l'application de cotisation Firebase.</p>
            </div>
        `);
    } else if (qrCodeData) {
        res.send(`
            <div style="text-align:center; padding:50px; font-family:sans-serif;">
                <h1>Scannez le QR Code pour connecter le bot :</h1>
                <img src="${qrCodeData}" alt="QR Code" />
            </div>
        `);
    } else {
        res.send(`
            <div style="text-align:center; padding:50px; font-family:sans-serif;">
                <h1>Initialisation du bot en cours...</h1>
                <p>Veuillez rafraîchir la page dans quelques secondes.</p>
            </div>
        `);
    }
});

app.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
    connectToWhatsApp();
});
