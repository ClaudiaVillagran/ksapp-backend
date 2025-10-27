// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");

// Express 5 ya trae body parsing integrado
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== Transbank SDK =====
const { WebpayPlus } = require("transbank-sdk"); // CommonJS
const { v4: uuidv4 } = require("uuid");

// ===== Config rápida (usa tus mismas keys) =====
// Sube esto a variables de entorno cuando puedas:
const COMMERCE_CODE = process.env.TBK_COMMERCE_CODE || "597050513381";
const API_KEY = process.env.TBK_API_KEY || "515bda59-40b0-483f-acd0-6d305bc183af";

// URL pública (https) de TU backend (la que ve Webpay):
// ej: https://api.ksapp.cl
const BASE_URL = process.env.BASE_URL || "https://ksa.cl/pago-return";

// Configura PRODUCCIÓN con tus credenciales
WebpayPlus.configureForProduction(COMMERCE_CODE, API_KEY);

// Si quisieras sandbox para pruebas rápidas (NO mezclar con prod):
// const { IntegrationCommerceCodes, IntegrationApiKeys, Environment } = require("transbank-sdk");
// WebpayPlus.configureForIntegration(IntegrationCommerceCodes.WEBPAY_PLUS, IntegrationApiKeys.WEBPAY, Environment.Integration);

// ─────────────────────────────────────────────────────────────────────────────
// 1) Iniciar pago: crea transacción y te devuelvo una URL intermedia que auto-postea
// body: { amount:number, orderId?:string, callback?:string }
//  - amount: CLP entero (sin decimales)
//  - callback: deep link para Expo, p. ej.: "ksapp://pay/return"
app.post("/payment/start-payment", async (req, res) => {
  try {
    const { amount, orderId, callback } = req.body || {};
    const amt = Number(amount);

    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: "Monto inválido" });
    }

    const buyOrder = (orderId && String(orderId)) || `KSA-${Date.now()}`;
    const sessionId = uuidv4();

    // Webpay llamará a esta URL con POST token_ws
    const returnUrl = `${BASE_URL}/payment/webpay-return?cb=${encodeURIComponent(
      callback || ""
    )}`;

    // Crea la transacción
    const resp = await new WebpayPlus.Transaction().create(
      buyOrder,
      sessionId,
      Math.round(amt), // CLP → entero
      returnUrl
    );

    // En móvil no podemos hacer form POST directo, así que usamos el "forward"
    const forwardUrl = `${BASE_URL}/payment/forward/${resp.token}`;

    return res.json({
      forwardUrl,        // 👉 abre esto con WebBrowser.openAuthSessionAsync(forwardUrl, callback)
      token: resp.token, // por si lo quieres loguear
      buyOrder,
      amount: amt,
    });
  } catch (err) {
    console.error("[start-payment] error:", err);
    return res.status(500).json({ error: "No se pudo iniciar la transacción" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) Página intermedia: auto-POST a Webpay con token_ws
//    Transbank espera un form POST contra initTransaction con token_ws.
app.get("/payment/forward/:token", async (req, res) => {
  const token = req.params.token;

  // En producción, el initTransaction es esta URL:
  const webpayInitUrl = "https://webpay3g.transbank.cl/webpayserver/initTransaction";

  const html = `
<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Redirigiendo a Webpay…</title></head>
  <body onload="document.forms[0].submit()" style="font-family:system-ui, sans-serif">
    <p>Redirigiendo a Webpay…</p>
    <form method="post" action="${webpayInitUrl}">
      <input type="hidden" name="token_ws" value="${token}" />
      <noscript><button type="submit">Continuar</button></noscript>
    </form>
  </body>
</html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) Return URL: Webpay POSTea token_ws aquí. Hacemos commit y redirigimos a tu deep link.
app.post("/payment/webpay-return", async (req, res) => {
  try {
    const token = req.body.token_ws;
    const cb = req.query.cb ? String(req.query.cb) : ""; // deep link, ej: ksapp://pay/return

    if (!token) {
      return res.status(400).send("Falta token_ws");
    }

    const commit = await new WebpayPlus.Transaction().commit(token);

    const success =
      commit?.response_code === 0 && String(commit?.status).toUpperCase() === "AUTHORIZED";

    // Si definiste deep link, vuelve a la app (cierra navegador en Expo)
    if (cb) {
      const u =
        cb +
        `?status=${success ? "success" : "failed"}` +
        `&amount=${encodeURIComponent(commit.amount)}` +
        `&order=${encodeURIComponent(commit.buy_order)}` +
        `&token_ws=${encodeURIComponent(token)}` +
        `&code=${encodeURIComponent(commit.response_code)}`;

      const html = `
<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${success ? "Pago aprobado" : "Pago rechazado"}</title></head>
  <body style="font-family:system-ui, sans-serif">
    <p>${success ? "Pago aprobado ✅" : "Pago rechazado ❌"}. Volviendo a la app…</p>
    <script>window.location.replace(${JSON.stringify(u)});</script>
  </body>
</html>`;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(html);
    }

    // Si no hay deep link, responde JSON (útil para pruebas en navegador)
    return res.json({ ok: success, commit });
  } catch (err) {
    console.error("[webpay-return] error:", err);
    return res.status(500).send("Error al confirmar transacción");
  }
});

// Healthcheck
app.get("/", (_req, res) => res.send("KSAPP backend running"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`KSAPP backend on :${PORT}`));
