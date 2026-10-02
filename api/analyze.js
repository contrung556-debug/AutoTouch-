// ============================================================
// pages/api/analyze.js
// AUTOTOUCH VISION AGENT - khớp với script client AutoTouch
//
// Request  : { image, key, goal, info, rules[], history[] }
// Response : { success, action, reason, ... }
//   tap    : x, y
//   swipe  : x, y, x2, y2
//   type   : text            (chỉ cho gõ text nằm trong INFO)
//   wait   : seconds
//   wheel  : x, y, rows      (rows > 0: cần giá trị phía dưới, < 0: phía trên)
//   plan   : steps[]         (chỉ tap / type)
//   done / fail
// Tọa độ trả về là PIXEL của ảnh, kèm image_width / image_height.
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
const VERSION = "5.0-client-match";
const ATTEMPTS = 2;
const TIMEOUT_MS = 22000;
const MAX_PLAN_STEPS = 6;
const MAX_WHEEL_ROWS = 40;

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

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function waitAction(reason, seconds = 2) {
  return {
    action: "wait",
    seconds: clamp(seconds, 1, 10, 2),
    reason: limit(reason, 500),
  };
}

// ------------------------------------------------------------
// ẢNH
// ------------------------------------------------------------

function normalizeImage(image) {
  if (!image) throw httpError("Thiếu image.", 400);

  const value = String(image).trim();

  if (value.startsWith("data:")) {
    const match = value.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
    if (!match) throw httpError("Image data URI không hợp lệ.", 400);
    return { mimeType: match[1], data: match[2].replace(/\s+/g, "") };
  }

  let mimeType = "image/png";
  if (value.startsWith("/9j/")) mimeType = "image/jpeg";
  else if (value.startsWith("UklGR")) mimeType = "image/webp";

  return { mimeType, data: value.replace(/\s+/g, "") };
}

// Đọc kích thước ảnh (PNG / JPEG) để quy đổi tọa độ về pixel
function getImageSize(data) {
  try {
    const head = Buffer.from(data.slice(0, 64), "base64");

    // PNG: IHDR nằm ở byte 16..23
    if (
      head.length >= 24 &&
      head[0] === 0x89 &&
      head[1] === 0x50 &&
      head[2] === 0x4e &&
      head[3] === 0x47
    ) {
      return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    }

    // JPEG: tìm marker SOF
    if (head[0] === 0xff && head[1] === 0xd8) {
      const buf = Buffer.from(data, "base64");
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buf[i + 1];
        const isSof =
          marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
        if (isSof) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch {}

  return null;
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
// TỌA ĐỘ: Gemini trả 0..1000 -> pixel của ảnh
// ------------------------------------------------------------

function norm(value) {
  const n = num(value);
  if (n === null) return null;
  return Math.max(0, Math.min(1000, n));
}

function toPx(n, size) {
  return Math.max(0, Math.min(size - 1, Math.round((n / 1000) * size)));
}

function point(x, y, size) {
  const nx = norm(x);
  const ny = norm(y);
  if (nx === null || ny === null) return null;
  return { x: toPx(nx, size.width), y: toPx(ny, size.height) };
}

// ------------------------------------------------------------
// KIỂM TRA TEXT ĐƯỢC PHÉP GÕ
// ------------------------------------------------------------

function isAllowedText(text, info) {
  if (!text || !text.trim()) return false;
  return str(info).includes(text);
}

// ------------------------------------------------------------
// CHUẨN HÓA ACTION
// ------------------------------------------------------------

function normalizePlanStep(raw, size, info) {
  if (!raw || typeof raw !== "object") return { skip: true };

  const action = str(raw.action).toLowerCase().trim();

  if (action === "tap") {
    const p = point(raw.x, raw.y, size);
    return p ? { step: { action: "tap", x: p.x, y: p.y } } : { skip: true };
  }

  if (action === "type") {
    const text = str(raw.text);
    if (!isAllowedText(text, info)) {
      return { error: `Text "${limit(text, 40)}" không nằm trong dữ liệu được phép dùng.` };
    }
    return { step: { action: "type", text } };
  }

  // plan chỉ hỗ trợ tap/type, bỏ qua phần còn lại
  return { skip: true };
}

function normalizeAction(raw, size, info) {
  if (!raw || typeof raw !== "object") {
    return waitAction("Gemini không trả action hợp lệ.");
  }

  const action = str(raw.action).toLowerCase().trim();
  const reason = limit(raw.reason, 500);

  switch (action) {
    case "tap": {
      const p = point(raw.x, raw.y, size);
      if (!p) return waitAction("Gemini trả tap nhưng thiếu tọa độ.");
      return {
        action: "tap",
        x: p.x,
        y: p.y,
        target: limit(raw.target, 300),
        reason,
      };
    }

    case "swipe": {
      const a = point(raw.x, raw.y, size);
      const b = point(raw.x2, raw.y2, size);
      if (!a || !b) return waitAction("Gemini trả swipe nhưng thiếu tọa độ.");
      return { action: "swipe", x: a.x, y: a.y, x2: b.x, y2: b.y, reason };
    }

    case "type": {
      const text = str(raw.text);
      if (!text) return waitAction("Gemini trả type nhưng không có text.");
      if (!isAllowedText(text, info)) {
        return waitAction(
          `Text "${limit(text, 40)}" không nằm trong dữ liệu được phép dùng. Chỉ type đúng một giá trị có trong dữ liệu.`
        );
      }
      return { action: "type", text, target: limit(raw.target, 300), reason };
    }

    case "wait":
      return {
        action: "wait",
        seconds: clamp(raw.seconds ?? (num(raw.ms) ? num(raw.ms) / 1000 : null), 1, 10, 2),
        reason: reason || "Chờ UI ổn định.",
      };

    case "wheel": {
      const p = point(raw.x, raw.y, size);
      if (!p) return waitAction("Gemini trả wheel nhưng thiếu tọa độ.");
      const rows = clamp(raw.rows, -MAX_WHEEL_ROWS, MAX_WHEEL_ROWS, 0);
      if (rows === 0) return waitAction("Wheel rows = 0, không cần cuộn.");
      return { action: "wheel", x: p.x, y: p.y, rows, reason };
    }

    case "plan": {
      if (!Array.isArray(raw.steps)) return waitAction("Plan không có steps.");

      const steps = [];
      for (const s of raw.steps.slice(0, MAX_PLAN_STEPS)) {
        const out = normalizePlanStep(s, size, info);
        if (out.error) return waitAction(out.error);
        if (out.step) steps.push(out.step);
      }

      if (steps.length === 0) return waitAction("Plan không có step hợp lệ.");
      return { action: "plan", steps, reason: reason || "Thực hiện kế hoạch." };
    }

    case "done":
      return { action: "done", reason: reason || "Đã hoàn thành." };

    case "fail":
      return { action: "fail", reason: reason || "AI không thể tiếp tục." };

    default:
      return waitAction("Action không hợp lệ.");
  }
}

// ------------------------------------------------------------
// PROMPT
// ------------------------------------------------------------

const SYSTEM_PROMPT =
  "Bạn là Vision Agent điều khiển UI điện thoại, làm việc nghiêm ngặt theo luật. " +
  "Chỉ trả về MỘT JSON action hợp lệ, không markdown, không giải thích ngoài JSON.";

const SYSTEM_RULES = `
TỌA ĐỘ
- Mọi tọa độ x, y (và x2, y2) là tọa độ CHUẨN HÓA 0..1000 trên screenshot:
  x = 0 là mép trái, 1000 là mép phải; y = 0 là mép trên, 1000 là mép dưới.
- Tọa độ phải trỏ vào TÂM của control cần thao tác.

NGUYÊN TẮC
- Chỉ dựa vào screenshot hiện tại. Không bịa button, input, text hay tọa độ.
- Mỗi lần chỉ MỘT action. Sau action phải chờ screenshot mới, không giả định UI đã đổi.
- Chỉ tap control có bằng chứng rõ ràng. Không tap logo, quảng cáo, banner, text trang trí.
- Không chắc chắn thì trả wait. Không đoán, không thao tác ngẫu nhiên.
- Screenshot hiện tại luôn ưu tiên hơn lịch sử. Dùng lịch sử để không lặp lại action đã làm.

ĐĂNG KÝ / TẠO TÀI KHOẢN
- Tìm: "Tạo tài khoản mới", "Tạo tài khoản", "Đăng ký", "Create account", "Sign up", "Register".
- Ở màn hình đăng nhập mà thấy "Tạo tài khoản mới" thì tap nó.
- KHÔNG nhầm "Đăng nhập/Login/Sign in" với "Đăng ký/Sign up". Không tap "Quên mật khẩu".
- Chỉ tap Tiếp tục/Tiếp/Next/Đăng ký khi nút nhìn thấy rõ, không disabled, không loading
  và các field bắt buộc của bước hiện tại đã đúng.

NHẬP DỮ LIỆU
- Chỉ được type text nằm trong "DỮ LIỆU ĐƯỢC PHÉP DÙNG", chép nguyên văn.
- Mỗi action type chỉ gõ MỘT giá trị (vd "Nguyen"), KHÔNG kèm nhãn như "Họ: Nguyen".
- Họ / Tên: dùng đúng giá trị tương ứng. Số di động: dùng đúng số, không đổi định dạng,
  không đổi mã quốc gia/mã vùng nếu app đã chọn sẵn.
- Không nhập dữ liệu sai field. Field đã có đúng dữ liệu thì KHÔNG type lại.
- Field mật khẩu hoặc dữ liệu ẩn thì không thể kiểm tra nội dung từ ảnh; không type lại nếu không có bằng chứng cần sửa.
- Nhiều ô nhập hiện cùng lúc: dùng action plan (tap ô, type, tap ô, type...), chỉ gồm tap và type.

BÁNH XE NGÀY SINH (WHEEL)
- Dùng action wheel với x, y là điểm nằm trên cột cần chỉnh (ở dòng đang được chọn).
- rows là SỐ DÒNG cần cuộn: đếm số dòng từ giá trị đang chọn (dòng giữa) tới giá trị đích.
  rows dương nếu giá trị đích nằm phía dưới, âm nếu nằm phía trên.
- Mỗi lần chỉ chỉnh một cột. Sau mỗi wheel phải kiểm tra lại ảnh mới trước khi chỉnh tiếp.

TRẠNG THÁI UI
- Đang loading/spinner: wait, tuyệt đối không bấm lại hay submit liên tục.
- Nút disabled: không tap; xử lý field còn thiếu.
- Có lỗi validation: xử lý đúng field bị báo lỗi, không lặp lại action cũ nếu UI chưa đổi.
- CAPTCHA / OTP / xác minh danh tính: không tự đoán, trả wait. Nếu lịch sử cho thấy đã wait
  từ 3 lần liên tiếp mà màn hình không đổi thì trả fail.
- Chỉ swipe khi field/button mục tiêu không nhìn thấy. Sau swipe chờ screenshot mới.

KẾT THÚC
- done: khi mục tiêu đã đạt (đã chuyển sang bước tiếp theo/màn hình hoàn tất).
- fail: khi bị kẹt, thiếu dữ liệu cần thiết hoặc không thể tiếp tục một cách an toàn.

ĐỊNH DẠNG TRẢ VỀ (chỉ một object JSON, tọa độ 0..1000)
{"action":"tap","x":500,"y":820,"reason":"..."}
{"action":"type","text":"Nguyen","reason":"..."}
{"action":"swipe","x":500,"y":700,"x2":500,"y2":300,"reason":"..."}
{"action":"wait","seconds":2,"reason":"..."}
{"action":"wheel","x":500,"y":640,"rows":-3,"reason":"..."}
{"action":"plan","steps":[{"action":"tap","x":500,"y":300},{"action":"type","text":"Nguyen"},{"action":"tap","x":500,"y":420},{"action":"type","text":"An"}],"reason":"..."}
{"action":"done","reason":"..."}
{"action":"fail","reason":"..."}
`;

function formatHistory(history) {
  if (!history || (Array.isArray(history) && history.length === 0)) {
    return "Chưa có lịch sử.";
  }
  if (Array.isArray(history)) {
    return limit(history.slice(-10).map((h) => str(h)).join("\n"), 5000);
  }
  return limit(history, 5000);
}

function formatRules(rules) {
  if (!rules || (Array.isArray(rules) && rules.length === 0)) return "Không có.";
  if (Array.isArray(rules)) {
    return limit(rules.map((r) => "- " + str(r)).join("\n"), 7000);
  }
  return limit(rules, 7000);
}

function buildPrompt({ goal, info, rules, history }) {
  return `
MỤC TIÊU:
${limit(goal, 3000)}

=== DỮ LIỆU ĐƯỢC PHÉP DÙNG ===
${limit(str(info), 6000) || "Không có dữ liệu."}

=== LỊCH SỬ CÁC BƯỚC TRƯỚC ===
${formatHistory(history)}

=== LUẬT BỔ SUNG TỪ CLIENT ===
${formatRules(rules)}

=== LUẬT HỆ THỐNG ===
${SYSTEM_RULES}

Hãy nhìn screenshot kèm theo, xác định màn hình hiện tại, control phù hợp với mục tiêu,
dữ liệu cần dùng, rồi trả MỘT action tiếp theo. Không chắc chắn thì trả wait.
CHỈ TRẢ JSON HỢP LỆ.
`;
}

// ------------------------------------------------------------
// GỌI GEMINI
// ------------------------------------------------------------

async function callGemini({ imageData, key, goal, info, rules, history }) {
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

      responseText = await response.text(); // vẫn nằm trong timeout
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
    throw httpError(
      `Gemini trả response không phải JSON: ${responseText.slice(0, 300)}`,
      response?.status || 502
    );
  }

  if (!response.ok) {
    throw httpError(data?.error?.message || `Gemini HTTP ${response.status}`, response.status);
  }

  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts;

  if (!Array.isArray(parts)) {
    const why = data?.promptFeedback?.blockReason || candidate?.finishReason || "không rõ";
    throw httpError(`Gemini không trả content (lý do: ${why}).`, 502);
  }

  const text = parts.map((p) => p?.text || "").join("").trim();
  if (!text) throw httpError("Gemini trả content rỗng.", 502);

  const json = extractJson(text);
  if (!json) throw httpError(`Không parse được JSON Gemini: ${text.slice(0, 300)}`, 502);

  return Array.isArray(json) ? json[0] : json;
}

// ------------------------------------------------------------
// LỖI
// ------------------------------------------------------------

function friendlyError(error) {
  if (!error) return "Lỗi không xác định.";
  if (error.name === "AbortError") return "Gemini timeout.";

  switch (true) {
    case error.status === 400:
      return `Yêu cầu không hợp lệ: ${error.message}`;
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

// Lỗi cấu hình: client nên dừng. Lỗi tạm thời: client chờ rồi thử lại.
function isFatal(error) {
  return [400, 401, 403, 404].includes(error?.status);
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
      return res.status(405).json({ success: false, error: "Method not allowed." });
    }

    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    body = body || {};

    const key = body.key || process.env.GEMINI_API_KEY;
    if (!key) {
      return res.status(200).json({ success: false, error: "Thiếu Gemini API key." });
    }

    const imageData = normalizeImage(body.image);

    const size = getImageSize(imageData.data);
    if (!size || !size.width || !size.height) {
      throw httpError("Không đọc được kích thước ảnh (cần PNG hoặc JPEG).", 400);
    }

    const info = body.info || "";

    const raw = await callGemini({
      imageData,
      key,
      goal:
        body.goal ||
        "Hoàn thành màn hình đăng ký hiện tại và chuyển sang bước tiếp theo.",
      info,
      rules: body.rules || [],
      history: body.history || [],
    });

    const action = normalizeAction(raw, size, info);

    return res.status(200).json({
      success: true,
      ...action,
      image_width: size.width,
      image_height: size.height,
      model: MODEL_ID,
      version: VERSION,
    });
  } catch (error) {
    const message = friendlyError(error);

    console.error("[ANALYZE ERROR]", message);
    console.error("[ANALYZE STACK]", error?.stack || "");

    try {
      // Lỗi cấu hình -> success:false để client dừng và hiện lỗi.
      // Lỗi tạm thời -> action wait để client tự thử lại ở vòng sau.
      if (isFatal(error)) {
        return res.status(200).json({
          success: false,
          error: message,
          model: MODEL_ID,
          version: VERSION,
        });
      }

      return res.status(200).json({
        success: true,
        ...waitAction(message, 3),
        model: MODEL_ID,
        version: VERSION,
      });
    } catch {
      // response đã đóng, không làm gì thêm
    }
  }
}
