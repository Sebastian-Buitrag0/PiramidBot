const axios = require('axios');
const md5 = require('md5');
require('dotenv').config(); // Carga variables de .env

const API_BASE_URL = process.env.API_BASE_URL;
const MAX_LOGIN_RETRIES = 1;
const RETRY_DELAY_MS = 100; // 2 segundos de espera entre reintentos

/**
 * Limpia un número de teléfono, eliminando caracteres no numéricos.
 * @param {string} phone - Número de teléfono de entrada.
 * @returns {string} - Número de teléfono limpio (solo dígitos).
 */
function validateNumberInput(phone) {
    if (!phone) return '';
    return phone.replace(/\D/g, '');
}

/**
 * Asegura que el número de teléfono tenga el prefijo de país (+57).
 * @param {string} cleanedPhone - Número de teléfono ya limpio.
 * @returns {string} - Número con prefijo +57.
 */
function ensureCountryCode(cleanedPhone) {
    if (!cleanedPhone) return '';
    // Asume +57 si no tiene un '+' al inicio (podría mejorarse para detectar otros códigos)
    if (!cleanedPhone.startsWith('+')) {
        // Si ya empieza con 57 y tiene longitud adecuada, asume que es +57
        if (cleanedPhone.startsWith('57') && cleanedPhone.length >= 12) {
             return `+${cleanedPhone}`;
        }
        // Si no, añade +57
        return `+57${cleanedPhone}`;
    }
    return cleanedPhone; // Ya tiene un prefijo, lo dejamos como está
}


/**
 * Intenta iniciar sesión en la API.
 * @param {string} phone - Número de teléfono (puede tener o no +57).
 * @param {string} rawPassword - Contraseña sin encriptar.
 * @param {number} attempt - Número de intento actual (para reintentos).
 * @returns {Promise<{memberID: string, skey: string}>} - Promesa que resuelve con memberID y skey.
 * @throws {Error} - Si el login falla después de los reintentos.
 */
async function login(phone, rawPassword, attempt = 1) {
    console.log(`[Login] Attempt ${attempt}/${MAX_LOGIN_RETRIES} for user ${phone}`);
    const cleanedPhone = validateNumberInput(phone);
    const userName = ensureCountryCode(cleanedPhone);
    const pwd = md5(rawPassword); // Encripta la contraseña con MD5

    if (!userName) {
        throw new Error("[Login] Invalid phone number provided.");
    }

    const loginUrl = `${API_BASE_URL}/userlogin/`;
    const payload = { userName, pwd };

    try {
        const response = await axios.post(loginUrl, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000 // Timeout de 10 segundos
        });

        // Verifica la estructura de la respuesta esperada
        if (response.data && response.data.code === "0" && response.data.memInfo) {
            const { memberID, skey } = response.data.memInfo;
            if (memberID && skey) {
                console.log(`[Login] Successful for user ${userName}. MemberID obtained.`);
                return { memberID, skey };
            } else {
                 throw new Error(`[Login] API response successful (code 0) but missing memberID or skey.`);
            }
        } else {
            // Intenta obtener un mensaje de error más específico si existe
            const errorMessage = response.data?.msg || `API responded with code ${response.data?.code || 'unknown'}`;
            throw new Error(`[Login] Failed: ${errorMessage}`);
        }

    } catch (error) {
        const errorMessage = error.response?.data?.msg || error.message;
        console.error(`[Login] Error during attempt ${attempt}:`, errorMessage);

        // Lógica de reintento
        if (attempt < MAX_LOGIN_RETRIES) {
            // Podrías añadir condiciones específicas aquí, ej: reintentar solo en errores de red o 'timeout'
            // O si la API indica explícitamente "demasiadas peticiones" (necesitarías saber el código/mensaje)
            console.log(`[Login] Retrying in ${RETRY_DELAY_MS / 1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            return login(phone, rawPassword, attempt + 1); // Llama recursivamente para reintentar
        } else {
            console.error(`[Login] Failed after ${MAX_LOGIN_RETRIES} attempts.`);
            throw new Error(`[Login] Failed after ${MAX_LOGIN_RETRIES} attempts: ${errorMessage}`);
        }
    }
}

module.exports = { login };