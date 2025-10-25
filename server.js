// server.js
import express from "express";
import cors from "cors";
import axios from "axios";
import crypto from "crypto";
import "dotenv/config";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Flow sandbox
const FLOW_BASE = "https://sandbox.flow.cl/api";
const FLOW_CREATE_URL = `${FLOW_BASE}/payment/create`;
const FLOW_STATUS_URL = `${FLOW_BASE}/payment/getStatus`;

const {
  FLOW_API_KEY,
  FLOW_SECRET_KEY,
  URL_RETURN,
  URL_CONFIRM,
  PORT
} = process.env;

// Firma Flow: concatenación (nombre + valor) ordenado por clave
function flowSign(params, secret) {
  const keys = Object.keys(params).sort();
  let toSign = "";
  for (const k of keys) toSign += k + String(params[k]);
  return crypto.createHmac("sha256", secret).update(toSign).digest("hex");
}

// Salud/diag
app.get("/", (_, res) => res.send("OK KSAPP-BACKEND"));
app.get("/health", (_, res) => res.json({ ok: true, ts: Date.now() }));
app.get("/diag/env", (_, res) =>
  res.json({
    hasFlowApi: !!FLOW_API_KEY,
    hasFlowSecret: !!FLOW_SECRET_KEY,
    urlReturn: URL_RETURN || null,
    urlConfirm: URL_CONFIRM || null
  })
);

// Crear link de pago
app.post("/api/payments/flow/create", async (req, res) => {
  try {
    const { amount, email, orderId, description } = req.body;

    if (!FLOW_API_KEY || !FLOW_SECRET_KEY) {
      return res.status(500).json({ ok: false, error: "Faltan llaves de Flow en ENV" });
    }
    if (!amount || !email || !orderId) {
      return res.status(400).json({ ok: false, error: "amount, email y orderId son obligatorios" });
    }

    // Reglas Flow:
    // - commerceOrder <= 45 chars
    const safeOrder = String(orderId).slice(0, 45);

    const base = {
      apiKey: FLOW_API_KEY,
      commerceOrder: safeOrder,
      subject: description || "Pago KSAPP",
      currency: "CLP",
      amount: Number(amount),
      email: String(email),
      urlReturn: URL_RETURN || "https://ksa.cl/pago-retorno",
      urlConfirmation: URL_CONFIRM || "https://ksapp-backend.onrender.com/api/payments/flow/confirm"
    };

    const s = flowSign(base, FLOW_SECRET_KEY);
    const body = new URLSearchParams({ ...base, s }).toString();

    const r = await axios.post(FLOW_CREATE_URL, body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 20000
    });

    if (!r?.data?.url || !r?.data?.token) {
      console.error("FLOW create unexpected:", r?.data);
      return res.status(502).json({ ok: false, error: "Flow no devolvió url/token" });
    }

    const paymentUrl = `${r.data.url}?token=${r.data.token}`;
    return res.json({ ok: true, paymentUrl, token: r.data.token, commerceOrder: safeOrder });
  } catch (err) {
    const detail = err?.response?.data || err.message || String(err);
    console.error("FLOW create error:", detail);
    return res.status(500).json({ ok: false, error: detail });
  }
});

// Webhook (confirmación de Flow) – opcional, lo dejamos “ok”
app.get("/api/payments/flow/confirm", (_, res) =>
  res.send("Webhook listo. Usa POST con 'token'.")
);
app.post("/api/payments/flow/confirm", async (req, res) => {
  try {
    const token = req.body?.token || req.query?.token;
    if (!token) return res.sendStatus(400);
    console.log("Confirmación Flow recibida. token:", token);
    return res.sendStatus(200);
  } catch {
    return res.sendStatus(500);
  }
});

// Endpoint para consultar estado por token (el frontend lo llama)
app.post("/api/payments/flow/check", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ ok: false, error: "token es obligatorio" });

    const base = { apiKey: FLOW_API_KEY, token: String(token) };
    const s = flowSign(base, FLOW_SECRET_KEY);
    const body = new URLSearchParams({ ...base, s }).toString();

    const statusResp = await axios.post(FLOW_STATUS_URL, body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 20000
    });

    // status: 2 = pagado (según doc)
    const st = statusResp.data;
    const paid = Number(st?.status) === 2;

    return res.json({ ok: true, paid, flowStatus: st?.status, raw: st });
  } catch (err) {
    const detail = err?.response?.data || err.message || String(err);
    console.error("FLOW check error:", detail);
    return res.status(500).json({ ok: false, error: detail });
  }
});

const REAL_PORT = PORT || 3000;
app.listen(REAL_PORT, () => console.log("KSAPP Flow API en puerto " + REAL_PORT));
