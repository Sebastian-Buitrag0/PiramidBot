# WhatsApp Red Bag Bot

Este es un bot de Node.js que se conecta a WhatsApp a través de Twilio para escuchar mensajes en un grupo (o todos los chats). Cuando detecta un código de 6 caracteres alfanuméricos en mayúsculas, intenta reclamar un "Red Bag" utilizando una API externa (`videoaiinvestments.com`).

## Características

-   Escucha mensajes de WhatsApp a través de webhooks de Twilio.
-   Detecta códigos con el formato `^[A-Z0-9]{6}$`.
-   Realiza autenticación (login) con la API externa usando número de teléfono y contraseña (encriptada con MD5).
-   Maneja la obtención y el uso de tokens (`skey`) y `memberID`.
-   Realiza peticiones POST a la API para reclamar "Red Bags" con el código detectado.
-   Implementa lógica de reintentos para el login.
-   Maneja la expiración de tokens (error 401) reintentando el login y la petición.
-   Estructura modular (`login.js`, `bot.js`).
-   Configuración mediante variables de entorno (`.env`).

## Prerrequisitos

-   Node.js (v16 o superior recomendado)
-   npm (generalmente viene con Node.js)
-   Una cuenta de Twilio con un número de WhatsApp activado (puede ser Sandbox para pruebas).
-   Credenciales de la API de `videoaiinvestments.com` (número de teléfono y contraseña).
-   (Opcional pero recomendado para desarrollo local) `ngrok` para exponer tu servidor local a internet y que Twilio pueda enviarle webhooks.

## Configuración

1.  **Clonar el repositorio:**
    ```bash
    git clone <url-del-repositorio>
    cd PiramidBot
    ```

2.  **Instalar dependencias:**
    ```bash
    npm install
    ```

3.  **Crear archivo de configuración:**
    Crea un archivo llamado `.env` en la raíz del proyecto.

4.  **Completar el archivo `.env`:**
    Copia el contenido del siguiente bloque y rellena tus credenciales y configuraciones:

    ```env
    # Twilio Credentials
    TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx # Tu Account SID de Twilio
    TWILIO_AUTH_TOKEN=your_auth_token_xxxxxxxxxxxxxxx # Tu Auth Token de Twilio
    TWILIO_PHONE_NUMBER=whatsapp:+14155238886 # Tu número de Twilio WhatsApp (Sandbox o propio)

    # API Credentials (videoaiinvestments.com)
    API_USERNAME=+573124138640 # Número de teléfono para login (con código de país)
    API_PASSWORD=Sebas_1006      # Contraseña SIN encriptar (el script la encripta)
    API_BASE_URL=https://www.videoaiinvestments.com/api

    # Bot Configuration
    # TARGET_GROUP_ID=whatsapp:xxxxxxxxxxxx@g.us # Opcional: Si quieres que el bot SOLO funcione en UN grupo específico, pon su ID aquí. Déjalo vacío o coméntalo para que funcione en cualquier chat.
    PORT=3000 # Puerto para el servidor de webhooks
    ```
    **Importante:** Asegúrate de que `API_USERNAME` tenga el formato correcto (con código de país, ej: `+57...`). El script intentará añadir `+57` si falta.

5.  **(Solo para desarrollo local) Exponer el puerto con ngrok:**
    Si estás ejecutando el bot en tu máquina local, necesitas una URL pública para que Twilio envíe los webhooks.
    ```bash
    ngrok http 3000
    ```
    Ngrok te dará una URL pública (ej: `https://abcdef12345.ngrok.io`). Copia esta URL HTTPS.

6.  **Configurar el Webhook en Twilio:**
    -   Ve a la consola de Twilio -> Messaging -> Senders -> WhatsApp Senders.
    -   Selecciona tu número de WhatsApp.
    -   En la sección "Webhook URL for incoming messages", pega la URL pública de ngrok (o de tu servidor desplegado) seguida de `/whatsapp`. Ejemplo: `https://abcdef12345.ngrok.io/whatsapp`.
    -   Asegúrate de que el método esté configurado en `HTTP POST`.
    -   Guarda la configuración.

## Ejecución

1.  **Iniciar el bot:**
    ```bash
    npm start
    ```
    O directamente:
    ```bash
    node bot.js
    ```

2.  El servidor se iniciará y verás mensajes en la consola indicando si el login inicial fue exitoso y la URL del webhook que está escuchando.

## Prueba

1.  **Añadir el bot al grupo:** Asegúrate de que el número de Twilio (`TWILIO_PHONE_NUMBER`) esté añadido como participante en el grupo de WhatsApp deseado. (Si usas Sandbox, sigue las instrucciones de Twilio para unirte al Sandbox desde el teléfono del grupo).
2.  **Enviar un código:** Escribe un mensaje en el grupo que contenga únicamente un código válido de 6 caracteres alfanuméricos en mayúsculas (ej: `NA82QA`).
3.  **Observar la consola:** Revisa la consola donde se está ejecutando `node bot.js`. Deberías ver:
    -   El mensaje entrante.
    -   El mensaje indicando que se detectó un código válido.
    -   Los logs de la llamada a la API `/getRedBag/`.
    -   El resultado de la llamada (éxito o error).
4.  **Verificar errores:** Si hay fallos (login, llamada a la API), los errores detallados se mostrarán en la consola.

## Notas Adicionales

-   **Seguridad:** Nunca compartas tu archivo `.env` ni subas tus credenciales a repositorios públicos. Asegúrate de añadir `.env` a tu archivo `.gitignore`.
-   **Respuesta al Chat:** El código actual registra los resultados en la consola. Puedes descomentar y adaptar las líneas que usan `client.messages.create` en `bot.js` si deseas que el bot envíe mensajes de confirmación o error de vuelta al chat de WhatsApp.
-   **Filtrado por Grupo:** Si configuras `TARGET_GROUP_ID`, el bot ignorará mensajes de otros chats o grupos.
-   **Manejo de Errores:** La implementación incluye reintentos básicos de login y manejo de token expirado (401). Puedes mejorar el manejo de errores específicos de la API según su documentación.
