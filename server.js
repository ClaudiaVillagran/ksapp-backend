import express from "express";
import cors from "cors";
import axios from "axios";
import 'dotenv/config';

const app = express();
app.use(cors());
app.use(express.json());

const FLOW_API_KEY = process.env.FLOW_API_KEY;    
const FLOW_SECRET_KEY = process.env.FLOW_SECRET_KEY; 
const FLOW_CREATE_URL = "https://sandbox.flow.cl/api/payment/create";
const FLOW_STATUS_URL = "https://sandbox.flow.cl/api/payment/getStatus";

const URL_RETURN = process.env.URL_RETURN || "https://ksa.cl/pago-retorno";
const URL_CONFIRM = process.env.URL_CONFIRM || "https://TU-API.onrender.com/api/payments/flow/confirm";

app.post("/api/payments/flow/create", async (req, res) => {
  try {
    const { amount, email, orderId, description } = req.body;

    if (!FLOW_API_KEY) {
      return res.status(500).json({ error: "Falta FLOW_API_KEY en el servidor" });
    }

    const payload = {
      apiKey: FLOW_API_KEY,
      subject: description || "Pago KSAPP",
      currency: "CLP",
      amount,                 
      email,                  
      commerceOrder: orderId, 
      urlReturn: URL_RETURN,
      urlConfirmation: URL_CONFIRM
    };

    const r = await axios.post(FLOW_CREATE_URL, payload, {
      headers: { "Content-Type": "application/json" }
    });

    // Flow responde con { url: "https://sandbox.flow.cl/btn/pay?token=..." }
    return res.json({ ok: true, paymentUrl: r.data.url });
  } catch (err) {
    console.error("FLOW create error:", err?.response?.data || err.message);
    return res.status(500).json({ ok: false, error: "No se pudo crear el link de pago" });
  }
});

app.post("/api/payments/flow/confirm", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      console.warn("Webhook sin token");
      return res.sendStatus(400);
    }

    const statusResp = await axios.post(FLOW_STATUS_URL, {
      apiKey: FLOW_API_KEY,
      token
    }, { headers: { "Content-Type": "application/json" } });

    const payment = statusResp.data;

    console.log("FLOW payment status:", payment);

    return res.sendStatus(200);
  } catch (err) {
    console.error("FLOW confirm error:", err?.response?.data || err.message);
    return res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("KSAPP Flow API en puerto " + PORT));
