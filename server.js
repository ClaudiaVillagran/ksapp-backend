const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");

const {
  FLOW_API_KEY,
  FLOW_SECRET_KEY,
  URL_CONFIRM,
  URL_RETURN,
  PORT = 3000,
} = process.env;

const app = express();
app.use(cors());
app.use(express.json());

/** === Utilidades para Flow ===
 * Firma HMAC-SHA256 con las "key=value" ordenadas alfabéticamente unidas por "&"
 */
function buildSign(payloadObj, secret) {
  const ordered = Object.keys(payloadObj)
    .sort()
    .map((k) => `${k}=${payloadObj[k]}`)
    .join("&");
  return crypto.createHmac("sha256", secret).update(ordered).digest("hex");
}

// Mapea status de Flow -> etiqueta comprensible
function mapFlowStatus(status) {
  // Basado en la doc de Flow:
  // 1: created, 2: paid, 3: rejected, 4: canceled, 5: expired, 6: refunded (si aplica)
  switch (Number(status)) {
    case 2:
      return "paid";
    case 3:
      return "rejected";
    case 4:
      return "canceled";
    case 5:
      return "expired";
    default:
      return "pending";
  }
}

const FLOW_BASE = "https://sandbox.flow.cl/api";

/**
 * Crea orden en Flow y devuelve {token, url}
 * Body esperado:
 *  - commerceOrder (string)
 *  - subject (string)
 *  - email (string)
 *  - amount (number, en CLP)
 */
app.post("/api/payments/flow/create", async (req, res) => {
  try {
    const { commerceOrder, subject, email, amount } = req.body;

    if (!commerceOrder || !subject || !email || !amount) {
      return res.status(400).json({ error: "Faltan campos requeridos." });
    }

    const payload = {
      apiKey: FLOW_API_KEY,
      commerceOrder,
      subject,
      currency: "CLP",
      amount,
      email,
      urlConfirmation: URL_CONFIRM,
      urlReturn: URL_RETURN,
    };

    const s = buildSign(payload, FLOW_SECRET_KEY);

    const { data } = await axios.post(`${FLOW_BASE}/payment/create`, {
      ...payload,
      s,
    });

    // Flow devuelve { token, url }
    if (!data?.token || !data?.url) {
      return res.status(500).json({ error: "Respuesta inválida de Flow." });
    }

    return res.json({
      token: data.token,
      redirectUrl: `${data.url}?token=${data.token}`,
    });
  } catch (err) {
    console.error("Flow create error:", err?.response?.data || err.message);
    return res.status(500).json({
      error: "No se pudo crear la orden en Flow.",
      detail: err?.response?.data || err.message,
    });
  }
});

/**
 * Consulta de estado por token (para usar al volver a la app)
 */
app.get("/api/payments/flow/status/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const payload = { apiKey: FLOW_API_KEY, token };
    const s = buildSign(payload, FLOW_SECRET_KEY);

    const { data } = await axios.post(`${FLOW_BASE}/payment/getStatus`, {
      ...payload,
      s,
    });

    // data.status: 1..5
    const mapped = mapFlowStatus(data?.status);
    return res.json({
      raw: data,
      status: mapped,
    });
  } catch (err) {
    console.error("Flow status error:", err?.response?.data || err.message);
    return res.status(500).json({
      error: "No se pudo consultar el estado en Flow.",
      detail: err?.response?.data || err.message,
    });
  }
});

/**
 * Webhook de confirmación (Flow POSTEA aquí)
 * IMPORTANTE: validar firma (s) para seguridad.
 * Si quieres actualizar Firestore desde el backend, lo puedes hacer acá.
 */
app.post("/api/payments/flow/confirm", async (req, res) => {
  try {
    const body = req.body || {};
    const { s: signatureFromFlow, ...rest } = body;

    // Verifica firma
    const localSign = buildSign(rest, FLOW_SECRET_KEY);
    if (localSign !== signatureFromFlow) {
      console.warn("Firma inválida en webhook Flow");
      return res.status(400).send("Bad signature");
    }

    // Opcional: pedir estado definitivo a Flow (buena práctica)
    // NOTA: rest.token viene en el body.
    if (!rest.token) {
      return res.status(400).send("Missing token");
    }

    const statusPayload = { apiKey: FLOW_API_KEY, token: rest.token };
    const s = buildSign(statusPayload, FLOW_SECRET_KEY);
    const { data } = await axios.post(`${FLOW_BASE}/payment/getStatus`, {
      ...statusPayload,
      s,
    });

    const finalStatus = mapFlowStatus(data?.status);

    // === (OPCIONAL) Actualizar Firestore desde el backend ===
    // const admin = require("firebase-admin");
    // if (!admin.apps.length) {
    //   admin.initializeApp({
    //     // Si estás en Render/Cloud Run con credenciales por variable de entorno:
    //     credential: admin.credential.applicationDefault(),
    //   });
    // }
    // const db = admin.firestore();
    // await db.collection("orders").doc(rest.commerceOrder).set(
    //   {
    //     flow: data,
    //     status: finalStatus,
    //     updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    //   },
    //   { merge: true }
    // );

    // Flow requiere 200 OK con texto "OK"
    return res.status(200).send("OK");
  } catch (err) {
    console.error("Flow confirm error:", err?.response?.data || err.message);
    // Igual respondemos 200 OK para no provocar reintentos infinitos, pero logueamos
    return res.status(200).send("OK");
  }
});

app.listen(PORT, () => {
  console.log(`KSAPP backend running on :${PORT}`);
});
