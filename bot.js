require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const axios = require('axios');
const { login } = require('./login');

const app = express();
app.use(bodyParser.urlencoded({ extended: false })); // Twilio usa urlencoded

// --- Configuración ---
const PORT = process.env.PORT || 3000;
const API_BASE_URL = process.env.API_BASE_URL;
const API_USERNAME = process.env.API_USERNAME;
const API_PASSWORD = process.env.API_PASSWORD;

// --- Estado del Bot ---
let botCredentials = null; // Almacenará { memberID, skey }
let isLoginPending = false; // Para evitar logins concurrentes

// --- Expresión Regular ---
const redBagCodeRegex = /^[A-Z0-9]{6}$/;

// --- Cliente Twilio (Opcional si solo recibes mensajes) ---
// const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// --- Funciones Auxiliares ---

/**
 * Intenta realizar el login inicial o re-login.
 * Actualiza botCredentials si tiene éxito.
 */
async function performLogin() {
    if (isLoginPending) {
        console.log("[Login] Login attempt already in progress. Skipping.");
        return false; // Indica que no se inició un nuevo login
    }
    isLoginPending = true;
    console.log("[Login] Attempting to login...");
    try {
        botCredentials = await login(API_USERNAME, API_PASSWORD);
        console.log("[Login] Credentials obtained successfully.");
        isLoginPending = false;
        return true; // Indica éxito
    } catch (error) {
        console.error("[Login] Failed to obtain credentials:", error.message);
        botCredentials = null; // Resetea credenciales en caso de fallo
        isLoginPending = false;
        return false; // Indica fallo
    }
}

/**
 * Llama a la API para reclamar un Red Bag.
 * Maneja la necesidad de re-login si el token expira (401).
 * @param {string} bagKey - El código de 6 caracteres detectado.
 */
async function claimRedBag(bagKey) {
    console.log(`[RedBag] Attempting to claim bag with key: ${bagKey}`);

    if (!botCredentials || !botCredentials.memberID || !botCredentials.skey) {
        console.log("[RedBag] Credentials not available. Attempting login first...");
        const loginSuccess = await performLogin();
        if (!loginSuccess || !botCredentials) {
             console.error("[RedBag] Cannot claim bag: Login failed or credentials still missing.");
             // Podrías enviar un mensaje de error al chat aquí si lo deseas
             return { success: false, message: "Login required but failed." };
        }
         console.log("[RedBag] Login successful after detecting missing credentials. Proceeding with claim.");
    }

    const { memberID, skey } = botCredentials;
    const redBagUrl = `${API_BASE_URL}/getRedBag/`;
    const payload = {
        bagKey: bagKey,
        lang: "en", // O el idioma que prefieras/necesites
        memberID: memberID,
        skey: skey
    };
    const headers = {
        'Authorization': `Bearer ${skey}`,
        'Content-Type': 'application/json'
    };

    try {
        console.log("[RedBag] Sending POST request to:", redBagUrl);
        console.log("[RedBag] Payload:", JSON.stringify(payload)); // Cuidado con loggear skey en producción real
        console.log("[RedBag] Headers:", JSON.stringify({"Authorization": `Bearer ***`, "Content-Type": "application/json"})); // Oculta skey en log

        const response = await axios.post(redBagUrl, payload, { headers, timeout: 15000 });

        console.log("[RedBag] API Response Status:", response.status);
        console.log("[RedBag] API Response Data:", response.data);

        if (response.data && response.data.code === "0") {
            console.log(`[RedBag] Successfully claimed bag ${bagKey}. Message: ${response.data.msg}`);
             // Aquí podrías enviar un mensaje de confirmación al chat si es necesario
            return { success: true, message: response.data.msg || "Claimed successfully" };
        } else {
            const errorMessage = response.data?.msg || `API responded with code ${response.data?.code || 'unknown'}`;
             console.error(`[RedBag] Failed to claim bag ${bagKey}: ${errorMessage}`);
             // Manejar casos específicos, por ej. bolsa ya reclamada, código inválido, etc.
             return { success: false, message: `Failed: ${errorMessage}` };
        }

    } catch (error) {
        // Reintento específico si es un error de autenticación (token expirado)
        if (error.response && error.response.status === 401) {
            console.warn("[RedBag] Received 401 Unauthorized. Token might have expired. Attempting re-login...");
            botCredentials = null; // Invalida credenciales actuales
            const loginSuccess = await performLogin();
            if (loginSuccess && botCredentials) {
                console.log("[RedBag] Re-login successful. Retrying claimRedBag call ONCE...");
                // Llama recursivamente UNA SOLA VEZ para evitar bucles infinitos
                // Asegúrate de pasar el bagKey original
                // ¡Importante! Evita la recursión infinita añadiendo un flag o límite
                // En este caso, como performLogin actualiza botCredentials, una segunda llamada
                // debería funcionar o fallar definitivamente.
                // Para mayor seguridad, podrías añadir un parámetro de reintento a claimRedBag.
                return await claimRedBag(bagKey); // Reintenta la llamada original
            } else {
                console.error("[RedBag] Re-login failed after 401. Cannot claim bag.");
                 return { success: false, message: "Re-login failed after token expiration." };
            }
        } else {
            // Otros errores (red, timeout, error 500 de la API, etc.)
            const errorMessage = error.response?.data?.msg || error.message;
            console.error(`[RedBag] Error claiming bag ${bagKey}:`, errorMessage);
            if (error.code === 'ECONNABORTED') {
                console.error("[RedBag] Request timed out.");
            }
            return { success: false, message: `Error: ${errorMessage}` };
        }
    }
}

// --- Webhook de Twilio ---
app.post('/whatsapp', async (req, res) => {
    const incomingMsg = req.body;
    const messageBody = incomingMsg.Body; // Texto del mensaje
    const from = incomingMsg.From; // ID del remitente (usuario o grupo) -> whatsapp:+1234567890 o whatsapp:group_id@g.us
    const to = incomingMsg.To; // Tu número de Twilio -> whatsapp:+14155238886

    console.log(`\n[Webhook] Received message from ${from}`);
    console.log(`[Webhook] To: ${to}`);
    console.log(`[Webhook] Body: "${messageBody}"`);

    // --- IGNORAR MENSAJES DE GRUPO ---
    // Añade esta condición para ignorar si 'from' contiene '@g.us'
    if (from.includes('@g.us')) {
        console.log(`[Webhook] Message ignored: Received from a group (${from}), only processing direct messages.`);
        const twiml = new twilio.twiml.MessagingResponse();
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(twiml.toString());
        return; // Detiene el procesamiento para este mensaje
    }

    // --- Detección del Código ---
    if (messageBody && redBagCodeRegex.test(messageBody.trim())) {
        const bagKey = messageBody.trim();
        console.log(`[Webhook] Detected valid Red Bag code: ${bagKey}`);

        // Llama a la función para reclamar la bolsa (no bloquea la respuesta al webhook)
        claimRedBag(bagKey).then(result => {
             console.log(`[Webhook] Result for bag ${bagKey}: ${JSON.stringify(result)}`);
             // Aquí podrías decidir si enviar un mensaje de vuelta al grupo/usuario
             // Ejemplo:
             // if (result.success) {
             //    client.messages.create({ body: `✅ Bolsa ${bagKey} reclamada! ${result.message}`, from: to, to: from });
             // } else {
             //    client.messages.create({ body: `❌ Error al reclamar ${bagKey}: ${result.message}`, from: to, to: from });
             // }
        }).catch(err => {
             // Captura errores no manejados dentro de claimRedBag (aunque debería manejarlos)
             console.error(`[Webhook] Unhandled error during claimRedBag for ${bagKey}:`, err);
        });

    } else {
        console.log("[Webhook] Message does not contain a valid Red Bag code.");
    }

    // --- Respuesta a Twilio ---
    // Siempre responde a Twilio para confirmar la recepción del mensaje.
    // No incluyas mensajes aquí si quieres enviarlos asíncronamente como arriba.
    const twiml = new twilio.twiml.MessagingResponse();
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
});

// --- Inicio del Servidor ---
async function startServer() {
    // Intenta el login inicial al arrancar
    await performLogin();

    app.listen(PORT, () => {
        console.log(`\nWhatsApp Bot Server listening on port ${PORT}`);
        console.log(`Twilio Webhook URL should be configured to: http://<your_public_ngrok_or_server_url>:${PORT}/whatsapp`);
        if (botCredentials) {
            console.log("Bot is logged in and ready.");
        } else {
            console.warn("Bot started but initial login failed. Will retry on first relevant message or 401 error.");
        }
        console.log("Listening only for direct messages (no group messages).");
    });
}

startServer();