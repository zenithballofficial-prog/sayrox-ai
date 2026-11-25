// Sunucu tarafı: Groq anahtarı burada kalır, tarayıcıya hiç gitmez.
// Normal cevaplar parça parça (canlı) akıtılır. Görsel ve internet araması da burada yönetilir.

// Model adları Groq tarafında değişebilir. Hata alırsan önce bu üç satırı kontrol et.
const MODEL = "openai/gpt-oss-120b";          // yazı ve internet araması
const GORSEL_MODEL = "qwen/qwen3.8-27b";      // görsel okuyabilen model
const ARAMA_ARACI = { type: "browser_search" };

const TEMEL =
  "Sen Sayrox AI adlı bir Türkçe asistansın. Kullanıcı başka bir dilde yazarsa o dilde cevap ver. " +
  "Gerektiğinde kısa madde listeleri, kalın vurgu ve kod blokları kullan; " +
  "tablo ve başlıkları yalnızca gerçekten işe yaradığında kullan.";

// Arayüzdeki modlar. İstediğin gibi değiştirebilir, yeni mod ekleyebilirsin.
const MODLAR = {
  genel: "Kısa, net ve samimi cevap ver.",
  ogretmen:
    "Sabırlı bir öğretmen gibi anlat. Önce sade bir özet, sonra örnek ver. " +
    "Sonunda konuyu anlayıp anlamadığını kontrol eden tek bir kısa soru sor.",
  yazar:
    "Metin yazarı gibi davran. İstenen tonda, akıcı ve doğal bir Türkçeyle yaz. " +
    "Gerekirse kısa alternatifler sun.",
  kod:
    "Anlayışlı bir yazılımcı gibi davran. Kullanıcı yeni başlıyor olabilir: adım adım ve sade anlat, " +
    "kodu kod bloğu içinde ver ve ne yaptığını kısaca açıkla.",
};

const METIN_SINIRI = 24000;      // tek mesajdaki en fazla karakter
const TOPLAM_SINIR = 52000;      // tüm konuşmadaki en fazla karakter
const GORSEL_SINIRI = 1800000;   // tek görselin en fazla boyutu (karakter)
const GORSEL_SAYISI = 3;

function temizle(icerik, rol) {
  if (typeof icerik === "string") return icerik.slice(0, METIN_SINIRI);
  if (rol !== "user" || !Array.isArray(icerik)) return null;
  const parcalar = [];
  for (const p of icerik) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text" && typeof p.text === "string") {
      parcalar.push({ type: "text", text: p.text.slice(0, METIN_SINIRI) });
    } else if (
      p.type === "image_url" && p.image_url && typeof p.image_url.url === "string" &&
      /^data:image\/(jpeg|png|webp);base64,/.test(p.image_url.url) &&
      p.image_url.url.length <= GORSEL_SINIRI
    ) {
      parcalar.push({ type: "image_url", image_url: { url: p.image_url.url } });
    }
  }
  const gorseller = parcalar.filter((p) => p.type === "image_url");
  if (gorseller.length > GORSEL_SAYISI) {
    let fazla = gorseller.length - GORSEL_SAYISI;
    for (let i = parcalar.length - 1; i >= 0 && fazla > 0; i--) {
      if (parcalar[i].type === "image_url") { parcalar.splice(i, 1); fazla--; }
    }
  }
  return parcalar.length ? parcalar : null;
}

function uzunluk(icerik) {
  return typeof icerik === "string"
    ? icerik.length
    : icerik.reduce((t, p) => t + (p.type === "text" ? p.text.length : 0), 0);
}

function kaynaklar(mesaj) {
  const liste = [];
  const gorulen = new Set();
  const tara = (o, d) => {
    if (!o || d > 6 || liste.length >= 5) return;
    if (Array.isArray(o)) { o.forEach((x) => tara(x, d + 1)); return; }
    if (typeof o !== "object") return;
    if (typeof o.url === "string" && /^https?:\/\//.test(o.url) && !gorulen.has(o.url)) {
      gorulen.add(o.url);
      let baslik = typeof o.title === "string" && o.title.trim() ? o.title.trim() : "";
      if (!baslik) { try { baslik = new URL(o.url).hostname; } catch (e) { baslik = o.url; } }
      liste.push({ url: o.url, baslik: baslik.replace(/[\[\]]/g, "").slice(0, 90) });
    }
    Object.keys(o).forEach((k) => tara(o[k], d + 1));
  };
  tara(mesaj && mesaj.executed_tools, 0);
  return liste;
}

function bugun() {
  try {
    return new Date().toLocaleDateString("tr-TR", {
      timeZone: "Europe/Istanbul", day: "numeric", month: "long", year: "numeric", weekday: "long",
    });
  } catch (e) { return ""; }
}

async function hataMetni(r) {
  try {
    const t = await r.text();
    const j = JSON.parse(t);
    return (j && j.error && j.error.message ? String(j.error.message) : t).slice(0, 220);
  } catch (e) { return ""; }
}

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

  const mod = Object.prototype.hasOwnProperty.call(MODLAR, govde.mode) ? govde.mode : "genel";
  const ozel = typeof govde.ozel === "string" ? govde.ozel.trim().slice(0, 600) : "";
  const araIstendi = govde.search === true;

  // Mesajları temizle, en yeniden başlayarak karakter sınırına kadar al.
  const temiz = [];
  let toplam = 0;
  for (const m of gelen.slice(-20).reverse()) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const icerik = temizle(m.content, m.role);
    if (!icerik || uzunluk(icerik) === 0 && typeof icerik === "string") continue;
    const u = uzunluk(icerik);
    if (temiz.length && toplam + u > TOPLAM_SINIR) break;
    toplam += u;
    temiz.unshift({ role: m.role, content: icerik });
  }
  if (temiz.length === 0) {
    return res.status(400).json({ error: "Geçerli mesaj bulunamadı." });
  }

  const gorselVar = temiz.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"));
  const ara = araIstendi && !gorselVar;

  let sistem = TEMEL + " " + MODLAR[mod] + " Bugünün tarihi: " + bugun() + ".";
  if (ozel) sistem += " Kullanıcının kendi talimatı (her zaman dikkate al): " + ozel;
  if (ara) {
    sistem +=
      " İnternet aramasıyla güncel ve doğru bilgiyi bul. Arama sonuçlarını olduğu gibi yapıştırma; " +
      "kısa ve düzenli bir cevap yaz ve dayandığın sitelerin adlarını belirt.";
  }

  const iptal = new AbortController();
  res.on("close", () => iptal.abort());

  const istek = {
    model: gorselVar ? GORSEL_MODEL : MODEL,
    messages: [{ role: "system", content: sistem }, ...temiz],
    max_completion_tokens: 4096,
    stream: !ara,
  };
  if (ara) {
    istek.tools = [ARAMA_ARACI];
    istek.tool_choice = "required";
    istek.reasoning_effort = "low";
  }

  const cagir = (govdeJson) =>
    fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      signal: iptal.signal,
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(govdeJson),
    });

  let r;
  try {
    r = await cagir(istek);
    // Görselli istekte akış desteklenmiyorsa bir kez akışsız dene.
    if (!r.ok && gorselVar && r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 429) {
      istek.stream = false;
      r = await cagir(istek);
    }
  } catch (e) {
    return res.status(500).json({ error: "Sunucu hatası. Biraz sonra tekrar dene." });
  }

  if (r.status === 429) {
    return res.status(429).json({ error: "Ücretsiz kullanım sınırı doldu. Biraz bekleyip tekrar dene." });
  }
  if (r.status === 401) {
    return res.status(502).json({ error: "Groq anahtarı geçersiz. Vercel'deki GROQ_API_KEY ayarını kontrol et." });
  }
  if (!r.ok) {
    const detay = await hataMetni(r);
    return res.status(502).json({
      error: "Yapay zeka servisi hata verdi (kod " + r.status + ")." + (detay ? " Ayrıntı: " + detay : ""),
    });
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");

  // Akışsız yanıt (internet araması ya da yedek yol)
  if (!istek.stream) {
    try {
      const veri = await r.json();
      const mesaj = veri && veri.choices && veri.choices[0] && veri.choices[0].message;
      let metin = mesaj && typeof mesaj.content === "string" ? mesaj.content : "";
      metin = metin.replace(/[ \t]?【[^】]*】/g, "").trim();
      if (!metin) {
        return res.status(502).json({ error: "Boş cevap geldi. Tekrar dene." });
      }
      if (ara) {
        const k = kaynaklar(mesaj);
        if (k.length) metin += "\n\n**Kaynaklar**\n" + k.map((x) => "- [" + x.baslik + "](" + x.url + ")").join("\n");
      }
      return res.end(metin);
    } catch (e) {
      return res.status(502).json({ error: "Cevap okunamadı. Tekrar dene." });
    }
  }

  // Akışlı yanıt
  const okuyucu = r.body.getReader();
  const cozucu = new TextDecoder();
  let tampon = "";
  let yazildi = false;

  try {
    while (true) {
      const { done, value } = await okuyucu.read();
      if (done) break;
      tampon += cozucu.decode(value, { stream: true });
      let i;
      while ((i = tampon.indexOf("\n")) >= 0) {
        const satir = tampon.slice(0, i).trim();
        tampon = tampon.slice(i + 1);
        if (!satir.startsWith("data:")) continue;
        const d = satir.slice(5).trim();
        if (d === "[DONE]") continue;
        try {
          const j = JSON.parse(d);
          const t = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (t) {
            res.write(t);
            yazildi = true;
          }
        } catch (e) {}
      }
    }
  } catch (e) {
    if (!iptal.signal.aborted) {
      if (yazildi) {
        res.write("\n\n(Cevap yarıda kesildi.)");
      } else if (!res.headersSent) {
        return res.status(500).json({ error: "Sunucu hatası. Biraz sonra tekrar dene." });
      }
    }
  }
  res.end();
};
