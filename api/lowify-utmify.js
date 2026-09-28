// Ponte Lowify -> Utmify
// A Lowify envia o webhook da venda para cá; esta função converte para o formato
// da API da Utmify (https://docs.utmify.com.br/envio-de-vendas) e repassa.
//
// Variáveis de ambiente (Vercel → Settings → Environment Variables):
//   UTMIFY_API_TOKEN        token da credencial de API gerada na Utmify
//   LOWIFY_WEBHOOK_SECRET   chave que precisa vir na URL (?k=...) para aceitar o webhook

const UTMIFY_URL = "https://api.utmify.com.br/api-credentials/orders";

const STATUS = {
  "sale.paid": "paid",
  "sale.pending": "waiting_payment",
  "sale.refunded": "refunded",
  "sale.chargeback": "chargedback",
  "sale.chargedback": "chargedback",
  "sale.refused": "refused",
};

const PAYMENT = { credit_card: "credit_card", card: "credit_card", cartao: "credit_card", boleto: "boleto", pix: "pix", paypal: "paypal" };

// A Lowify manda "YYYY-MM-DD HH:MM:SS" no horário de Brasília; a Utmify quer UTC.
function toUtc(ts) {
  if (!ts) return null;
  const d = new Date(String(ts).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? "" : "-03:00"));
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

const cents = (v) => Math.round(Number(v || 0) * 100);

function convert(body, isTest) {
  const status = STATUS[body.event] || body.status && { paid: "paid", pending: "waiting_payment", refunded: "refunded", chargedback: "chargedback", refused: "refused" }[body.status];
  if (!status) return null;
  const when = toUtc(body.timestamp) || toUtc(new Date().toISOString());
  const p = body.product || {};
  const c = body.customer || {};
  const t = body.tracking || {};
  const total = cents(body.sale_amount != null ? body.sale_amount : p.price);
  const pm = String(body.payment_method || body.paymentMethod || "").toLowerCase();

  return {
    orderId: String(body.order_id),
    platform: "Lowify",
    paymentMethod: PAYMENT[pm] || "pix",
    status,
    createdAt: toUtc(body.created_at) || when,
    approvedDate: status === "paid" ? when : null,
    refundedAt: status === "refunded" || status === "chargedback" ? when : null,
    customer: {
      name: c.name || "Cliente",
      email: c.email || "",
      phone: c.phone || null,
      document: c.document || null,
      country: "BR",
      ...(c.ip ? { ip: c.ip } : {}),
    },
    products: [{
      id: String(p.id != null ? p.id : "produto"),
      name: p.name || "Produto",
      planId: null,
      planName: null,
      quantity: 1,
      priceInCents: cents(p.price != null ? p.price : body.sale_amount),
    }],
    trackingParameters: {
      src: t.src || null,
      sck: t.sck || null,
      utm_source: t.utm_source || null,
      utm_campaign: t.utm_campaign || null,
      utm_medium: t.utm_medium || null,
      utm_content: t.utm_content || null,
      utm_term: t.utm_term || null,
    },
    commission: {
      totalPriceInCents: total,
      gatewayFeeInCents: 0,
      userCommissionInCents: total,
      currency: "BRL",
    },
    isTest: !!isTest,
  };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "use POST" });

  const secret = process.env.LOWIFY_WEBHOOK_SECRET;
  if (!secret || req.query.k !== secret) return res.status(401).json({ ok: false, error: "chave inválida" });

  const token = process.env.UTMIFY_API_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: "UTMIFY_API_TOKEN não configurado" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || !body.order_id) return res.status(400).json({ ok: false, error: "payload sem order_id" });

  const order = convert(body, req.query.test === "1");
  if (!order) return res.status(200).json({ ok: true, ignored: body.event || body.status });

  const r = await fetch(UTMIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-token": token },
    body: JSON.stringify(order),
  });
  const text = await r.text();
  if (!r.ok) {
    console.error("Utmify recusou", r.status, text, JSON.stringify(order));
    return res.status(502).json({ ok: false, utmifyStatus: r.status, utmify: text });
  }
  return res.status(200).json({ ok: true, orderId: order.orderId, status: order.status });
};

module.exports.convert = convert;
