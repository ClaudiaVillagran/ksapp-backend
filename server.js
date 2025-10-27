// server.js
// Versión: funcional, acepta GET/POST, alias /webpay-retorno, integración por defecto.

const express = require("express");
const cors = require("cors");
const { WebpayPlus, Options, Environment, IntegrationCommerceCodes, IntegrationApiKeys } = require("transbank-sdk");
const { v4: uuidv4 } = require("uuid");

// -------------------- CONFIG (hardcoded por ahora) --------------------
// Modo: "integration" o "production"
const TBK_ENV = "integration"; // <-- cambia a "production" si pasas a prod

// Si TBK_ENV === "production", rellena con tus credenciales reales.
// Por ahora usamos credenciales/commerce code de INTEGRACIÓN por defecto.
const PROD_COMMERCE_CODE = "597050513381"; // <- opcional placeholder producción
const PROD_API_KEY = "515bda59-40b0-483f-acd0-6d305bc183af"; // <- opcional placeholder producción

// Integración (valores públicos del SDK / ejemplos)
const INTEGRATION_COMMERCE_CODE = IntegrationCommerceCodes.WEBPAY_PLUS || "597056000000";
const INTEGRATION_API_KEY = IntegrationApiKeys.WEBPAY || "579B532A7440BB0C9079DED94D31EA1615BACEB6";

// BASE_URL de TU backend público (sin slash final)
const BASE_URL = "https://ksapp-backend.onrender.com"; // <- tu backend en Render

// ---------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const ENVIRONMENT = TBK_ENV === "production" ? Environment.Production : Environment.Integration;
const COMMERCE_CODE = TBK_ENV === "production" ? PROD_COMMERCE_CODE : INTEGRATION_COMMERCE_CODE;
const API_KEY = TBK_ENV === "production" ? PROD_API_KEY : INTEGRATION_API_KEY;

const TBK_OPTIONS = new Options(COMMERCE_CODE, API_KEY, ENVIRONMENT);

console.log(`Transbank env: ${TBK_ENV} (commerce: ${COMMERCE_CODE})`);

// -------------------- 1) Iniciar pago --------------------
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

// -------------------- 2) Página intermedia (auto-post a Webpay) --------------------
app.get("/payment/forward/:token", async (req, res) => {
  const token = req.params.token;
  const webpayInitUrl =
    ENVIRONMENT === Environment.Production
      ? "https://webpay3g.transbank.cl/webpayserver/initTransaction"
      : "https://webpay3gint.transbank.cl/webpayserver/initTransaction";

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Redirigiendo a Webpay...</title></head>
<body onload="document.forms[0].submit()" style="font-family:system-ui, sans-serif">
  <p>Redirigiendo a Webpay (${TBK_ENV})...</p>
  <form method="post" action="${webpayInitUrl}">
    <input type="hidden" name="token_ws" value="${token}" />
    <noscript><button type="submit">Continuar</button></noscript>
  </form>
</body>
</html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// -------------------- 3) Retorno Webpay (GET/POST) --------------------
app.all("/payment/webpay-return", async (req, res) => {
  try {
    const cb = req.query.cb ? String(req.query.cb) : "";
    const token =
      (req.body && req.body.token_ws) ||
      (req.query && (req.query.token_ws || req.query.TBK_TOKEN));

    if (!token) {
      // Cancelado o retorno inválido (sin token)
      if (cb) {
        const failUrl = `${cb}?status=failed&code=NO_TOKEN`;
        const html = `<!doctype html><html><body><p>Pago cancelado ❌. Volviendo a la app...</p><script>location.replace(${JSON.stringify(failUrl)});</script></body></html>`;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.send(html);
      }
      return res.status(400).send("Falta token_ws (cancelado o inválido)");
    }

    const tx = new WebpayPlus.Transaction(TBK_OPTIONS);
    const commit = await tx.commit(token);

    const success = commit?.response_code === 0 && String(commit?.status).toUpperCase() === "AUTHORIZED";

    if (cb) {
      const u =
        cb +
        `?status=${success ? "success" : "failed"}` +
        `&amount=${encodeURIComponent(commit.amount ?? "")}` +
        `&order=${encodeURIComponent(commit.buy_order ?? "")}` +
        `&token_ws=${encodeURIComponent(token)}` +
        `&code=${encodeURIComponent(commit.response_code ?? "")}`;

      const html = `<!doctype html><html><body><p>${success ? "Pago aprobado ✅" : "Pago rechazado ❌"}. Volviendo a la app...</p><script>location.replace(${JSON.stringify(u)});</script></body></html>`;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(html);
    }

    return res.json({ ok: success, commit });
  } catch (err) {
    console.error("[webpay-return] error:", err);
    return res.status(500).send("Error al confirmar transacción");
  }
});

// -------------------- Alias en caso de 'webpay-retorno' --------------------
app.all("/payment/webpay-retorno", (req, res) => {
  // reenviamos a /payment/webpay-return
  req.url = "/payment/webpay-return" + (req.url.includes("?") ? "&" : "?") + "compat=1";
  app.handle(req, res);
});

// -------------------- Healthcheck --------------------
app.get("/", (_req, res) => res.send(`KSAPP backend running (${TBK_ENV})`));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`KSAPP backend on :${PORT} (TBK_ENV=${TBK_ENV})`));
