// ============================================================
// pages/api/analyze.js
// AUTOTOUCH VISION AGENT - bản viết lại (an toàn, không crash)
// ============================================================

export const config = {
  api: {
    bodyParser: { sizeLimit: "4.5mb" },
  },
  maxDuration: 60,
};

// ------------------------------------------------------------
// CẤU HÌNH
// ------------------------------------------------------------

const MODEL_ID = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const VERSION = "4.0-safe";
const ATTEMPTS = 2;
const TIMEOUT_MS = 22000;

const geminiUrl = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

function str(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function limit(value, max = 8000) {
  const text = str(value);
  return text.length <= max ? text : text.slice(0, max);
}

function num(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max, fallback) {
  const n = num(value, fallback);
  return Math.max(min, Math.min(max, Math.round(n)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function wait(reason, ms = 1000) {
  return { action: "wait", ms, reason: limit(reason, 500) };
}

// ------------------------------------------------------------
// ẢNH
// ------------------------------------------------------------

function normalizeImage(image) {
  if (!image) throw new Error("Thiếu image.");

  const value = String(image).trim();

  if (value.startsWith("data:")) {
    const match = value.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
    if (!match) throw new Error("Image data URI không hợp lệ.");
    return { mimeType: match[1], data: match[2].replace(/\s+/g, "") };
  }

  // base64 thuần: đoán định dạng theo chữ ký đầu file
  let mimeType = "image/png";
  if (value.startsWith("/9j/")) mimeType = "image/jpeg";
  else if (value.startsWith("UklGR")) mimeType = "image/webp";

  return { mimeType, data: value.replace(/\s+/g, "") };
}

// ------------------------------------------------------------
// PARSE JSON
// ------------------------------------------------------------

function extractJson(text) {
  if (!text) return null;

  const value = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(value);
  } catch {}

  const first = value.indexOf("{");
  const last = value.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(value.slice(first, last + 1));
    } catch {}
  }

  return null;
}

// ------------------------------------------------------------
// CHUẨN HÓA ACTION
// ------------------------------------------------------------

function normalizeStep(raw, { allowPlan }) {
  if (!raw || typeof raw !== "object") return null;

  const action = str(raw.action).toLowerCase().trim();
  const reason = limit(raw.reason, 500);

  switch (action) {
    case "tap": {
      const x = num(raw.x);
      const y = num(raw.y);
      if (x === null || y === null) return null;
      return {
        action: "tap",
        x: Math.round(x),
        y: Math.round(y),
        target: limit(raw.target, 300),
        reason,
      };
    }

    case "swipe": {
      const x1 = num(raw.x1);
      const y1 = num(raw.y1);
      const x2 = num(raw.x2);
      const y2 = num(raw.y2);
      if ([x1, y1, x2, y2].some((v) => v === null)) return null;
      return {
        action: "swipe",
        x1: Math.round(x1),
        y1: Math.round(y1),
        x2: Math.round(x2),
        y2: Math.round(y2),
        duration: clamp(raw.duration, 100, 3000, 400),
        reason,
      };
    }

    case "type": {
      const text = str(raw.text);
      if (!text) return null;
      return {
        action: "type",
        text,
        target: limit(raw.target, 300),
        reason,
      };
    }

    case "wait":
      return {
        action: "wait",
        ms: clamp(raw.ms, 300, 5000, 1000),
        reason: reason || "Chờ UI ổn định.",
      };

    case "done":
      return { action: "done", reason: reason || "Đã hoàn thành." };

    case "plan": {
      if (!allowPlan || !Array.isArray(raw.steps)) return null;
      const steps = raw.steps
        .slice(0, 5)
        .map((s) => normalizeStep(s, { allowPlan: false }))
        .filter(Boolean);
      if (steps.length === 0) return null;
      return { action: "plan", steps, reason: reason || "Thực hiện kế hoạch." };
    }

    default:
      return null;
  }
}

function normalizeAction(raw) {
  if (!raw || typeof raw !== "object") {
    return wait("Gemini không trả action hợp lệ.");
  }
  return (
    normalizeStep(raw, { allowPlan: true }) ||
    wait("Action thiếu dữ liệu hoặc không hợp lệ.")
  );
}

// ------------------------------------------------------------
// PROMPT
// ------------------------------------------------------------

const SYSTEM_PROMPT =
  "Bạn là Vision Agent điều khiển UI điện thoại, làm việc nghiêm ngặt theo rules. " +
  "Chỉ trả về MỘT JSON action hợp lệ, không markdown, không giải thích ngoài JSON.";

const RULES = `
QUY TẮC CHUNG
- Chỉ dựa vào screenshot hiện tại. Không bịa button, input, text hay tọa độ.
- Mỗi lần chỉ MỘT action. Sau tap/type/swipe phải chờ screenshot mới, không giả định UI đã đổi.
- Chỉ tap control có bằng chứng rõ ràng. Không tap logo, quảng cáo, banner, text trang trí.
- Không chắc chắn thì trả wait. Không đoán, không click/type/swipe ngẫu nhiên.
- Screenshot hiện tại luôn ưu tiên hơn history. Dùng history để tránh lặp lại action đã làm.

ĐĂNG KÝ / TẠO TÀI KHOẢN
- Tìm: "Tạo tài khoản mới", "Tạo tài khoản", "Đăng ký", "Create account", "Sign up", "Register".
- Ở màn hình đăng nhập mà thấy "Tạo tài khoản mới" thì tap nó.
- KHÔNG nhầm "Đăng nhập/Login/Sign in" với "Đăng ký/Sign up". Không tap "Quên mật khẩu".
- Chỉ tap nút đăng ký/tiếp tục khi nút nhìn thấy rõ, không disabled, không loading và các field bắt buộc của bước đó đã xong.

NHẬP DỮ LIỆU (lấy chính xác từ INFO, không tự bịa)
- Họ tên / Full name: dùng họ tên trong INFO. Nếu tách riêng "Họ" và "Tên" thì xử lý từng field.
- Ngày sinh / Birthday / DOB: dùng đúng ngày sinh trong INFO. Input text thì tap rồi type theo format UI.
  Date picker / wheel picker: xác định riêng Ngày, Tháng, Năm; sau MỖI swipe phải chờ screenshot mới.
  Chỉ bấm "Xong/Done" khi ngày đã đúng. Không bấm "Hủy/Cancel" khi cần hoàn tất ngày sinh.
- Số điện thoại / Phone: dùng đúng số trong INFO. Không đổi mã quốc gia, không tự thêm/bớt số 0 nếu UI không yêu cầu.
- Mật khẩu / Password và Xác nhận mật khẩu / Confirm password: dùng đúng mật khẩu trong INFO, không nhầm hai field.
- Không nhập dữ liệu vào sai field (vd: số điện thoại vào Họ tên).
- Field đã có đúng dữ liệu thì KHÔNG type lại. Field mật khẩu hiển thị "••••" thì không thể biết nội dung, không type lại nếu không có bằng chứng cần sửa.

TRẠNG THÁI UI
- Đang loading/spinner: wait, tuyệt đối không bấm lại hay submit liên tục.
- Nút disabled: không tap; xử lý field còn thiếu.
- Có lỗi validation: xử lý đúng field bị báo lỗi, không lặp lại action cũ nếu UI chưa đổi.
- CAPTCHA / OTP / mã xác minh / xác minh danh tính: không tự đoán, không có action chắc chắn thì wait.
- Chỉ scroll khi field/button mục tiêu không nhìn thấy. Sau scroll chờ screenshot mới.

ĐỊNH DẠNG TRẢ VỀ (chỉ JSON, một object)
{"action":"tap","x":400,"y":1100,"reason":"..."}
{"action":"type","text":"Phạm Thu Hà","reason":"..."}
{"action":"swipe","x1":500,"y1":700,"x2":500,"y2":300,"duration":400,"reason":"..."}
{"action":"wait","ms":1200,"reason":"..."}
{"action":"done","reason":"..."}
`;

function formatBlock(value, empty, max) {
  if (!value || (Array.isArray(value) && value.length === 0)) return empty;
  if (typeof value === "string") return limit(value, max);
  try {
    return limit(JSON.stringify(value, null, 2), max);
  } catch {
    return empty;
  }
}

function buildPrompt({ goal, info, rules, history }) {
  return `
Mục tiêu:
${limit(goal, 3000)}

=== INFO ===
${formatBlock(info, "Không có INFO.", 6000)}

=== HISTORY ===
${formatBlock(history, "Chưa có history.", 5000)}

=== RULES CLIENT ===
${limit(rules, 7000) || "Không có."}

=== RULES HỆ THỐNG ===
${RULES}

Hãy nhìn screenshot kèm theo, xác định màn hình hiện tại, field/button phù hợp với mục tiêu,
dữ liệu INFO cần dùng, rồi trả action tiếp theo duy nhất. Không chắc chắn thì trả wait.
CHỈ TRẢ JSON HỢP LỆ.
`;
}

// ------------------------------------------------------------
// GỌI GEMINI
// ------------------------------------------------------------

async function callGemini({ image, key, goal, info, rules, history }) {
  const imageData = normalizeImage(image);

  const requestBody = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: imageData.mimeType, data: imageData.data } },
          { text: buildPrompt({ goal, info, rules, history }) },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 1024,
      responseMimeType: "application/json",
    },
  };

  const payload = JSON.stringify(requestBody);

  let response = null;
  let responseText = "";

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      response = await fetch(geminiUrl(MODEL_ID), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key,
        },
        body: payload,
        signal: controller.signal,
      });

      // đọc body vẫn nằm trong timeout
      responseText = await response.text();
    } catch (err) {
      if (attempt === ATTEMPTS) throw err;
      console.error(`[GEMINI NETWORK] attempt ${attempt}:`, err?.message);
      await sleep(500 * attempt);
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) break;

    console.error(
      `[GEMINI ${response.status}] attempt ${attempt}:`,
      responseText.slice(0, 800)
    );

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === ATTEMPTS) break;
    await sleep(600 * attempt);
  }

  let data = null;
  try {
    data = JSON.parse(responseText);
  } catch {
    const err = new Error(
      `Gemini trả response không phải JSON: ${responseText.slice(0, 500)}`
    );
    err.status = response?.status;
    throw err;
  }

  if (!response.ok) {
    const err = new Error(data?.error?.message || `Gemini HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }

  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts;

  if (!Array.isArray(parts)) {
    const blockReason =
      data?.promptFeedback?.blockReason || candidate?.finishReason || "không rõ";
    throw new Error(`Gemini không trả content (lý do: ${blockReason}).`);
  }

  const text = parts.map((p) => p?.text || "").join("").trim();
  if (!text) throw new Error("Gemini trả content rỗng.");

  const json = extractJson(text);
  if (!json) {
    throw new Error(`Không parse được JSON Gemini: ${text.slice(0, 500)}`);
  }

  // Gemini đôi khi trả mảng [ {...} ]
  return Array.isArray(json) ? json[0] : json;
}

// ------------------------------------------------------------
// LỖI THÂN THIỆN
// ------------------------------------------------------------

function friendlyError(error) {
  if (!error) return "Lỗi không xác định.";
  if (error.name === "AbortError") return "Gemini timeout.";

  switch (true) {
    case error.status === 400:
      return `Gemini HTTP 400: ${error.message}`;
    case error.status === 401:
      return "Gemini API key không hợp lệ.";
    case error.status === 403:
      return "Gemini API key không có quyền dùng model.";
    case error.status === 404:
      return `Model "${MODEL_ID}" không tồn tại hoặc không hỗ trợ.`;
    case error.status === 429:
      return "Gemini hết quota hoặc bị rate limit.";
    case error.status >= 500:
      return `Gemini server error ${error.status}.`;
    default:
      return str(error.message, "Lỗi không xác định.");
  }
}

// ------------------------------------------------------------
// HANDLER
// ------------------------------------------------------------

export default async function handler(req, res) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      return res.status(200).end();
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed." });
    }

    // body có thể là string nếu client gửi sai Content-Type
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    body = body || {};

    const image = body.image;
    const key = body.key || process.env.GEMINI_API_KEY;

    if (!image) {
      return res.status(400).json({ ok: false, error: "Thiếu image." });
    }
    if (!key) {
      return res.status(400).json({ ok: false, error: "Thiếu Gemini API key." });
    }

    const raw = await callGemini({
      image,
      key,
      goal:
        body.goal ||
        "Hoàn thành màn hình đăng ký hiện tại và chuyển sang bước tiếp theo.",
      info: body.info || "",
      rules: body.rules || "",
      history: body.history || [],
    });

    return res.status(200).json({
      ok: true,
      model: MODEL_ID,
      action: normalizeAction(raw),
      server: "autotouch-vision",
      version: VERSION,
    });
  } catch (error) {
    const message = friendlyError(error);

    console.error("[ANALYZE ERROR]", message);
    console.error("[ANALYZE STACK]", error?.stack || "");

    // Luôn trả 200 + action wait để client Autotouch không bị đứng
    try {
      return res.status(200).json({
        ok: false,
        error: message,
        model: MODEL_ID,
        action: wait(message, 1500),
        server: "autotouch-vision",
        version: VERSION,
      });
    } catch {
      // response đã được gửi hoặc bị đóng, không làm gì thêm
    }
  }
}
