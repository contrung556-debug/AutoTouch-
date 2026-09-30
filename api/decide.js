// api/decide.js  (Vercel Serverless Function)
// Nhận ảnh chụp màn hình + mục tiêu, trả về MỘT hành động kế tiếp.

export const config = {
  api: { bodyParser: { sizeLimit: "4mb" } },
};

const ACTIONS = ["tap", "swipe", "type", "wait", "done", "fail"];

function isPoint(p) {
  return (
    Array.isArray(p) &&
    p.length === 2 &&
    p.every((n) => typeof n === "number" && n >= 0 && n <= 1000)
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Chỉ hỗ trợ POST" });
  }

  try {
    const { image, goal, info, rules, history, key, model, mime } = req.body || {};
    if (!image || !goal || !key) {
      return res.status(400).json({ success: false, error: "Thiếu image, goal hoặc key" });
    }

    const useModel = model || "gemini-3.8-flash";
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      useModel + ":generateContent?key=" + key;

    const hist =
      Array.isArray(history) && history.length
        ? history.map((h, i) => i + 1 + ". " + h).join("\n")
        : "(chưa có bước nào)";

    const userRules =
      Array.isArray(rules) && rules.length
        ? rules.map((r, i) => i + 1 + ". " + r).join("\n")
        : "(không có)";

    const prompt =
      "Bạn là agent điều khiển iPhone thông qua ảnh chụp màn hình.\n" +
      "MỤC TIÊU: " + goal + "\n" +
      "LUẬT CỦA NGƯỜI DÙNG (bắt buộc tuân thủ, ưu tiên cao hơn mọi luật khác bên dưới):\n" +
      userRules + "\n" +
      "DỮ LIỆU ĐƯỢC PHÉP DÙNG ĐỂ NHẬP: " + (info || "(không có)") + "\n" +
      "CÁC BƯỚC GẦN ĐÂY ĐÃ LÀM:\n" + hist + "\n\n" +
      "Hãy nhìn ảnh và chọn ĐÚNG MỘT hành động kế tiếp. Chỉ trả JSON:\n" +
      '{"action":"tap|swipe|type|wait|done|fail","point":[y,x],"to_point":[y,x],"text":"","reason":"lý do ngắn"}\n' +
      "point và to_point là tọa độ chuẩn hóa 0-1000 theo thứ tự [y, x].\n\n" +
      "QUY TẮC:\n" +
      "- tap: point là tâm của phần tử cần chạm (nút, ô nhập, lựa chọn).\n" +
      "- swipe: từ point đến to_point (ví dụ cuộn trang).\n" +
      "- type: chỉ dùng khi ô nhập đã được chọn (thấy bàn phím hoặc con trỏ); text là chữ cần nhập, lấy từ DỮ LIỆU ĐƯỢC PHÉP DÙNG. Nếu chưa chọn ô thì tap vào ô trước.\n" +
      "- wait: khi màn hình đang tải hoặc đang chuyển cảnh.\n" +
      "- done: khi ảnh cho thấy mục tiêu đã hoàn thành.\n" +
      "- fail: khi bị kẹt, màn hình lạ, có yêu cầu xác minh/captcha, hoặc không thể làm tiếp.\n" +
      "- Không đoán tọa độ. Chỉ chạm vào phần tử thấy rõ trên ảnh.\n" +
      "- Nếu một hành động đã lặp lại mà màn hình không đổi, hãy đổi cách khác hoặc trả fail.\n" +
      "- Không tự bịa dữ liệu nhập ngoài DỮ LIỆU ĐƯỢC PHÉP DÙNG.";

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
    const item = Array.isArray(out) ? out[0] || {} : out;
    const action = String(item.action || "").toLowerCase();

    if (!ACTIONS.includes(action)) {
      return res.status(200).json({ success: false, error: "Hành động không hợp lệ", raw: item });
    }

    // Kích thước pixel thật của ảnh PNG (AutoTouch dùng pixel gốc)
    const buf = Buffer.from(image, "base64");
    let W = 0, H = 0;
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
      W = buf.readUInt32BE(16);
      H = buf.readUInt32BE(20);
    }
    if (!W || !H) {
      return res.status(200).json({ success: false, error: "Không xác định được kích thước ảnh" });
    }

    const result = { success: true, action, reason: String(item.reason || "") };

    if (action === "tap" || action === "swipe") {
      if (!isPoint(item.point)) {
        return res.status(200).json({ success: false, error: "Thiếu point hợp lệ", raw: item });
      }
      result.x = Math.round((item.point[1] / 1000) * W);
      result.y = Math.round((item.point[0] / 1000) * H);
    }
    if (action === "swipe") {
      if (!isPoint(item.to_point)) {
        return res.status(200).json({ success: false, error: "Thiếu to_point hợp lệ", raw: item });
      }
      result.x2 = Math.round((item.to_point[1] / 1000) * W);
      result.y2 = Math.round((item.to_point[0] / 1000) * H);
    }
    if (action === "type") {
      if (!item.text) {
        return res.status(200).json({ success: false, error: "Thiếu text để nhập", raw: item });
      }
      result.text = String(item.text);
    }

    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e) });
  }
}
