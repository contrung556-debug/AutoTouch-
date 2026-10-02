// ============================================================
// pages/api/analyze.js
// AUTOTOUCH VISION AGENT
// GEMINI 3.5 FLASH-LITE
// STABLE / SIMPLE VERSION
// ============================================================

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "4.5mb",
    },
  },
};

export const runtime = "nodejs";

// ============================================================
// MODEL
// ============================================================

const MODEL_ID = "gemini-3.5-flash-lite";

const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent`;

// ============================================================
// HELPERS
// ============================================================

function str(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function limit(value, max = 8000) {
  const text = str(value);

  if (text.length <= max) {
    return text;
  }

  return text.slice(0, max);
}

// ============================================================
// IMAGE
// ============================================================

function normalizeImage(image) {
  if (!image) {
    throw new Error("Thiếu image.");
  }

  const value = String(image).trim();

  if (value.startsWith("data:image/")) {
    const match = value.match(
      /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s
    );

    if (!match) {
      throw new Error("Image data URI không hợp lệ.");
    }

    return {
      mimeType: match[1],
      data: match[2],
    };
  }

  return {
    mimeType: "image/png",
    data: value,
  };
}

// ============================================================
// JSON PARSER
// ============================================================

function extractJson(text) {
  if (!text) {
    return null;
  }

  let value = String(text).trim();

  // bỏ markdown fence
  value = value
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // parse trực tiếp
  try {
    return JSON.parse(value);
  } catch {}

  // tìm object
  const first = value.indexOf("{");
  const last = value.lastIndexOf("}");

  if (first !== -1 && last > first) {
    const candidate = value.slice(first, last + 1);

    try {
      return JSON.parse(candidate);
    } catch {}
  }

  return null;
}

// ============================================================
// NUMBER
// ============================================================

function num(value, fallback = null) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return fallback;
  }

  return n;
}

// ============================================================
// NORMALIZE ACTION
// ============================================================

function normalizeAction(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      action: "wait",
      ms: 1000,
      reason: "Gemini không trả action hợp lệ.",
    };
  }

  let action = str(raw.action)
    .toLowerCase()
    .trim();

  const allowed = [
    "tap",
    "swipe",
    "type",
    "wait",
    "done",
    "plan",
  ];

  if (!allowed.includes(action)) {
    return {
      action: "wait",
      ms: 1000,
      reason: "Action không hợp lệ.",
    };
  }

  // ----------------------------------------------------------
  // TAP
  // ----------------------------------------------------------

  if (action === "tap") {
    const x = num(raw.x);
    const y = num(raw.y);

    if (x === null || y === null) {
      return {
        action: "wait",
        ms: 1000,
        reason: "Gemini trả tap nhưng thiếu tọa độ.",
      };
    }

    return {
      action: "tap",
      x: Math.round(x),
      y: Math.round(y),
      reason: limit(raw.reason, 500),
      target: limit(raw.target, 300),
    };
  }

  // ----------------------------------------------------------
  // SWIPE
  // ----------------------------------------------------------

  if (action === "swipe") {
    const x1 = num(raw.x1);
    const y1 = num(raw.y1);
    const x2 = num(raw.x2);
    const y2 = num(raw.y2);

    if (
      x1 === null ||
      y1 === null ||
      x2 === null ||
      y2 === null
    ) {
      return {
        action: "wait",
        ms: 1000,
        reason: "Gemini trả swipe nhưng thiếu tọa độ.",
      };
    }

    return {
      action: "swipe",
      x1: Math.round(x1),
      y1: Math.round(y1),
      x2: Math.round(x2),
      y2: Math.round(y2),
      duration: Math.max(
        100,
        Math.min(
          3000,
          Math.round(num(raw.duration, 400))
        )
      ),
      reason: limit(raw.reason, 500),
    };
  }

  // ----------------------------------------------------------
  // TYPE
  // ----------------------------------------------------------

  if (action === "type") {
    const text = str(raw.text);

    if (!text) {
      return {
        action: "wait",
        ms: 1000,
        reason: "Gemini trả type nhưng không có text.",
      };
    }

    return {
      action: "type",
      text,
      reason: limit(raw.reason, 500),
      target: limit(raw.target, 300),
    };
  }

  // ----------------------------------------------------------
  // WAIT
  // ----------------------------------------------------------

  if (action === "wait") {
    return {
      action: "wait",
      ms: Math.max(
        300,
        Math.min(
          5000,
          Math.round(num(raw.ms, 1000))
        )
      ),
      reason:
        limit(raw.reason, 500) ||
        "Chờ UI ổn định.",
    };
  }

  // ----------------------------------------------------------
  // DONE
  // ----------------------------------------------------------

  if (action === "done") {
    return {
      action: "done",
      reason:
        limit(raw.reason, 500) ||
        "Đã hoàn thành.",
    };
  }

  // ----------------------------------------------------------
  // PLAN
  // ----------------------------------------------------------

  if (action === "plan") {
    const steps = [];

    if (Array.isArray(raw.steps)) {
      for (const step of raw.steps.slice(0, 5)) {
        const normalized = normalizePlanStep(step);

        if (normalized) {
          steps.push(normalized);
        }
      }
    }

    if (steps.length === 0) {
      return {
        action: "wait",
        ms: 1000,
        reason: "Plan không có step hợp lệ.",
      };
    }

    return {
      action: "plan",
      steps,
      reason:
        limit(raw.reason, 500) ||
        "Thực hiện kế hoạch.",
    };
  }

  return {
    action: "wait",
    ms: 1000,
    reason: "Fallback wait.",
  };
}

// ============================================================
// PLAN STEP
// ============================================================

function normalizePlanStep(step) {
  if (!step || typeof step !== "object") {
    return null;
  }

  const action = str(step.action)
    .toLowerCase()
    .trim();

  if (action === "tap") {
    const x = num(step.x);
    const y = num(step.y);

    if (x === null || y === null) {
      return null;
    }

    return {
      action: "tap",
      x: Math.round(x),
      y: Math.round(y),
    };
  }

  if (action === "swipe") {
    const x1 = num(step.x1);
    const y1 = num(step.y1);
    const x2 = num(step.x2);
    const y2 = num(step.y2);

    if (
      x1 === null ||
      y1 === null ||
      x2 === null ||
      y2 === null
    ) {
      return null;
    }

    return {
      action: "swipe",
      x1: Math.round(x1),
      y1: Math.round(y1),
      x2: Math.round(x2),
      y2: Math.round(y2),
      duration: Math.round(
        num(step.duration, 400)
      ),
    };
  }

  if (action === "type") {
    const text = str(step.text);

    if (!text) {
      return null;
    }

    return {
      action: "type",
      text,
    };
  }

  if (action === "wait") {
    return {
      action: "wait",
      ms: Math.round(
        num(step.ms, 1000)
      ),
    };
  }

  if (action === "done") {
    return {
      action: "done",
      reason: limit(step.reason, 500),
    };
  }

  return null;
}

// ============================================================
// INFO
// ============================================================

function formatInfo(info) {
  if (!info) {
    return "Không có INFO.";
  }

  if (typeof info === "string") {
    return limit(info, 6000);
  }

  try {
    return limit(
      JSON.stringify(info, null, 2),
      6000
    );
  } catch {
    return "Không thể đọc INFO.";
  }
}

// ============================================================
// HISTORY
// ============================================================

function formatHistory(history) {
  if (!history) {
    return "Chưa có history.";
  }

  if (typeof history === "string") {
    return limit(history, 5000);
  }

  try {
    return limit(
      JSON.stringify(history, null, 2),
      5000
    );
  } catch {
    return "Không thể đọc history.";
  }
}

// ============================================================
// RULES
// ============================================================

function buildRules() {
  return `
============================================================
QUY TẮC VISION AUTOTOUCH
============================================================

1. CHỈ NHÌN SCREENSHOT HIỆN TẠI
- Chỉ thao tác với UI thực sự nhìn thấy.
- Không bịa button.
- Không bịa input.
- Không bịa text.
- Không bịa tọa độ.
- Không đoán UI không nhìn thấy.

2. MỖI LẦN CHỈ MỘT ACTION
- Chọn action tiếp theo dựa trên screenshot hiện tại.
- Sau tap/type/swipe phải chờ screenshot mới.
- Không tự giả định UI đã thay đổi.

3. KHÔNG CLICK MÙ
- Không tap logo.
- Không tap quảng cáo.
- Không tap banner.
- Không tap text trang trí.
- Chỉ tap control có bằng chứng rõ ràng.

============================================================
TẠO TÀI KHOẢN / ĐĂNG KÝ
============================================================

Nếu mục tiêu là tạo tài khoản, tìm:

"Tạo tài khoản"
"Đăng ký"
"Đăng kí"
"Tạo tài khoản mới"
"Create account"
"Sign up"
"Register"

Nếu đang ở màn hình đăng nhập và thấy "Tạo tài khoản mới":

→ ưu tiên tap "Tạo tài khoản mới".

KHÔNG nhầm:

"Đăng nhập"
"Login"
"Log in"
"Sign in"

với:

"Đăng ký"
"Sign up"
"Register"
"Tạo tài khoản"

Nếu mục tiêu là đăng ký:
- Không tap "Đăng nhập".
- Không tap "Quên mật khẩu".
- Không tap logo.

============================================================
HỌ TÊN
============================================================

Khi thấy:

"Họ tên"
"Họ và tên"
"Full name"
"Name"
"Your name"

Nếu INFO có họ tên:

→ sử dụng đúng họ tên trong INFO.

Nếu field trống:

→ tap field
→ type đúng họ tên.

Nếu field đã chứa đúng họ tên:

→ KHÔNG type lại.

Không nhập:
- số điện thoại
- mật khẩu

vào field Họ tên.

Nếu có riêng:
"Họ"
"Tên"

thì xử lý riêng từng field.

============================================================
NGÀY SINH
============================================================

Khi thấy:

"Ngày sinh"
"Sinh nhật"
"Date of birth"
"Birthday"
"DOB"

Nếu INFO có ngày sinh:

→ dùng chính xác ngày sinh trong INFO.

Không tự bịa ngày sinh.

Nếu là input text:
→ tap
→ type đúng ngày sinh theo format UI.

Nếu mở date picker:
→ thao tác date picker.

Nếu là wheel picker:
→ xác định riêng Ngày / Tháng / Năm.

Sau mỗi swipe wheel:
→ phải chờ screenshot mới.

Không swipe nhiều lần dựa trên phỏng đoán.

Nếu có:
"Hủy"
"Cancel"
"Xong"
"Done"

→ chỉ dùng "Xong/Done" sau khi ngày đúng.

Không bấm "Hủy" nếu đang cần hoàn tất ngày sinh.

============================================================
SỐ ĐIỆN THOẠI
============================================================

Khi thấy:

"Số điện thoại"
"Điện thoại"
"Phone"
"Phone number"
"Mobile"

Nếu INFO có số điện thoại:

→ sử dụng đúng số trong INFO.

Nếu field đã chứa đúng số:

→ KHÔNG type lại.

Không nhập số điện thoại vào:
- Họ tên
- Ngày sinh
- Mật khẩu

Nếu có mã quốc gia:
"+84"
"+1"
"+44"
...

→ xác định mã quốc gia từ screenshot.

Không tự thay đổi mã quốc gia nếu không có bằng chứng.

Không tự thêm/bớt số 0 nếu UI không yêu cầu.

============================================================
MẬT KHẨU
============================================================

Khi thấy:

"Mật khẩu"
"Password"
"Create password"
"New password"

Nếu INFO có mật khẩu:

→ dùng chính xác mật khẩu trong INFO.

Không tự thay đổi mật khẩu.

Nếu field đã có:
"••••"
"*****"
hoặc ký hiệu ẩn:

→ không thể biết nội dung thực tế chỉ từ screenshot.

Không type lại nếu không có bằng chứng cần sửa.

============================================================
XÁC NHẬN MẬT KHẨU
============================================================

Khi thấy:

"Xác nhận mật khẩu"
"Nhập lại mật khẩu"
"Confirm password"
"Re-enter password"

→ dùng đúng mật khẩu trong INFO.

Không nhầm field này với field Mật khẩu chính.

============================================================
INPUT ĐÃ CÓ DỮ LIỆU
============================================================

Nếu field đã chứa đúng dữ liệu:

→ không type lại.

Không type lại chỉ vì field vẫn xuất hiện trên screenshot.

Nếu dữ liệu khác:
→ chỉ sửa khi có bằng chứng field cần sửa.

============================================================
LOADING / SPINNER
============================================================

Nếu button đang có spinner:

→ KHÔNG click lại.

Nếu UI đang loading:

→ wait.

Sau khi tap Đăng ký/Tạo tài khoản mà loading:

→ wait.

Không submit liên tục.

============================================================
BUTTON ĐĂNG KÝ
============================================================

Các button hợp lệ có thể là:

"Đăng ký"
"Tạo tài khoản"
"Tạo tài khoản mới"
"Create account"
"Sign up"
"Register"

Chỉ tap khi:
- button thực sự nhìn thấy
- không disabled
- không loading
- các field bắt buộc đã được xử lý

============================================================
TIẾP TỤC
============================================================

Các button:

"Tiếp tục"
"Continue"
"Next"
"Tiếp theo"

Chỉ tap khi các field bắt buộc của bước hiện tại đã hoàn tất.

============================================================
DISABLED
============================================================

Nếu button rõ ràng disabled:

→ không tap.

Nếu button chưa hoạt động vì thiếu field:

→ xử lý field còn thiếu.

============================================================
VALIDATION
============================================================

Nếu sau action xuất hiện lỗi validation:

Ví dụ:

"Số điện thoại không hợp lệ"
→ xử lý Số điện thoại.

"Vui lòng nhập họ tên"
→ xử lý Họ tên.

"Mật khẩu không hợp lệ"
→ xử lý Mật khẩu.

Không lặp lại action cũ nếu UI chưa thay đổi.

============================================================
CAPTCHA / OTP
============================================================

Nếu xuất hiện:

CAPTCHA
OTP
Mã xác minh
Xác minh danh tính
Challenge

Không tự đoán.

Nếu không có action chắc chắn:

→ wait.

============================================================
SCROLL
============================================================

Chỉ scroll khi field/button mục tiêu không nhìn thấy.

Sau scroll:
→ chờ screenshot mới.

Không scroll ngẫu nhiên.

============================================================
HISTORY
============================================================

Dùng history để tránh:
- tap cùng button liên tục
- type cùng dữ liệu nhiều lần
- swipe lặp lại
- thực hiện lại action đã hoàn thành

Nhưng screenshot hiện tại luôn ưu tiên hơn history.

============================================================
KHI KHÔNG CHẮC CHẮN
============================================================

Không đoán.

Không click ngẫu nhiên.

Không type ngẫu nhiên.

Không swipe ngẫu nhiên.

→ ưu tiên wait.

============================================================
OUTPUT
============================================================

CHỈ TRẢ JSON.

KHÔNG markdown.
KHÔNG ```json.
KHÔNG giải thích bên ngoài JSON.

Ví dụ TAP:

{
  "action": "tap",
  "x": 400,
  "y": 1100,
  "reason": "Đã xác định nút Tạo tài khoản mới."
}

Ví dụ TYPE:

{
  "action": "type",
  "text": "Phạm Thu Hà",
  "reason": "Field Họ tên đang trống."
}

Ví dụ WAIT:

{
  "action": "wait",
  "ms": 1200,
  "reason": "UI đang loading."
}

Ví dụ SWIPE:

{
  "action": "swipe",
  "x1": 500,
  "y1": 700,
  "x2": 500,
  "y2": 300,
  "duration": 400,
  "reason": "Cuộn để tìm field tiếp theo."
}

Ví dụ DONE:

{
  "action": "done",
  "reason": "Đã hoàn thành flow."
}
`;
}

// ============================================================
// PROMPT
// ============================================================

function buildPrompt({
  goal,
  info,
  rules,
  history,
}) {
  return `
BẠN LÀ VISION AGENT ĐIỀU KHIỂN UI MOBILE CHO AUTOTOUCH.

Mục tiêu:
${limit(
  goal ||
    "Hoàn thành màn hình đăng ký hiện tại và chuyển sang bước tiếp theo.",
  3000
)}

============================================================
INFO
============================================================

${formatInfo(info)}

============================================================
HISTORY
============================================================

${formatHistory(history)}

============================================================
RULES CLIENT
============================================================

${limit(rules || "", 7000)}

============================================================
RULES HỆ THỐNG
============================================================

${buildRules()}

============================================================
YÊU CẦU CUỐI
============================================================

Hãy nhìn screenshot được gửi kèm.

Xác định:
1. Màn hình hiện tại.
2. Field/button phù hợp với mục tiêu.
3. Dữ liệu INFO nào cần sử dụng.
4. Action tiếp theo duy nhất.

Nếu chắc chắn:
→ trả action.

Nếu không chắc chắn:
→ trả wait.

CHỈ TRẢ JSON HỢP LỆ.
`;
}

// ============================================================
// GEMINI
// ============================================================

async function callGemini({
  image,
  key,
  goal,
  info,
  rules,
  history,
}) {
  const imageData = normalizeImage(image);

  const prompt = buildPrompt({
    goal,
    info,
    rules,
    history,
  });

  const requestBody = {
    systemInstruction: {
      parts: [
        {
          text:
            "Bạn là Vision Agent mobile automation nghiêm ngặt. " +
            "Tuân thủ rules tiếng Việt. " +
            "Chỉ trả về một JSON action hợp lệ.",
        },
      ],
    },

    contents: [
      {
        role: "user",

        parts: [
          {
            inlineData: {
              mimeType: imageData.mimeType,
              data: imageData.data,
            },
          },

          {
            text: prompt,
          },
        ],
      },
    ],

    generationConfig: {
      temperature: 0,

      // Không dùng responseSchema.
      // Prompt sẽ ép Gemini trả JSON.
      responseMimeType: "application/json",
    },
  };

  const controller =
    new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 25000);

  let response;

  try {
    response = await fetch(
      GEMINI_URL,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key,
        },

        body: JSON.stringify(requestBody),

        signal: controller.signal,
      }
    );
  } finally {
    clearTimeout(timeout);
  }

  const responseText =
    await response.text();

  let data = null;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Gemini trả response không phải JSON: ${responseText.slice(
        0,
        1000
      )}`
    );
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      `Gemini HTTP ${response.status}`;

    const error = new Error(message);

    error.status = response.status;

    throw error;
  }

  const parts =
    data?.candidates?.[0]?.content?.parts;

  if (!Array.isArray(parts)) {
    throw new Error(
      "Gemini không trả content.parts."
    );
  }

  const text = parts
    .map((part) => part?.text || "")
    .join("")
    .trim();

  if (!text) {
    throw new Error(
      "Gemini trả content rỗng."
    );
  }

  const json = extractJson(text);

  if (!json) {
    throw new Error(
      `Không parse được JSON Gemini: ${text.slice(
        0,
        1500
      )}`
    );
  }

  return json;
}

// ============================================================
// ERROR
// ============================================================

function friendlyError(error) {
  if (!error) {
    return "Lỗi không xác định.";
  }

  if (error.name === "AbortError") {
    return "Gemini timeout.";
  }

  if (error.status === 400) {
    return `Gemini HTTP 400: ${error.message}`;
  }

  if (error.status === 401) {
    return "Gemini API key không hợp lệ.";
  }

  if (error.status === 403) {
    return "Gemini API key không có quyền sử dụng model.";
  }

  if (error.status === 429) {
    return "Gemini hết quota hoặc rate limit.";
  }

  if (error.status >= 500) {
    return `Gemini server error ${error.status}.`;
  }

  return str(
    error.message,
    "Lỗi không xác định."
  );
}

// ============================================================
// SAFE WAIT
// ============================================================

function waitResponse(reason) {
  return {
    ok: false,

    model: MODEL_ID,

    action: {
      action: "wait",
      ms: 1500,
      reason: limit(reason, 1000),
    },

    server: "autotouch-vision",

    version: "3.5-lite-safe-v2",
  };
}

// ============================================================
// HANDLER
// ============================================================

export default async function handler(
  req,
  res
) {
  // ----------------------------------------------------------
  // CORS
  // ----------------------------------------------------------

  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  // ----------------------------------------------------------
  // OPTIONS
  // ----------------------------------------------------------

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // ----------------------------------------------------------
  // METHOD
  // ----------------------------------------------------------

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed.",
    });
  }

  // ----------------------------------------------------------
  // EVERYTHING INSIDE TRY
  // ----------------------------------------------------------

  try {
    const body = req.body || {};

    const image = body.image;
    const key = body.key;

    const goal =
      body.goal ||
      "Hoàn thành màn hình đăng ký hiện tại và chuyển sang bước tiếp theo.";

    const info =
      body.info || "";

    const rules =
      body.rules || "";

    const history =
      body.history || [];

    // --------------------------------------------------------
    // VALIDATION
    // --------------------------------------------------------

    if (!image) {
      return res.status(400).json({
        ok: false,
        error: "Thiếu image.",
      });
    }

    if (!key) {
      return res.status(400).json({
        ok: false,
        error: "Thiếu Gemini API key.",
      });
    }

    // --------------------------------------------------------
    // GEMINI
    // --------------------------------------------------------

    const raw =
      await callGemini({
        image,
        key,
        goal,
        info,
        rules,
        history,
      });

    // --------------------------------------------------------
    // NORMALIZE
    // --------------------------------------------------------

    const action =
      normalizeAction(raw);

    // --------------------------------------------------------
    // RESPONSE
    // --------------------------------------------------------

    return res.status(200).json({
      ok: true,

      model: MODEL_ID,

      action,

      server:
        "autotouch-vision",

      version:
        "3.5-lite-safe-v2",
    });

  } catch (error) {
    // ========================================================
    // KHÔNG CHO FUNCTION CRASH
    // ========================================================

    const message =
      friendlyError(error);

    console.error(
      "[ANALYZE ERROR]",
      message
    );

    console.error(
      "[ANALYZE ERROR STACK]",
      error?.stack || ""
    );

    return res.status(200).json(
      waitResponse(message)
    );
  }
}
