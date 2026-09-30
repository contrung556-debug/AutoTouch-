// api/find-target.js  (Vercel Serverless Function)
// Env cần đặt trên Vercel: GEMINI_API_KEY  (tùy chọn: GEMINI_MODEL)

// DÁN KEY GEMINI CỦA BẠN VÀO ĐÂY (giữa hai dấu ngoặc kép):
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "DÁN_KEY_VÀO_ĐÂY";

export const config = {
  api: { bodyParser: { sizeLimit: "4mb" } },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Chỉ hỗ trợ POST" });
  }

  try {
    const { image, target, width, height, mime, key, model: clientModel } = req.body || {};
    const apiKey = key || GEMINI_API_KEY;
    if (!image || !target || !apiKey || apiKey === "DÁN_KEY_VÀO_ĐÂY") {
      return res.status(400).json({ success: false, error: "Thiếu image, target hoặc key" });
    }

    const model = clientModel || process.env.GEMINI_MODEL || "gemini-3.8-flash";
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      model + ":generateContent?key=" + apiKey;

    const prompt =
      'Tìm chữ "' + target + '" hiển thị trên ảnh chụp màn hình này. ' +
      "Nếu có nhiều vị trí, chọn nhãn/ô rõ nhất ở phía trên. " +
      'Chỉ trả về JSON: {"found": true/false, "box_2d": [ymin, xmin, ymax, xmax]} ' +
      "với tọa độ chuẩn hóa từ 0 đến 1000. Nếu không thấy thì found=false.";

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mime || "image/png", data: image } },
            ],
          },
        ],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ success: false, error: "Gemini lỗi " + r.status, detail: t });
    }

    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const out = JSON.parse(text.replace(/```json|```/g, "").trim());
    const box = Array.isArray(out) ? out[0]?.box_2d : out.box_2d;
    const found = (Array.isArray(out) ? true : out.found) && Array.isArray(box) && box.length === 4;

    if (!found) {
      return res.status(200).json({ success: true, found: false });
    }

    const [ymin, xmin, ymax, xmax] = box;
    const nx = (xmin + xmax) / 2; // 0..1000
    const ny = (ymin + ymax) / 2; // 0..1000

    // AutoTouch dùng pixel gốc => quy đổi theo kích thước thật của ảnh PNG.
    // Header PNG: width ở byte 16-19, height ở byte 20-23 (big-endian).
    const buf = Buffer.from(image, "base64");
    let W = Number(width) || 0;
    let H = Number(height) || 0;
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
      W = buf.readUInt32BE(16);
      H = buf.readUInt32BE(20);
    }
    if (!W || !H) {
      return res.status(200).json({ success: false, error: "Không xác định được kích thước ảnh", nx, ny });
    }

    return res.status(200).json({
      success: true,
      found: true,
      x: Math.round((nx / 1000) * W),
      y: Math.round((ny / 1000) * H),
      nx, ny, box,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e) });
  }
}
