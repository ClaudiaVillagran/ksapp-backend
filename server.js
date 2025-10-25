// server.js
import express from "express";
import cors from "cors";
import axios from "axios";
import crypto from "crypto";
import "dotenv/config";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Flow (SANDBOX) ───────────────────────────────────────────────
const FLOW_BASE = "https://sandbox.flow.cl/api";
const FLOW_CREATE_URL = `${FLOW_BASE}/payment/create`;
const FLOW_STATUS_URL = `${FLOW_BASE}/payment/getStatus`;

const {
  FLOW_API_KEY,
  FLOW_SECRET_KEY,
  URL_RETURN,
  PORT,
  // Opción A: JSON completo
  FIREBASE_SERVICE_ACCOUNT,
  // Opción B: vars sueltas
  FIREBASE_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY
} = process.env;

// ─── Firebase Admin (no fallar al boot) ───────────────────────────
let adminReady = false;
try {
  if (!admin.apps.length) {
    let creds = null;

    if (FIREBASE_SERVICE_ACCOUNT) {
      // JSON completo pegado en ENV
      creds = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
    } else if (FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY) {
      // 3 vars sueltas
      creds = {
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
      };
    }

    if (creds) {
      admin.initializeApp({ credential: admin.credential.cert(creds) });
      adminReady = true;
      console.log("Firebase Admin inicializado con credenciales de ENV.");
    } else {
      // Intento de credenciales por defecto (no truena si no hay)
      admin.initializeApp();
      adminReady = true;
      console.log("Firebase Admin inicializado con credenciales por defecto.");
    }
  } else {
    adminReady = true;
  }
} catch (e) {
  adminReady = false;
  console.error("No se pudo inicializar Firebase Admin:", e?.message || e);
}

const db = () => {
  if (!adminReady) throw new Error("Firebase Admin no inicializado");
  return admin.firestore();
};

// ─── Firma Flow (concatenación nombre+valor en orden ascendente) ──
function flowSign(params, secret) {
  const keys = Object.keys(params).sort();
  let toSign = "";
  for (const k of keys) toSign += k + String(params[k]);
  return crypto.createHmac("sha256", secret).update(toSign).digest("hex");
}

// ─── Salud/diag ───────────────────────────────────────────────────
app.get("/", (_, res) => res.send("OK KSAPP-BACKEND"));
app.get("/health", (_, res) => res.json({ ok: true, ts: Date.now() }));
app.get("/diag/env", (_, res) => {
  res.json({
    hasFlowApi: !!FLOW_API_KEY,
    hasFlowSecret: !!FLOW_SECRET_KEY,
    urlReturn: URL_RETURN || null,
    firebaseAdminReady: adminReady
  });
});

// ─── 1) Crear link de pago ────────────────────────────────────────
app.post("/api/payments/flow/create", async (req, res) => {
  try {
    const { amount, email, orderId, description, uid } = req.body;

    if (!FLOW_API_KEY || !FLOW_SECRET_KEY) {
      return res.status(500).json({ ok: false, error: "Faltan llaves de Flow en ENV" });
    }
    if (!amount || !email || !orderId) {
      return res.status(400).json({ ok: false, error: "amount, email y orderId son obligatorios" });
    }

    const base = {
      apiKey: FLOW_API_KEY,
      commerceOrder: String(orderId),                // <= 45 chars
      subject: description || "Pago KSAPP",
      currency: "CLP",
      amount: Number(amount),
      email: String(email),
      urlReturn: URL_RETURN || "https://ksa.cl/pago-retorno",
      // urlConfirmation: versión simple: NO usamos webhook
      optional: uid ? JSON.stringify({ uid }) : undefined
    };
    Object.keys(base).forEach((k) => base[k] === undefined && delete base[k]);

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
    return res.json({ ok: true, paymentUrl, token: r.data.token, commerceOrder: base.commerceOrder });
  } catch (err) {
    const detail = err?.response?.data || err.message || String(err);
    console.error("FLOW create error:", detail);
    return res.status(500).json({ ok: false, error: detail });
  }
});

// ─── 2) Verificar y activar plan ──────────────────────────────────
app.post("/api/payments/flow/checkAndActivate", async (req, res) => {
  try {
    const { token, uid, planKey, billing } = req.body;
    if (!token || !uid || !planKey) {
      return res.status(400).json({ ok: false, error: "token, uid y planKey son obligatorios" });
    }

    // Consultar estado en Flow
    const base = { apiKey: FLOW_API_KEY, token: String(token) };
    const s = flowSign(base, FLOW_SECRET_KEY);
    const body = new URLSearchParams({ ...base, s }).toString();

    const statusResp = await axios.post(FLOW_STATUS_URL, body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 20000
    });

    const st = statusResp.data;
    const paid = Number(st?.status) === 2;

    if (paid) {
      if (!adminReady) {
        // No tires el server; explica el problema
        return res.status(500).json({ ok: false, error: "Firebase no configurado en el backend (adminReady=false)" });
      }
      await db().collection("users").doc(uid).set(
        {
          isBusiness: true,
          businessPlan: planKey,
          businessSince: admin.firestore.FieldValue.serverTimestamp(),
          billing: billing || null
        },
        { merge: true }
      );
    }

    return res.json({ ok: true, paid, flowStatus: st?.status });
  } catch (err) {
    const detail = err?.response?.data || err.message || String(err);
    console.error("FLOW check error:", detail);
    return res.status(500).json({ ok: false, error: detail });
  }
});

// ─── Start ────────────────────────────────────────────────────────
const REAL_PORT = PORT || 3000;
app.listen(REAL_PORT, () => console.log("KSAPP Flow API en puerto " + REAL_PORT));
