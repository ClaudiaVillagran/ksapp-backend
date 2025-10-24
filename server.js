// ─── IMPORTS Y MIDDLEWARES ─────────────────────────────────────────
import express from "express";
import cors from "cors";
import axios from "axios";
import crypto from "crypto";
import "dotenv/config"; // si corres local con .env

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── CONSTS FLOW (SANDBOX) ─────────────────────────────────────────
const FLOW_CREATE_URL = "https://sandbox.flow.cl/api/payment/create";
const FLOW_STATUS_URL = "https://sandbox.flow.cl/api/payment/getStatus";

const { FLOW_API_KEY, FLOW_SECRET_KEY, URL_RETURN, URL_CONFIRM, PORT } = process.env;

// ─── HELPERS: FIRMA EXACTA ─────────────────────────────────────────
// Construye un objeto de params ordenado por clave ASC
function orderedParams(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

// Construye un querystring usando SIEMPRE URLSearchParams (mismo mecanismo)
function toQueryStringOrdered(paramsObj) {
  const search = new URLSearchParams();
  for (const k of Object.keys(paramsObj)) {
    search.append(k, paramsObj[k]);
  }
  return search.toString(); // ej: amount=10000&apiKey=...&...
}

// Firma HMAC-SHA256 en MAYÚSCULAS sobre el querystring FINAL
function hmacHexUpper(qs, secret) {
  return crypto.createHmac("sha256", secret).update(qs).digest("hex").toUpperCase();
}

// ─── RUTAS DE SALUD/DIAGNÓSTICO ────────────────────────────────────
app.get("/", (_req, res) => res.send("OK KSAPP-BACKEND"));
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// No muestra valores, solo confirma presencia
app.get("/diag/env", (_req, res) => {
  res.json({
    hasApiKey: !!FLOW_API_KEY,
    hasSecret: !!FLOW_SECRET_KEY,
    urlReturn: URL_RETURN || null,
    urlConfirm: URL_CONFIRM || null,
  });
});

// ─── CREAR LINK DE PAGO ────────────────────────────────────────────
app.post("/api/payments/flow/create", async (req, res) => {
  try {
    const { amount, email, orderId, description } = req.body;

    console.log("FLOW create body:", req.body);

    if (!FLOW_API_KEY || !FLOW_SECRET_KEY) {
      console.error("Faltan llaves de Flow en ENV");
      return res.status(500).json({ ok: false, error: "Faltan llaves de Flow en ENV" });
    }
    const amt = Math.trunc(Number(amount));
    if (!amt || amt < 1 || !email || !orderId) {
      return res.status(400).json({ ok: false, error: "amount>=1, email y orderId son obligatorios" });
    }

    // Base de parámetros (en texto “limpio”)
    const baseParams = {
      apiKey: String(FLOW_API_KEY),
      amount: String(amt),                     // entero CLP
      commerceOrder: String(orderId),
      currency: "CLP",
      email: String(email),
      subject: (description || "Pago KSAPP").toString(),
      urlConfirmation: String(URL_CONFIRM),
      urlReturn: String(URL_RETURN),
    };

    // 1) Ordena -> 2) Construye QS -> 3) Firma en UPPER
    const ordered = orderedParams(baseParams);
    const qs = toQueryStringOrdered(ordered);
    const s = hmacHexUpper(qs, FLOW_SECRET_KEY);

    // 4) Cuerpo final = MISMO QS + s (mismo mecanismo)
    const withSig = new URLSearchParams(qs);
    withSig.append("s", s);
    const body = withSig.toString();

    // (Debug opcional mientras pruebas)
    // console.log("FLOW qs:", qs);
    // console.log("FLOW s:", s);

    const r = await axios.post(FLOW_CREATE_URL, body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 20000,
    });

    // Esperamos { url: "https://sandbox.flow.cl/btn/pay?token=..." }
    if (!r?.data?.url) {
      console.error("FLOW create unexpected response:", r?.data);
      return res.status(502).json({ ok: false, error: "Flow no devolvió URL" });
    }

    console.log("FLOW payment URL:", r.data.url);
    return res.json({ ok: true, paymentUrl: r.data.url });

  } catch (err) {
    const detail = err?.response?.data || err.message || String(err);
    console.error("FLOW create error detail:", detail);
    return res.status(500).json({ ok: false, error: detail });
  }
});

// ─── WEBHOOK (CONFIRMACIÓN) ────────────────────────────────────────
// GET solo para que no asuste si lo abres en navegador
app.get("/api/payments/flow/confirm", (_req, res) => {
  res.send("Webhook listo. Flow usará POST con 'token'.");
});

app.post("/api/payments/flow/confirm", async (req, res) => {
  try {
    const token = req.body?.token || req.query?.token;
    if (!token) return res.sendStatus(400);

    const base = {
      apiKey: String(FLOW_API_KEY),
      token: String(token),
    };
    const ordered = orderedParams(base);
    const qs = toQueryStringOrdered(ordered);
    const s = hmacHexUpper(qs, FLOW_SECRET_KEY);

    const withSig = new URLSearchParams(qs);
    withSig.append("s", s);
    const body = withSig.toString();

    const statusResp = await axios.post(FLOW_STATUS_URL, body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 20000,
    });

    console.log("FLOW payment status:", statusResp.data); // status 2 = pagado
    return res.sendStatus(200);
  } catch (err) {
    const detail = err?.response?.data || err.message || String(err);
    console.error("FLOW confirm error detail:", detail);
    return res.sendStatus(500);
  }
});

// ─── START ─────────────────────────────────────────────────────────
const REAL_PORT = PORT || 3000;
app.listen(REAL_PORT, () => console.log("KSAPP Flow API en puerto " + REAL_PORT));
