const MODEL = "openai/gpt-oss-120b";

const SISTEM =
  "Sen Sayrox AI adlı, yardımsever bir Türkçe asistansın. " +
  "Kısa, net ve anlaşılır cevap ver. Kullanıcı başka bir dilde yazarsa o dilde cevap ver.";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Yalnızca POST isteği kabul edilir." });
  }

  const key = process.env.GROQ_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "Sunucuda GROQ_API_KEY ayarı yok." });
  }

  let govde = req.body;
  if (typeof govde === "string") {
    try { govde = JSON.parse(govde); } catch (e) { govde = null; }
  }
  const gelen = govde && Array.isArray(govde.messages) ? govde.messages : null;
  if (!gelen || gelen.length === 0) {
    return res.status(400).json({ error: "Mesaj bulunamadı." });
  }

  const mesajlar = gelen
    .slice(-20)
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

  if (mesajlar.length === 0) {
    return res.status(400).json({ error: "Geçerli mesaj bulunamadı." });
  }

  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: SISTEM }, ...mesajlar],
        max_completion_tokens: 4096,
      }),
    });

    if (r.status === 429) {
      return res.status(429).json({ error: "Ücretsiz kullanım sınırı doldu. Biraz bekleyip tekrar dene." });
    }
    if (!r.ok) {
      return res.status(502).json({ error: "Yapay zeka servisi hata verdi (kod " + r.status + ")." });
    }

    const veri = await r.json();
    const cevap =
      veri && veri.choices && veri.choices[0] && veri.choices[0].message
        ? veri.choices[0].message.content
        : "";
    if (!cevap) {
      return res.status(502).json({ error: "Boş cevap geldi. Tekrar dene." });
    }
    return res.status(200).json({ reply: cevap });
  } catch (e) {
    return res.status(500).json({ error: "Sunucu hatası. Biraz sonra tekrar dene." });
  }
};
