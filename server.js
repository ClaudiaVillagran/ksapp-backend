// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Transbank SDK v5
const {
  WebpayPlus,
  Options,
  Environment,
  IntegrationCommerceCodes,
  IntegrationApiKeys,
} = require("transbank-sdk");
const { v4: uuidv4 } = require("uuid");

// ====== CONFIG ======
const TBK_ENV = (process.env.TBK_ENV || "integration").toLowerCase(); // "integration" | "production"

// Backend público (sin slash final)
const BASE_URL =
  (process.env.BASE_URL || "https://ksapp-backend.onrender.com").replace(/\/+$/,'');

// Producción (si tuvieras llaves reales):
const PROD_COMMERCE_CODE = process.env.TBK_COMMERCE_CODE || "";
const PROD_API_KEY = process.env.TBK_API_KEY || "";

// Según entorno, armamos Options y URL de init para el forward
let TBK_OPTIONS;
let WEBPAY_INIT_URL;

if (TBK_ENV === "production") {
  // Producción real
  TBK_OPTIONS = new Options(PROD_COMMERCE_CODE, PROD_API_KEY, Environment.Production);
  WEBPAY_INIT_URL = "https://webpay3g.transbank.cl/webpayserver/initTransaction";
} else {
  // Integración (sandbox)
  TBK_OPTIONS = new Options(
    IntegrationCommerceCodes.WEBPAY_PLUS,
    IntegrationApiKeys.WEBPAY,
    Environment.Integration
  );
  WEBPAY_INIT_URL = "https://webpay3gint.transbank.cl/webpayserver/initTransaction";
}

// ====== ENDPOINTS ======

// 1) Iniciar pago
// body: { amount:number, orderId?:string, callback?:string }
app.post("/payment/start-payment", async (req, res) => {
  try {
    const { amount, orderId, callback } = req.body || {};
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: "Monto inválido" });
    }

    const buyOrder = (orderId && String(orderId)) || `KSA-${Date.now()}`;
    const sessionId = uuidv4();
    const returnUrl = `${BASE_URL}/payment/webpay-return?cb=${encodeURIComponent(callback || "")}`;

    const tx = new WebpayPlus.Transaction(TBK_OPTIONS);
    const resp = await tx.create(buyOrder, sessionId, Math.round(amt), returnUrl);

    const forwardUrl = `${BASE_URL}/payment/forward/${resp.token}`;
    return res.json({
      env: TBK_ENV,
      forwardUrl,
      token: resp.token,
      buyOrder,
      amount: amt,
    });
  } catch (err) {
    console.error("[start-payment] error:", err);
    return res.status(500).json({ error: "No se pudo iniciar la transacción" });
  }
});

// 2) Página intermedia: auto-POST a Webpay con token_ws
app.get("/payment/forward/:token", async (req, res) => {
  const token = req.params.token;
  const html = `
<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Redirigiendo a Webpay…</title></head>
  <body onload="document.forms[0].submit()" style="font-family:system-ui, sans-serif">
    <p>Redirigiendo a Webpay… (${TBK_ENV})</p>
    <form method="post" action="${WEBPAY_INIT_URL}">
      <input type="hidden" name="token_ws" value="${token}" />
      <noscript><button type="submit">Continuar</button></noscript>
    </form>
  </body>
</html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// 3) Return URL: commit + deep link de vuelta a la app
app.post("/payment/webpay-return", async (req, res) => {
  try {
    const token = req.body.token_ws;
    const cb = req.query.cb ? String(req.query.cb) : ""; // ej: ksapp://pay/return
    if (!token) return res.status(400).send("Falta token_ws");

    const tx = new WebpayPlus.Transaction(TBK_OPTIONS);
    const commit = await tx.commit(token);

    const success =
      commit?.response_code === 0 &&
      String(commit?.status).toUpperCase() === "AUTHORIZED";

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
    <p>${success ? "Pago aprobado ✅" : "Pago rechazado ❌"} (${TBK_ENV}). Volviendo a la app…</p>
    <script>window.location.replace(${JSON.stringify(u)});</script>
  </body>
</html>`;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(html);
    }

    return res.json({ ok: success, env: TBK_ENV, commit });
  } catch (err) {
    console.error("[webpay-return] error:", err);
    return res.status(500).send("Error al confirmar transacción");
  }
});

// Healthcheck
app.get("/", (_req, res) => res.send(`KSAPP backend running (${TBK_ENV})`));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`KSAPP backend on :${PORT} (${TBK_ENV})`));
