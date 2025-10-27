// server.js
import express from "express";
import cors from "cors";
import axios from "axios";
import crypto from "crypto";
import "dotenv/config";

const app = express();

// CORS (ajusta origins si quieres)
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

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
    urlConfirm: URL_CONFIRM || null,
  })
);

// Crear link de pago
app.post("/api/payments/flow/create", async (req, res) => {
  try {
    const { amount, email, orderId, description } = req.body;

    if (!FLOW_API_KEY || !FLOW_SECRET_KEY) {
      return res.status(200).json({ ok: false, status: null, paid: false, raw: null, error: "Faltan llaves de Flow en ENV", transient: false });
    }
    if ((!amount && amount !== 0) || !email || !orderId) {
      return res.status(200).json({ ok: false, status: null, paid: false, raw: null, error: "amount, email y orderId son obligatorios", transient: false });
    }

    // Reglas Flow:
    const safeOrder = String(orderId).slice(0, 45);

    const base = {
      apiKey: FLOW_API_KEY,
      commerceOrder: safeOrder,
      subject: description || "Pago KSAPP",
      currency: "CLP",
      amount: Number(amount),
      email: String(email),
      urlReturn: URL_RETURN || "https://ksa.cl/pago-retorno",
      urlConfirmation: URL_CONFIRM || "https://ksapp-backend.onrender.com/api/payments/flow/confirm",
    };

    const s = flowSign(base, FLOW_SECRET_KEY);
    const body = new URLSearchParams({ ...base, s }).toString();

    const r = await axios.post(FLOW_CREATE_URL, body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 20000,
    });

    if (!r?.data?.url || !r?.data?.token) {
      console.error("FLOW create unexpected:", r?.data);
      return res.status(200).json({ ok: false, status: null, paid: false, raw: r?.data || null, error: "Flow no devolvió url/token", transient: false });
    }

    const paymentUrl = `${r.data.url}?token=${r.data.token}`;
    return res.json({ ok: true, paymentUrl, token: r.data.token, commerceOrder: safeOrder });
  } catch (err) {
    const detail = err?.response?.data || err.message || String(err);
    console.error("FLOW create error:", detail);
    return res.status(200).json({ ok: false, status: null, paid: false, raw: detail, error: typeof detail === "string" ? detail : (detail?.message || "Error creando pago en Flow"), transient: false });
  }
});

// Webhook (confirmación de Flow) – opcional
app.get("/api/payments/flow/confirm", (_, res) =>
  res.send("Webhook listo. Usa POST con 'token'.")
);

app.post("/api/payments/flow/confirm", async (req, res) => {
  try {
    const token = req.body?.token || req.query?.token;
    if (!token) return res.sendStatus(400);
    console.log("Confirmación Flow recibida. token:", token);
    // Aquí podrías consultar getStatus y actualizar tu BD.
    return res.sendStatus(200);
  } catch {
    return res.sendStatus(500);
  }
});

// Utilidad: consultar estado por token (shape estable)
async function getFlowStatusByToken(token) {
  if (!FLOW_API_KEY || !FLOW_SECRET_KEY) {
    return { ok: false, status: null, paid: false, raw: null, error: "Faltan llaves de Flow en ENV", transient: false };
  }
  try {
    const base = { apiKey: FLOW_API_KEY, token: String(token) };
    const s = flowSign(base, FLOW_SECRET_KEY);
    const body = new URLSearchParams({ ...base, s }).toString();

    const statusResp = await axios.post(FLOW_STATUS_URL, body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 20000,
    });

    const st = statusResp.data;                 // Respuesta de Flow
    const status = Number(st?.status) || null;  // 1,2,3,4
    const paid = status === 2;

    console.log("[FLOW:getStatus] ok token=", token, "status=", status);
    return { ok: true, status, paid, raw: st, error: null, transient: false };
  } catch (err) {
    const detail = err?.response?.data || err.message || String(err);
    const isObj = typeof detail === "object" && detail !== null;
    const code = isObj ? Number(detail.code) : null;
    const isTransient = code === 105 || (isObj && /No services available/i.test(detail?.message || ""));
    console.error("[FLOW:getStatus] ERROR token=", token, "detail=", detail);
    return {
      ok: false,
      status: null,
      paid: false,
      raw: detail,
      error: isObj ? (detail?.message || "Error consultando Flow") : String(detail),
      transient: !!isTransient,
    };
  }
}

// Endpoint que acepta GET y POST (shape estable)
app.all("/api/payments/flow/check", async (req, res) => {
  const token = req.body?.token || req.query?.token;
  if (!token) {
    return res.status(200).json({ ok: false, status: null, paid: false, raw: null, error: "token es obligatorio", transient: false });
  }
  const result = await getFlowStatusByToken(token);
  return res.status(200).json({ via: "CHECK", ...result });
});

// Alias compatible con el frontend: GET /status
app.get("/api/payments/flow/status", async (req, res) => {
  const token = req.query?.token;
  if (!token) {
    return res.status(200).json({ ok: false, status: null, paid: false, raw: null, error: "token es obligatorio", transient: false });
  }
  const result = await getFlowStatusByToken(token);
  return res.status(200).json({ via: "GET/status", ...result });
});

const REAL_PORT = PORT || 3000;
app.listen(REAL_PORT, () => console.log("KSAPP Flow API en puerto " + REAL_PORT));
