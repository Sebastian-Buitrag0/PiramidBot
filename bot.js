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

// --- Cargar Múltiples Credenciales desde .env ---
const credentialsConfig = [];

try {
    const credentialsJsonString = process.env.CREDENTIALS_JSON;
    if (credentialsJsonString) {
        const parsedCredentials = JSON.parse(credentialsJsonString);
        if (Array.isArray(parsedCredentials)) {
            parsedCredentials.forEach((cred, index) => {
                if (cred.username && cred.password) {
                    credentialsConfig.push({
                        id: index + 1, // Usar el índice + 1 como ID
                        username: cred.username,
                        password: cred.password,
                        loginData: null,
                        isLoginPending: false,
                        lastLoginAttempt: 0,
                        loginFailed: false
                    });
                } else {
                    console.warn(`[Config] Credential at index ${index} is missing username or password. Skipping.`);
                }
            });
        } else {
            console.error("[Config] CREDENTIALS_JSON is not a valid JSON array. Please check the format.");
        }
    }
} catch (error) {
    console.error("[Config] Error parsing CREDENTIALS_JSON:", error.message);
    console.error("[Config] Please ensure CREDENTIALS_JSON is a valid JSON array string in your .env file.");
}


if (credentialsConfig.length === 0) {
    console.error("FATAL: No valid API credentials found or loaded from CREDENTIALS_JSON. Exiting.");
    process.exit(1);
} else {
    console.log(`[Config] Loaded ${credentialsConfig.length} credential set(s) from CREDENTIALS_JSON.`);
}

// --- Expresión Regular ---
const redBagCodeRegex = /^[A-Z0-9]{6}$/;

// --- Cliente Twilio (Opcional si solo recibes mensajes) ---
// const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// --- Funciones Auxiliares ---

/**
 * Intenta realizar el login para un set específico de credenciales.
 * Actualiza el estado de ese set de credenciales.
 * @param {object} credSet - El objeto de configuración de credenciales (elemento de credentialsConfig).
 */
async function performLoginForCredential(credSet) {
    if (credSet.isLoginPending) {
        console.log(`[Login Cred ${credSet.id}] Login attempt already in progress. Skipping.`);
        return false;
    }
    if (credSet.loginFailed && (Date.now() - credSet.lastLoginAttempt < 60000)) { // Espera 1 minuto
         console.log(`[Login Cred ${credSet.id}] Login failed recently for user ${credSet.username}. Waiting before retry.`);
         return false;
    }

    credSet.isLoginPending = true;
    credSet.lastLoginAttempt = Date.now();
    console.log(`[Login Cred ${credSet.id}] Attempting to login with user ${credSet.username}...`);
    try {
        // Asegúrate de que la función login en login.js acepta username y password
        credSet.loginData = await login(credSet.username, credSet.password);
        console.log(`[Login Cred ${credSet.id}] Credentials obtained successfully for user ${credSet.username}.`);
        credSet.isLoginPending = false;
        credSet.loginFailed = false;
        return true;
    } catch (error) {
        console.error(`[Login Cred ${credSet.id}] Failed to obtain credentials for user ${credSet.username}:`, error.message);
        credSet.loginData = null;
        credSet.isLoginPending = false;
        credSet.loginFailed = true;
        return false;
    }
}

/**
 * Intenta realizar el login inicial para todos los sets de credenciales.
 */
async function performInitialLoginAll() {
    console.log("[Login] Performing initial login for all configured credentials...");
    const loginPromises = credentialsConfig.map(credSet => performLoginForCredential(credSet));
    await Promise.allSettled(loginPromises);
    console.log("[Login] Initial login attempts completed.");
}

/**
 * Llama a la API para reclamar un Red Bag usando un set específico de credenciales.
 * @param {string} bagKey - El código de 6 caracteres detectado.
 * @param {object} credSet - El set de credenciales a usar.
 * @returns {Promise<object>} - { success: boolean, message: string, claimedByCredId: number | null }
 */
async function tryClaimWithCredential(bagKey, credSet) {
    if (!credSet.loginData || !credSet.loginData.memberID || !credSet.loginData.skey) {
        console.log(`[RedBag Cred ${credSet.id}] Credentials not available for user ${credSet.username}. Attempting login first...`);
        const loginSuccess = await performLoginForCredential(credSet);
        if (!loginSuccess || !credSet.loginData) {
            console.error(`[RedBag Cred ${credSet.id}] Cannot claim bag: Login failed or credentials still missing for user ${credSet.username}.`);
            return { success: false, message: `Login required but failed for Cred ${credSet.id} (${credSet.username}).`, claimedByCredId: null };
        }
        console.log(`[RedBag Cred ${credSet.id}] Login successful for user ${credSet.username}. Proceeding with claim.`);
    }

    const { memberID, skey } = credSet.loginData;
    const redBagUrl = `${API_BASE_URL}/getRedBag/`;
    const payload = { bagKey, lang: "en", memberID, skey };
    const headers = { 'Authorization': `Bearer ${skey}`, 'Content-Type': 'application/json' };

    try {
        console.log(`[RedBag Cred ${credSet.id}] User ${credSet.username} sending POST request to claim ${bagKey}`);
        const response = await axios.post(redBagUrl, payload, { headers, timeout: 15000 });
        console.log(`[RedBag Cred ${credSet.id}] User ${credSet.username} API Response Status:`, response.status);

        if (response.data && response.data.code === "0") {
            console.log(`[RedBag Cred ${credSet.id}] User ${credSet.username} successfully claimed bag ${bagKey}. Message: ${response.data.msg}`);
            return { success: true, message: response.data.msg || "Claimed successfully", claimedByCredId: credSet.id };
        } else {
            const errorMessage = response.data?.msg || `API responded with code ${response.data?.code || 'unknown'}`;
            console.warn(`[RedBag Cred ${credSet.id}] User ${credSet.username} failed to claim bag ${bagKey}: ${errorMessage}`);
            return { success: false, message: `Failed for ${credSet.username}: ${errorMessage}`, claimedByCredId: null };
        }
    } catch (error) {
        if (error.response && error.response.status === 401) {
            console.warn(`[RedBag Cred ${credSet.id}] User ${credSet.username} received 401 Unauthorized. Token might have expired. Attempting re-login...`);
            credSet.loginData = null;
            const loginSuccess = await performLoginForCredential(credSet);
            if (loginSuccess && credSet.loginData) {
                console.log(`[RedBag Cred ${credSet.id}] User ${credSet.username} re-login successful. Retrying claimRedBag call ONCE...`);
                return await tryClaimWithCredential(bagKey, credSet); // Reintenta con las mismas credenciales
            } else {
                console.error(`[RedBag Cred ${credSet.id}] User ${credSet.username} re-login failed after 401. Cannot claim bag with these credentials.`);
                return { success: false, message: `Re-login failed for Cred ${credSet.id} (${credSet.username}) after token expiration.`, claimedByCredId: null };
            }
        } else {
            const errorMessage = error.response?.data?.msg || error.message;
            console.error(`[RedBag Cred ${credSet.id}] User ${credSet.username} error claiming bag ${bagKey}:`, errorMessage);
            if (error.code === 'ECONNABORTED') console.error(`[RedBag Cred ${credSet.id}] User ${credSet.username} request timed out.`);
            return { success: false, message: `Error for Cred ${credSet.id} (${credSet.username}): ${errorMessage}`, claimedByCredId: null };
        }
    }
}

/**
 * Itera a través de todas las credenciales válidas para intentar reclamar un Red Bag.
 * @param {string} bagKey - El código de 6 caracteres detectado.
 */
async function claimRedBagIterating(bagKey) {
    console.log(`[RedBag] Attempting to claim bag ${bagKey} with all available credentials...`);
    let finalResult = { success: false, message: "No valid credentials could claim the bag.", claimedByCredId: null };

    for (const credSet of credentialsConfig) {
        if (credSet.loginFailed && (Date.now() - credSet.lastLoginAttempt < 60000)) {
             console.log(`[RedBag] Skipping Cred ${credSet.id} (User: ${credSet.username}) due to recent login failure.`);
             continue;
        }
        if (!credSet.loginData) {
             console.log(`[RedBag] Cred ${credSet.id} (User: ${credSet.username}) has no login data. Attempting login before claim...`);
             await performLoginForCredential(credSet);
             if (!credSet.loginData) {
                 console.log(`[RedBag] Login failed for Cred ${credSet.id} (User: ${credSet.username}). Skipping claim attempt.`);
                 continue;
             }
         }

        console.log(`[RedBag] Trying with Credential ID: ${credSet.id} (User: ${credSet.username})`);
        const result = await tryClaimWithCredential(bagKey, credSet);

        if (result.success) {
            console.log(`[RedBag] Claim successful using Credential ID: ${credSet.id} (User: ${credSet.username})`);
            finalResult = result;
            break; // Detener el bucle si una credencial tuvo éxito
        } else {
            console.log(`[RedBag] Claim attempt failed with Credential ID: ${credSet.id} (User: ${credSet.username}). Message: ${result.message}`);
            if (!finalResult.success) { // Actualiza el mensaje de error solo si aún no hemos tenido éxito
                finalResult.message = result.message; // Muestra el último error
            }
            // Si el mensaje de error indica que la bolsa ya fue reclamada o es inválida, podríamos detenernos.
            // Ejemplo: if (result.message.toLowerCase().includes("already been claimed") || result.message.toLowerCase().includes("invalid code")) {
            //    console.log(`[RedBag] Stopping further attempts for ${bagKey} as it seems claimed or invalid.`);
            //    finalResult = result; // Guardar este mensaje de error
            //    break;
            // }
        }
    }

    console.log(`[RedBag] Final result for bag ${bagKey}: ${JSON.stringify(finalResult)}`);
    return finalResult;
}

// --- Webhook de Twilio ---
app.post('/whatsapp', async (req, res) => {
    const incomingMsg = req.body;
    const messageBody = incomingMsg.Body;
    const from = incomingMsg.From;
    const to = incomingMsg.To;

    console.log(`\n[Webhook] Received message from ${from}`);
    console.log(`[Webhook] To: ${to}`);
    console.log(`[Webhook] Body: "${messageBody}"`);

    if (from.includes('@g.us')) {
        console.log(`[Webhook] Message ignored: Received from a group (${from}).`);
        const twiml = new twilio.twiml.MessagingResponse();
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(twiml.toString());
        return;
    }

    if (messageBody && redBagCodeRegex.test(messageBody.trim())) {
        const bagKey = messageBody.trim();
        console.log(`[Webhook] Detected valid Red Bag code: ${bagKey}`);

        claimRedBagIterating(bagKey).then(result => {
             console.log(`[Webhook] Final claim result for bag ${bagKey}: ${JSON.stringify(result)}`);
             // Opcional: Enviar mensaje de vuelta al usuario
             // const responseMessage = result.success
             //    ? `✅ Bolsa ${bagKey} reclamada por Cred ${result.claimedByCredId}! ${result.message}`
             //    : `❌ Error al reclamar ${bagKey}: ${result.message}`;
             // if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
             //    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
             //    client.messages.create({ body: responseMessage, from: to, to: from })
             //        .then(message => console.log(`[Twilio] Reply sent: ${message.sid}`))
             //        .catch(error => console.error(`[Twilio] Error sending reply:`, error));
             // }
        }).catch(err => {
             console.error(`[Webhook] Unhandled error during claimRedBagIterating for ${bagKey}:`, err);
        });

    } else {
        console.log("[Webhook] Message does not contain a valid Red Bag code.");
    }

    const twiml = new twilio.twiml.MessagingResponse();
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
});

// --- Inicio del Servidor ---
async function startServer() {
    await performInitialLoginAll();

    app.listen(PORT, () => {
        console.log(`\nWhatsApp Bot Server listening on port ${PORT}`);
        console.log(`Twilio Webhook URL should be configured to: http://<your_public_ngrok_or_server_url>:${PORT}/whatsapp`);

        const loggedInCount = credentialsConfig.filter(c => c.loginData).length;
        const failedCount = credentialsConfig.length - loggedInCount;

        if (loggedInCount > 0) {
            console.log(`[Startup] ${loggedInCount} credential set(s) logged in successfully.`);
        }
        if (failedCount > 0) {
            console.warn(`[Startup] Initial login failed for ${failedCount} credential set(s). Will retry on first relevant message or 401 error.`);
        }
        if (credentialsConfig.length === 0) { // Esto no debería ocurrir si la validación al inicio funciona
             console.error("[Startup] CRITICAL: No credentials were loaded.");
        }
        console.log("Listening only for direct messages (no group messages).");
    });
}

startServer();