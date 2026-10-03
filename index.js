const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const cron = require('node-cron');
const QRCode = require('qrcode');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const GROUP_ID = '22567647800-1546850208@g.us';

// --- FIREBASE ---
if (!admin.apps.length) {
    try {
        if (process.env.FIREBASE_PRIVATE_KEY) {
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId: process.env.FIREBASE_PROJECT_ID || "registre-eglise",
                    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
                })
            });
        } else {
            admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccountKey.json')) });
        }
        console.log("✅ Firebase OK");
    } catch (e) { console.error("⚠️ Firebase error:", e.message); }
}
const db = admin.apps.length? admin.firestore() : null;

// --- GEMINI ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const systemInstruction = `
Tu es Hbot1, assistant intelligent, bienveillant et polyvalent créé pour le groupe musical de l'Église Assemblées de Dieu - Temple de la Restauration Divine, mais tu sais parler de TOUT.

REGLES:
1. Tu peux parler de TOUT : vie quotidienne, école, travail, amour, science, tech, humour, conseils, sport, cuisine, drague, études, etc. Tu n'es PAS limité à la religion.
2. Si question spirituelle/biblique -> réponds avec verset et encouragement chrétien.
3. Si autre sujet -> réponds normalement comme un assistant généraliste intelligent, utile, drôle si besoin.
4. Reste toujours respectueux, sans jugement.
5. Parle en français simple, avec emojis utiles.
6. Tu t'appelles Hbot1, sympa, proche des jeunes, comme un grand frère.
7. Ne dis jamais que tu es limité.
`;

let qrCodeData = null;
let isConnected = false;
let sock = null;

const verses = [
    { verse: "Josué 1:8", text: "Que ce livre de la loi ne s'éloigne point de ta bouche; médite-le jour et nuit..." },
    { verse: "Psaumes 119:105", text: "Ta parole est une lampe à mes pieds, Et une lumière sur mon sentier." },
    { verse: "Psaumes 23:1", text: "L'Éternel est mon berger: je ne manquerai de rien." },
    { verse: "Ésaïe 40:31", text: "Ceux qui se confient en l'Éternel renouvelleront leur force; ils prennent leur vol comme les aigles." },
    { verse: "Proverbes 3:5-6", text: "Confie-toi en l'Éternel de tout ton cœur, et ne t'appuie pas sur ton intelligence." },
    { verse: "Romains 8:28", text: "Toutes choses concourent au bien de ceux qui aiment Dieu." },
    { verse: "Philippiens 4:13", text: "Je puis tout par celui qui me fortifie." },
    { verse: "Psaumes 46:2", text: "Dieu est pour nous un refuge et un appui, Un secours qui ne manque jamais." }
];

function getMonthlyProgramText() {
    return `⛪ *ÉGLISE AD - TEMPLE RESTAURATION*\n\n📅 *PROGRAMME DU MOIS*\n• *04/10/26* : Adoration: Evodie | Célébration: Mme M'Bro | 2e Offrande: Nancy\n• *11/10/26* : Adoration: Bérénice | Célébration: Mme Diallo | 2e Offrande: Marie-Ange\n• *18/10/26* : Adoration: Joanne | Célébration: Nancy | 2e Offrande: Evodie\n• *25/10/26* : Adoration: Ange/Marina | Célébration: Bérénice | 2e Offrande: Mme M'Bro`;
}

async function getCotisationsReport() {
    if (!db) return "❌ Firebase non disponible.";
    try {
        const snap = await db.collection("transactions").orderBy("timestamp", "desc").limit(5).get();
        if (snap.empty) return `🟢 Aucun paiement récent.\n\n💡 Cotisation 100F chaque dimanche pour studio & agapé.`;
        let out = `📊 *DERNIERS PAIEMENTS* 🪙\n\n`;
        snap.forEach(d => {
            const x = d.data();
            const name = x.name || x.memberName || "Membre";
            const amount = x.amount || x.montant || "500";
            const dt = x.timestamp?.toDate? x.timestamp.toDate() : new Date(x.timestamp || Date.now());
            out += `✅ *${name}* : +${amount} FCFA _(${dt.toLocaleString('fr-FR')})_\n`;
        });
        return out + "\n💡 Merci pour votre fidélité! 🙏✨";
    } catch (e) { return `❌ Erreur Firebase: ${e.message}`; }
}

const cotisationsMessage = `💰 *RAPPEL COTISATION* 🎵\n\n🪙 100 FCFA chaque dimanche pour studio & agapé!\n👔 Prenons soin de nos uniformes.\n🤝 Demeurons unis!\n\nTape!cotisation pour voir les paiements.\n*Psaumes 133:1* 🙏`;

function isFirstOrLastFriday(date) {
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    return date.getDate() <= 7 || date.getDate() > lastDay - 7;
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    sock = makeWASocket({ auth: state, printQRInTerminal: false });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) { qrCodeData = await QRCode.toDataURL(qr); isConnected = false; }
        if (connection === 'close') {
            isConnected = false;
            if (lastDisconnect?.error?.output?.statusCode!== DisconnectReason.loggedOut) connectToWhatsApp();
        } else if (connection === 'open') { isConnected = true; qrCodeData = null; console.log('✅ Bot connecté!'); }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const jid = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const low = text.toLowerCase();
        if (!text) return;

        // COMMANDES
        if (low === '!programme' || low === '!p') {
            await sock.sendMessage(jid, { text: getMonthlyProgramText() }, { quoted: msg }); return;
        }
        if (low === '!cotisation' || low === '!cotisations' || low === '!c') {
            await sock.sendPresenceUpdate('composing', jid);
            const r = await getCotisationsReport();
            await sock.sendMessage(jid, { text: r }, { quoted: msg }); return;
        }
        if (low === '!verset' || low === '!verse' || low === '!v') {
            const v = verses[Math.floor(Math.random() * verses.length)];
            await sock.sendMessage(jid, { text: `📖 *VERSET DU JOUR* ☀️\n\n*« ${v.text} »*\n— *${v.verse}* 🙏✨` }, { quoted: msg }); return;
        }
        if (low === '!id' || low === '!groupid' || low === '!jid' || low === '!lid') {
            const isGroup = jid.endsWith('@g.us');
            let groupInfo = null;
            try { if (isGroup) groupInfo = await sock.groupMetadata(jid); } catch {}
            let txt = `🆔 *INFOS ID*\n\n📍 *ID de ce chat:*\n\`${jid}\`\n\n👤 *Ton ID:*\n\`${msg.key.participant || jid}\`\n\n`;
            if (isGroup) txt += `👥 *Nom:* ${groupInfo?.subject || 'Groupe'}\n👥 *Membres:* ${groupInfo?.participants?.length || '?'}\n\n💡 Copie l'ID du haut et mets le dans GROUP_ID dans ton code.`;
            else txt += `💬 Chat privé`;
            await sock.sendMessage(jid, { text: txt }, { quoted: msg }); return;
        }
        if (low.includes('qui est hbot') || low === 'hbot' || low === '!help' || low === '!aide') {
            const help = `🤖 *Je suis Hbot1, ton grand frère assistant!*

Je peux parler de TOUT avec toi:
🧠 Cours, devoirs, science, tech
❤️ Conseils vie, amour, amitié
🍛 Cuisine, sport, musique
📖 Bible, prière, versets
😂 Blagues, humour

💡 *Commandes:*
•!programme -> planning église
•!cotisation -> derniers paiements
•!verset -> verset aléatoire
•!id -> voir l'ID du groupe

Pose moi n'importe quelle question, je suis là! 🙏✨`;
            await sock.sendMessage(jid, { text: help }, { quoted: msg }); return;
        }

        // IA - PARLE DE TOUT
        try {
            await sock.sendPresenceUpdate('composing', jid);
            const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash', systemInstruction });
            const chat = model.startChat({ history: [] });
            const result = await chat.sendMessage(text);
            let reply = result.response.text() || "Je n'ai pas compris, reformule 🙏";
            if (reply.length > 3500) reply = reply.substring(0, 3500) + "\n...";
            await sock.sendMessage(jid, { text: reply }, { quoted: msg });
        } catch (e) {
            console.error("Gemini error:", e.message);
            await sock.sendMessage(jid, { text: "🙏 Oups petite erreur, réessaie ta question!" }, { quoted: msg });
        }
    });
}

// CRON
cron.schedule('30 6 * * *', async () => {
    if (isConnected && sock) {
        const v = verses[Math.floor(Math.random() * verses.length)];
        await sock.sendMessage(GROUP_ID, { text: `📖 *MÉDITATION DU MATIN* ☀️\n\n*« ${v.text} »*\n— *${v.verse}*\n\nBonne journée! 🙏✨` });
    }
}, { timezone: "Africa/Abidjan" });

cron.schedule('0 14 * * 5', async () => {
    if (isFirstOrLastFriday(new Date()) && isConnected && sock) {
        await sock.sendMessage(GROUP_ID, { text: `🌙 *RAPPEL VEILLÉE RÉPÉTITION CE SOIR!* 🎵\n\nVenez nombreux préparer nos cœurs! 🙏` });
    }
}, { timezone: "Africa/Abidjan" });

cron.schedule('0 14 * * 5,6', async () => {
    if (isConnected && sock) await sock.sendMessage(GROUP_ID, { text: `🔔 *PROGRAMME WEEK-END* ⛪\n\n${getMonthlyProgramText()}` });
}, { timezone: "Africa/Abidjan" });

cron.schedule('0 16 * * 6', async () => { if (isConnected && sock) await sock.sendMessage(GROUP_ID, { text: cotisationsMessage }); }, { timezone: "Africa/Abidjan" });
cron.schedule('30 11 * * 0', async () => { if (isConnected && sock) await sock.sendMessage(GROUP_ID, { text: cotisationsMessage }); }, { timezone: "Africa/Abidjan" });

app.get('/', (req, res) => {
    if (isConnected) res.send(`<div style="text-align:center;padding:40px;font-family:sans-serif"><h1 style="color:green">✅ Hbot1 Connecté</h1><p>Parle de tout + Gemini 2.0 Flash</p><p>!verset |!id |!programme |!cotisation</p></div>`);
    else if (qrCodeData) res.send(`<div style="text-align:center;padding:40px;font-family:sans-serif"><h1>Scanne ce QR</h1><img src="${qrCodeData}"/><p>Actualise après scan</p></div>`);
    else res.send(`<h1>Initialisation...</h1>`);
});

app.listen(PORT, () => { console.log(`Serveur ${PORT}`); connectToWhatsApp(); });
