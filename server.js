// server.js (versión resumida con lo clave para el status)

import express from "express";
import cors from "cors";
import axios from "axios";
import crypto from "crypto";
import "dotenv/config";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const FLOW_BASE = "https://sandbox.flow.cl/api";
const FLOW_CREATE_URL = `${FLOW_BASE}/payment/create`;
const FLOW_STATUS_BY_COMMERCE = `${FLOW_BASE}/payment/getStatusByCommerceId`;
const FLOW_STATUS_BY_TOKEN = `${FLOW_BASE}/payment/getStatus`;

const { FLOW_API_KEY, FLOW_SECRET_KEY, URL_RETURN, URL_CONFIRM, PORT } = process.env;

app.get("/", (_, res) => res.send("OK KSAPP-BACKEND"));
app.get("/diag/env", (_, res) => {
  res.json({
    hasApiKey: !!FLOW_API_KEY,
    hasSecret: !!FLOW_SECRET_KEY,
    urlReturn: URL_RETURN || null,
    urlConfirm: URL_CONFIRM || null,
  });
});

function signParamsConcat(params, secret) {
  const keys = Object.keys(params).sort();
  const toSign = keys.map(k => `${k}${params[k]}`).join("");
  return crypto.createHmac("sha256", secret).update(toSign).digest("hex");
}

// Crear link de pago
app.post("/api/payments/flow/create", async (req, res) => {
  try {
    const { amount, email, orderId, description } = req.body;
    if (!FLOW_API_KEY || !FLOW_SECRET_KEY) return res.status(500).json({ ok: false, error: "Faltan llaves de Flow" });
    if (!amount || !email || !orderId) return res.status(400).json({ ok: false, error: "amount, email, orderId requeridos" });

    const payload = {
      apiKey: FLOW_API_KEY,
      commerceOrder: String(orderId),
      subject: description || "Pago KSAPP",
      currency: "CLP",
      amount: Number(amount),
      email: String(email),
      urlReturn: URL_RETURN,
      urlConfirmation: URL_CONFIRM,
    };
    const s = signParamsConcat(payload, FLOW_SECRET_KEY);
    const body = new URLSearchParams({ ...payload, s }).toString();

    const r = await axios.post(FLOW_CREATE_URL, body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 20000,
    });

    if (!r?.data?.url) return res.status(502).json({ ok: false, error: "Flow no devolvió URL" });
    return res.json({ ok: true, paymentUrl: r.data.url });
  } catch (err) {
    const detail = err?.response?.data || err.message || String(err);
    console.error("FLOW create error:", detail);
    return res.status(500).json({ ok: false, error: detail });
  }
});

// Webhook informativo (opcional)
app.get("/api/payments/flow/confirm", (_, res) => {
  res.send("Webhook listo. Flow usará POST con 'token'.");
});

app.post("/api/payments/flow/confirm", async (req, res) => {
  try {
    const token = req.body?.token || req.query?.token;
    if (!token) return res.sendStatus(400);
    const base = { apiKey: FLOW_API_KEY, token: String(token) };
    const s = signParamsConcat(base, FLOW_SECRET_KEY);
    const body = new URLSearchParams({ ...base, s }).toString();
    const r = await axios.post(FLOW_STATUS_BY_TOKEN, body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 20000,
    });
    console.log("FLOW confirm status:", r.data); // status 2 = pagado
    return res.sendStatus(200);
  } catch (err) {
    const detail = err?.response?.data || err.message || String(err);
    console.error("FLOW confirm error:", detail);
    return res.sendStatus(500);
  }
});

// 👇 NUEVO: consultar estado por commerceOrder (para el polling del front)
app.get("/api/payments/flow/status", async (req, res) => {
  try {
    const commerceOrder = req.query?.commerceOrder;
    if (!commerceOrder) return res.status(400).json({ ok: false, error: "commerceOrder requerido" });

    const params = { apiKey: FLOW_API_KEY, commerceId: String(commerceOrder) };
    const s = signParamsConcat(params, FLOW_SECRET_KEY);
    const url = `${FLOW_STATUS_BY_COMMERCE}?apiKey=${encodeURIComponent(params.apiKey)}&commerceId=${encodeURIComponent(params.commerceId)}&s=${encodeURIComponent(s)}`;

    const r = await axios.get(url, { timeout: 20000 });
    // r.data.status: 1 creado | 2 pagado | 3 rechazado | 4 anulado
    return res.json({ ok: true, status: r.data?.status ?? null, raw: r.data });
  } catch (err) {
    const detail = err?.response?.data || err.message || String(err);
    console.error("FLOW status error:", detail);
    return res.status(500).json({ ok: false, error: detail });
  }
});

const REAL_PORT = PORT || 3000;
app.listen(REAL_PORT, () => console.log("KSAPP Flow API en puerto " + REAL_PORT));
