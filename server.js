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

// ─── RUTAS DE SALUD/DIAGNÓSTICO ────────────────────────────────────
app.get("/", (req, res) => res.send("OK KSAPP-BACKEND"));
app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

// No muestra valores, solo confirma presencia
app.get("/diag/env", (req, res) => {
  res.json({
    hasApiKey: !!FLOW_API_KEY,
    hasSecret: !!FLOW_SECRET_KEY,
    urlReturn: URL_RETURN || null,
    urlConfirm: URL_CONFIRM || null,
  });
});

// ─── FIRMA HMAC SHA256 ─────────────────────────────────────────────
function signParams(params, secret) {
  // 1) Ordena por clave ascendente
  const sortedKeys = Object.keys(params).sort();
  const sorted = {};
  for (const k of sortedKeys) sorted[k] = params[k];

  // 2) Querystring "k=v&k2=v2"
  const qs = new URLSearchParams(sorted).toString();

  // 3) HMAC-SHA256 (hex)
  return crypto.createHmac("sha256", secret).update(qs).digest("hex");
}

// ─── CREAR LINK DE PAGO ────────────────────────────────────────────
app.post("/api/payments/flow/create", async (req, res) => {
  try {
    const { amount, email, orderId, description } = req.body;

    console.log("FLOW create body:", req.body);

    if (!FLOW_API_KEY || !FLOW_SECRET_KEY) {
      console.error("Faltan llaves de Flow en ENV");
      return res.status(500).json({ ok: false, error: "Faltan llaves de Flow en ENV" });
    }
    if (!amount || !email || !orderId) {
      return res.status(400).json({ ok: false, error: "amount, email y orderId son obligatorios" });
    }

    // Base de parámetros según doc de Flow
    const base = {
      apiKey: FLOW_API_KEY,
      commerceOrder: String(orderId),
      subject: description || "Pago KSAPP",
      currency: "CLP",
      amount: String(Number(amount)), // en CLP
      email: String(email),
      urlReturn: URL_RETURN,
      urlConfirmation: URL_CONFIRM,
    };

    // Firma
    const s = signParams(base, FLOW_SECRET_KEY);

    // Body x-www-form-urlencoded (muchos endpoints de Flow lo piden así)
    const body = new URLSearchParams({ ...base, s }).toString();

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
    // DEVUELVE EL DETALLE (solo mientras pruebas). Luego vuelve a un mensaje genérico.
    return res.status(500).json({ ok: false, error: detail });
  }
});

// ─── WEBHOOK (CONFIRMACIÓN) ────────────────────────────────────────
app.get("/api/payments/flow/confirm", (req, res) => {
  res.send("Webhook listo. Flow usará POST con 'token'.");
});

app.post("/api/payments/flow/confirm", async (req, res) => {
  try {
    const token = req.body?.token || req.query?.token;
    if (!token) return res.sendStatus(400);

    const base = { apiKey: FLOW_API_KEY, token: String(token) };
    const s = signParams(base, FLOW_SECRET_KEY);
    const body = new URLSearchParams({ ...base, s }).toString();

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
