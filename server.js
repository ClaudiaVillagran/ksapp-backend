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

// 🔸 Mapa en memoria: commerceOrder -> token (útil para consultar por token luego)
const orderTokenMap = new Map();

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
  const toSign = keys.map((k) => `${k}${params[k]}`).join("");
  return crypto.createHmac("sha256", secret).update(toSign).digest("hex");
}

// Crear link de pago
app.post("/api/payments/flow/create", async (req, res) => {
  try {
    const { amount, email, orderId, description } = req.body;
    if (!FLOW_API_KEY || !FLOW_SECRET_KEY) {
      return res.status(500).json({ ok: false, error: "Faltan llaves de Flow" });
    }
    if (!amount || !email || !orderId) {
      return res.status(400).json({ ok: false, error: "amount, email, orderId requeridos" });
    }

    const payload = {
      apiKey: FLOW_API_KEY,
      commerceOrder: String(orderId),
      subject: description || "Pago KSAPP",
      currency: "CLP",
      amount: Number(amount),
      email: String(email),
      urlReturn: URL_RETURN || "",        // puedes dejar vacío si dependes del polling
      urlConfirmation: URL_CONFIRM || "", // PERO configúralo en Flow Sandbox
    };
    const s = signParamsConcat(payload, FLOW_SECRET_KEY);
    const body = new URLSearchParams({ ...payload, s }).toString();

    const r = await axios.post(FLOW_CREATE_URL, body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 20000,
    });

    if (!r?.data?.url || !r?.data?.token) {
      console.error("FLOW create: respuesta sin url o token", r?.data);
      return res.status(502).json({ ok: false, error: "Flow no devolvió URL y token" });
    }

    // Guardamos token en memoria para esa orden
    orderTokenMap.set(String(orderId), String(r.data.token));

    return res.json({ ok: true, paymentUrl: r.data.url, token: r.data.token });
  } catch (err) {
    const detail = err?.response?.data || err.message || String(err);
    console.error("FLOW create error:", detail);
    return res.status(500).json({ ok: false, error: detail });
  }
});

// Webhook informativo
app.get("/api/payments/flow/confirm", (_, res) => {
  res.send("Webhook listo. Flow usará POST con 'token'.");
});

app.post("/api/payments/flow/confirm", async (req, res) => {
  try {
    const token = req.body?.token || req.query?.token;
    if (!token) {
      console.warn("CONFIRM sin token");
      return res.sendStatus(400);
    }
    const base = { apiKey: FLOW_API_KEY, token: String(token) };
    const s = signParamsConcat(base, FLOW_SECRET_KEY);
    const body = new URLSearchParams({ ...base, s }).toString();

    const r = await axios.post(FLOW_STATUS_BY_TOKEN, body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 20000,
    });

    console.log("FLOW confirm status:", r.data); // status 2 = pagado

    // si viene commerceOrder, lo mapeamos también
    if (r?.data?.commerceOrder && token) {
      orderTokenMap.set(String(r.data.commerceOrder), String(token));
    }

    return res.sendStatus(200);
  } catch (err) {
    const detail = err?.response?.data || err.message || String(err);
    console.error("FLOW confirm error:", detail);
    return res.sendStatus(500);
  }
});

/**
 * Estado por commerceOrder O token.
 * - Si recibimos token (o lo tenemos mapeado), consultamos por token (más fiable).
 * - Si no, consultamos por commerceOrder.
 * Responde: { ok, status, raw, via }
 *
 * status: 1=creado | 2=pagado | 3=rechazado | 4=anulado
 */
app.get("/api/payments/flow/status", async (req, res) => {
  try {
    const qOrder = req.query?.commerceOrder ? String(req.query.commerceOrder) : null;
    const qToken = req.query?.token ? String(req.query.token) : null;

    // ¿Tenemos token directo o desde el mapa?
    const token = qToken || (qOrder ? orderTokenMap.get(qOrder) : null);

    if (token) {
      const base = { apiKey: FLOW_API_KEY, token };
      const s = signParamsConcat(base, FLOW_SECRET_KEY);
      const body = new URLSearchParams({ ...base, s }).toString();

      const r = await axios.post(FLOW_STATUS_BY_TOKEN, body, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 20000,
      });
      return res.json({ ok: true, status: r.data?.status ?? null, raw: r.data, via: "token" });
    }

    if (!qOrder) {
      return res.status(400).json({ ok: false, error: "commerceOrder o token requerido" });
    }

    // fallback: por commerceOrder
    const params = { apiKey: FLOW_API_KEY, commerceId: qOrder };
    const s = signParamsConcat(params, FLOW_SECRET_KEY);
    const url = `${FLOW_STATUS_BY_COMMERCE}?apiKey=${encodeURIComponent(
      params.apiKey
    )}&commerceId=${encodeURIComponent(params.commerceId)}&s=${encodeURIComponent(s)}`;

    const r = await axios.get(url, { timeout: 20000 });
    return res.json({ ok: true, status: r.data?.status ?? null, raw: r.data, via: "commerceId" });
  } catch (err) {
    const detail = err?.response?.data || err.message || String(err);
    console.error("FLOW status error:", detail);
    return res.status(500).json({ ok: false, error: detail });
  }
});

const REAL_PORT = PORT || 3000;
app.listen(REAL_PORT, () => console.log("KSAPP Flow API en puerto " + REAL_PORT));
