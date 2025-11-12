
const express = require("express");
const cors = require("cors");
const {
  WebpayPlus,
  Options,
  Environment,
  IntegrationCommerceCodes,
  IntegrationApiKeys,
} = require("transbank-sdk");
const { v4: uuidv4 } = require("uuid");
const cloudinary = require("cloudinary").v2;

const TBK_ENV = "production"; // "integration" | "production"

const PROD_COMMERCE_CODE = process.env.PROD_COMMERCE_CODE;
const PROD_API_KEY = process.env.PROD_API_KEY;

const INTEGRATION_COMMERCE_CODE = IntegrationCommerceCodes.WEBPAY_PLUS; 
const INTEGRATION_API_KEY = IntegrationApiKeys.WEBPAY;              

const BASE_URL = "https://ksapp-backend.onrender.com"; // Render

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const ENVIRONMENT =
  TBK_ENV === "production" ? Environment.Production : Environment.Integration;

const COMMERCE_CODE =
  TBK_ENV === "production" ? PROD_COMMERCE_CODE : INTEGRATION_COMMERCE_CODE;

const API_KEY =
  TBK_ENV === "production" ? PROD_API_KEY : INTEGRATION_API_KEY;

const TBK_OPTIONS = new Options(COMMERCE_CODE, API_KEY, ENVIRONMENT);
console.log(`[TBK] env=${TBK_ENV} commerce=${COMMERCE_CODE}`);

// ============ 1) Crear transacción ============
app.post("/payment/start-payment", async (req, res) => {
  try {
    const { amount, orderId, callback } = req.body || {};
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: "Monto inválido" });
    }

    const cb = callback ? encodeURIComponent(encodeURIComponent(String(callback))) : "";

    const buyOrder = (orderId && String(orderId)) || `KSA-${Date.now()}`;
    const sessionId = uuidv4();
    const returnUrl = `${BASE_URL}/payment/webpay-return${cb ? `?cb=${cb}` : ""}`;

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

app.get("/payment/forward/:token", (req, res) => {
  const token = req.params.token;
  const webpayInitUrl =
    ENVIRONMENT === Environment.Production
      ? "https://webpay3g.transbank.cl/webpayserver/initTransaction"
      : "https://webpay3gint.transbank.cl/webpayserver/initTransaction";

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Redirigiendo a Webpay...</title></head>
<body onload="document.forms[0].submit()" style="font-family:system-ui,sans-serif">
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

app.all("/payment/webpay-return", async (req, res) => {
  try {
    // ⚠️ Doble decode del callback
    const cbRaw = (req.query && req.query.cb) ? String(req.query.cb) : "";
    const cb = cbRaw ? decodeURIComponent(decodeURIComponent(cbRaw)) : "";

    const token =
      (req.body && req.body.token_ws) ||
      (req.query && (req.query.token_ws || req.query.TBK_TOKEN));

    if (!token) {
      if (cb) {
        const failUrl = `${cb}?status=failed&code=NO_TOKEN`;
        const html = `<!doctype html><html><body>
<p>Pago cancelado ❌. Volviendo a la app...</p>
<script>location.replace(${JSON.stringify(failUrl)});</script>
</body></html>`;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.send(html);
      }
      return res.status(400).send("Falta token_ws (cancelado o inválido)");
    }

    const tx = new WebpayPlus.Transaction(TBK_OPTIONS);
    const commit = await tx.commit(token);

    const success =
      commit?.response_code === 0 &&
      String(commit?.status).toUpperCase() === "AUTHORIZED";

    if (cb) {
      const u =
        cb +
        `?status=${success ? "success" : "failed"}` +
        `&amount=${encodeURIComponent(commit.amount ?? "")}` +
        `&order=${encodeURIComponent(commit.buy_order ?? "")}` +
        `&token_ws=${encodeURIComponent(token)}` +
        `&code=${encodeURIComponent(commit.response_code ?? "")}`;
      const html = `<!doctype html><html><body>
<p>${success ? "Pago aprobado ✅" : "Pago rechazado ❌"}. Volviendo a la app...</p>
<script>location.replace(${JSON.stringify(u)});</script>
</body></html>`;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(html);
    }

    return res.json({ ok: success, commit });
  } catch (err) {
    console.error("[webpay-return] error:", err);
    return res.status(500).send("Error al confirmar transacción");
  }
});

app.all("/payment/webpay-retorno", (req, res) => {
  req.url = "/payment/webpay-return" + (req.url.includes("?") ? "&" : "?") + "compat=1";
  app.handle(req, res);
});

app.get("/", (_req, res) => res.send(`KSAPP backend running (${TBK_ENV})`));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`KSAPP backend on :${PORT} (env=${TBK_ENV})`));



// Cloud
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const isSafeInt = (n) => Number.isInteger(n) && n > 0;

app.get("/cloudinary/signature", (req, res) => {
  try {
    const timestamp = Math.floor(Date.now() / 1000);

    const paramsToSign = {
      timestamp,
      folder: process.env.CLOUDINARY_FOLDER || "ksa/uploads",
    };

    const signature = cloudinary.utils.api_sign_request(
      paramsToSign,
      process.env.CLOUDINARY_API_SECRET
    );

    res.json({
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
      timestamp,
      signature,
      params: paramsToSign,
    });
  } catch (err) {
    console.error("[cloudinary/signature] error:", err);
    res.status(500).json({ error: "No se pudo firmar la solicitud" });
  }
});
