// ─────────────────────────────────────────────────────────────────────────────
// KSAPP Backend - Flow Sandbox Integration
// ─────────────────────────────────────────────────────────────────────────────

import express from "express";
import cors from "cors";
import axios from "axios";
import crypto from "crypto";
import "dotenv/config"; // lee .env en local

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ▸ Endpoints Flow (SANDBOX)
const FLOW_CREATE_URL = "https://sandbox.flow.cl/api/payment/create";
const FLOW_STATUS_BY_COMMERCE_URL = "https://sandbox.flow.cl/api/payment/getStatusByCommerceId";

// ▸ ENV
const { FLOW_API_KEY, FLOW_SECRET_KEY, URL_RETURN, URL_CONFIRM, PORT } = process.env;

// ─────────────────────────────────────────────────────────────────────────────
// Health & Diagnóstico
// ─────────────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("OK KSAPP-BACKEND"));
app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get("/diag/env", (req, res) => {
  res.json({
    hasApiKey: !!FLOW_API_KEY,
    hasSecret: !!FLOW_SECRET_KEY,
    urlReturn: URL_RETURN || null,
    urlConfirm: URL_CONFIRM || null,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Firma HMAC-SHA256 (Flow): concatenar "key"+"value" en orden alfabético
// ─────────────────────────────────────────────────────────────────────────────
function signParams(params, secret) {
  const sortedKeys = Object.keys(params).sort();
  let toSign = "";
  for (const k of sortedKeys) toSign += k + params[k];
  return crypto.createHmac("sha256", secret).update(toSign).digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// Crear link de pago
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/payments/flow/create", async (req, res) => {
  try {
    const { amount, email, orderId, description } = req.body;

    if (!FLOW_API_KEY || !FLOW_SECRET_KEY) {
      return res.status(500).json({ ok: false, error: "Faltan llaves de Flow en ENV" });
    }
    if (!amount || !email || !orderId) {
      return res.status(400).json({ ok: false, error: "amount, email y orderId son obligatorios" });
    }

    // Flow exige commerceOrder ≤ 45 chars: valida aquí por seguridad
    if (String(orderId).length > 45) {
      return res.status(400).json({ ok: false, error: "commerceOrder debe tener ≤ 45 caracteres" });
    }

    const base = {
      apiKey: FLOW_API_KEY,
      commerceOrder: String(orderId),
      subject: description || "Pago KSAPP",
      currency: "CLP",
      amount: String(Number(amount)),
      email: String(email),
      urlReturn: URL_RETURN,
      urlConfirmation: URL_CONFIRM,
    };

    const s = signParams(base, FLOW_SECRET_KEY);

    // Flow acepta x-www-form-urlencoded
    const body = new URLSearchParams({ ...base, s }).toString();

    const r = await axios.post(FLOW_CREATE_URL, body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 20000,
    });

    const { url, token, flowOrder } = r?.data || {};
    if (!url || !token) {
      return res.status(502).json({ ok: false, error: "Flow no devolvió url/token" });
    }

    const paymentUrl = `${url}?token=${token}`;
    return res.json({
      ok: true,
      paymentUrl,
      token,
      commerceOrder: base.commerceOrder,
      flowOrder: flowOrder || null,
    });
  } catch (err) {
    const detail = err?.response?.data || err.message || String(err);
    console.error("FLOW create error detail:", detail);
    return res.status(500).json({ ok: false, error: detail });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Consultar estado por commerceOrder (para polling desde la app)
// status: 2=pagado, 1=pendiente, 3=cancelado, 4=rechazado
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/payments/flow/status", async (req, res) => {
  try {
    const commerceOrder = req.query.commerceOrder;
    if (!commerceOrder) return res.status(400).json({ ok: false, error: "commerceOrder requerido" });

    const params = { apiKey: FLOW_API_KEY, commerceId: String(commerceOrder) };
    const s = signParams(params, FLOW_SECRET_KEY);
    const url = `${FLOW_STATUS_BY_COMMERCE_URL}?${new URLSearchParams({ ...params, s }).toString()}`;

    const r = await axios.get(url, { timeout: 15000 });
    return res.json({ ok: true, status: r.data.status || 0, raw: r.data });
  } catch (err) {
    const detail = err?.response?.data || err.message || String(err);
    console.error("FLOW status error:", detail);
    return res.status(500).json({ ok: false, error: detail });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// (Opcional) Webhook de confirmación (no necesario para el polling, pero útil)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/payments/flow/confirm", (req, res) => {
  res.send("Webhook listo. Flow enviará POST con 'token'.");
});

app.post("/api/payments/flow/confirm", (req, res) => {
  // Si más adelante quieres manejar webhooks, procesa req.body.token aquí:
  //   - Llamar /payment/getStatus con token
  //   - Actualizar base de datos
  // Por ahora respondemos 200 para evitar reintentos infinitos.
  return res.sendStatus(200);
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
const REAL_PORT = PORT || 3000;
app.listen(REAL_PORT, () => console.log("KSAPP Flow API en puerto " + REAL_PORT));
