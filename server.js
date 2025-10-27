// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");

// Express 5 parsing
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== Transbank SDK v5 =====
const { WebpayPlus, Options, Environment } = require("transbank-sdk");
const { v4: uuidv4 } = require("uuid");

// ===== Config rápida =====
const COMMERCE_CODE = process.env.TBK_COMMERCE_CODE || "597050513381";
const API_KEY = process.env.TBK_API_KEY || "515bda59-40b0-483f-acd0-6d305bc183af";
const BASE_URL = process.env.BASE_URL || "https://ksa.cl/pago-retorno";

// En v5 NO se usa configureForProduction.
// Hay que crear Options y pasarlas al crear/commit:
const TBK_OPTIONS = new Options(COMMERCE_CODE, API_KEY, Environment.Production);

// ─────────────────────────────────────────────────────────────────────────────
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

    // IMPORTANTE v5: instanciar Transaction con Options
    const tx = new WebpayPlus.Transaction(TBK_OPTIONS);
    const resp = await tx.create(buyOrder, sessionId, Math.round(amt), returnUrl);

    const forwardUrl = `${BASE_URL}/payment/forward/${resp.token}`;
    return res.json({
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

// ─────────────────────────────────────────────────────────────────────────────
// 2) Página intermedia: auto-POST a Webpay con token_ws
app.get("/payment/forward/:token", async (req, res) => {
  const token = req.params.token;
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
// 3) Return URL: commit + deep link de vuelta a la app
app.post("/payment/webpay-return", async (req, res) => {
  try {
    const token = req.body.token_ws;
    const cb = req.query.cb ? String(req.query.cb) : ""; // ej: ksapp://pay/return
    if (!token) return res.status(400).send("Falta token_ws");

    // v5: Transaction con Options para commit
    const tx = new WebpayPlus.Transaction(TBK_OPTIONS);
    const commit = await tx.commit(token);

    const success = commit?.response_code === 0 && String(commit?.status).toUpperCase() === "AUTHORIZED";

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
