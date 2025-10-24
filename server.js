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

const {
  FLOW_API_KEY,
  FLOW_SECRET_KEY,
  URL_RETURN,
  URL_CONFIRM,
  PORT
} = process.env;

// ─── UTILS DE FIRMA SEGÚN DOC OFICIAL ─────────────────────────────
// 1) Ordena alfabéticamente las claves
// 2) Concatena "clave + valor" (sin separadores)
// 3) HMAC-SHA256(secret) -> hex minúsculas
function signParams(params, secret) {
  const keys = Object.keys(params).sort();
  let toSign = "";
  for (const k of keys) {
    toSign += k + String(params[k]);
  }
  return crypto.createHmac("sha256", secret).update(toSign).digest("hex"); // hex minúsculas
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

    // Base de parámetros SIN s
    const base = {
      apiKey: String(FLOW_API_KEY),
      commerceOrder: String(orderId),
      subject: (description || "Pago KSAPP").toString(),
      currency: "CLP",
      amount: String(amt),               // CLP entero
      email: String(email),
      urlReturn: String(URL_RETURN),
      urlConfirmation: String(URL_CONFIRM),
    };

    // Firma correcta (concat clave+valor ordenados)
    const s = signParams(base, FLOW_SECRET_KEY);

    // Envío x-www-form-urlencoded
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
    // Flow hace POST x-www-form-urlencoded; token puede venir en body o query
    const token = req.body?.token || req.query?.token;
    if (!token) return res.sendStatus(400);

    const base = {
      apiKey: String(FLOW_API_KEY),
      token: String(token),
    };
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
