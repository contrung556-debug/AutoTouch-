// ============================================================
// pages/api/analyze.js
// AUTOTOUCH VISION AGENT
// Gemini 3.5 Flash-Lite
// ============================================================

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "4.5mb",
    },
  },
};

// ============================================================
// MODEL - KHÓA CỨNG GEMINI 3.5
// ============================================================

const MODEL_ID = "gemini-3.5-flash-lite";

const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent`;

// ============================================================
// ACTIONS
// ============================================================

const ACTIONS = [
  "tap",
  "swipe",
  "type",
  "wait",
  "done",
  "plan",
];

// ============================================================
// HELPERS
// ============================================================

function safeString(value, fallback = "") {
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

function trimText(value, max = 8000) {
  const text = safeString(value);

  if (text.length <= max) {
    return text;
  }

  return text.slice(0, max);
}

function safeJson(value, fallback = {}) {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value === "object") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// ============================================================
// IMAGE
// ============================================================

function normalizeImage(image) {
  if (!image) {
    throw new Error("Missing image");
  }

  let value = String(image).trim();

  // Nếu gửi nguyên data URI
  if (value.startsWith("data:image/")) {
    const match = value.match(
      /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s
    );

    if (!match) {
      throw new Error("Invalid image data URI");
    }

    return {
      mimeType: match[1],
      data: match[2],
    };
  }

  // Nếu chỉ gửi base64
  return {
    mimeType: "image/png",
    data: value,
  };
}

// ============================================================
// CODE FENCE / JSON EXTRACTION
// ============================================================

function stripCodeFence(text) {
  if (!text) {
    return "";
  }

  let value = String(text).trim();

  value = value.replace(/^```json\s*/i, "");
  value = value.replace(/^```\s*/i, "");
  value = value.replace(/\s*```$/i, "");

  return value.trim();
}

function extractJson(text) {
  if (!text) {
    return null;
  }

  let value = stripCodeFence(text);

  // Thử parse trực tiếp
  try {
    return JSON.parse(value);
  } catch {}

  // Tìm object JSON
  const firstObject = value.indexOf("{");
  const lastObject = value.lastIndexOf("}");

  if (firstObject !== -1 && lastObject > firstObject) {
    const candidate = value.slice(
      firstObject,
      lastObject + 1
    );

    try {
      return JSON.parse(candidate);
    } catch {}
  }

  // Tìm array JSON
  const firstArray = value.indexOf("[");
  const lastArray = value.lastIndexOf("]");

  if (firstArray !== -1 && lastArray > firstArray) {
    const candidate = value.slice(
      firstArray,
      lastArray + 1
    );

    try {
      return JSON.parse(candidate);
    } catch {}
  }

  return null;
}

// ============================================================
// NUMBER
// ============================================================

function numberOrNull(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return null;
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
      reason: "Không nhận được action hợp lệ.",
    };
  }

  let action = safeString(raw.action).toLowerCase().trim();

  if (!ACTIONS.includes(action)) {
    action = "wait";
  }

  const result = {
    action,
  };

  // ----------------------------------------------------------
  // TAP
  // ----------------------------------------------------------

  if (action === "tap") {
    const x = numberOrNull(raw.x);
    const y = numberOrNull(raw.y);

    if (x === null || y === null) {
      return {
        action: "wait",
        reason: "Tap không có tọa độ hợp lệ.",
      };
    }

    result.x = Math.round(x);
    result.y = Math.round(y);
  }

  // ----------------------------------------------------------
  // SWIPE
  // ----------------------------------------------------------

  if (action === "swipe") {
    const x1 = numberOrNull(raw.x1);
    const y1 = numberOrNull(raw.y1);
    const x2 = numberOrNull(raw.x2);
    const y2 = numberOrNull(raw.y2);

    if (
      x1 === null ||
      y1 === null ||
      x2 === null ||
      y2 === null
    ) {
      return {
        action: "wait",
        reason: "Swipe không có tọa độ hợp lệ.",
      };
    }

    result.x1 = Math.round(x1);
    result.y1 = Math.round(y1);
    result.x2 = Math.round(x2);
    result.y2 = Math.round(y2);

    result.duration = numberOrNull(raw.duration) || 400;
  }

  // ----------------------------------------------------------
  // TYPE
  // ----------------------------------------------------------

  if (action === "type") {
    const text = safeString(raw.text);

    if (!text) {
      return {
        action: "wait",
        reason: "Type không có text.",
      };
    }

    result.text = text;
  }

  // ----------------------------------------------------------
  // WAIT
  // ----------------------------------------------------------

  if (action === "wait") {
    result.ms = numberOrNull(raw.ms) || 1000;
  }

  // ----------------------------------------------------------
  // DONE
  // ----------------------------------------------------------

  if (action === "done") {
    result.reason =
      safeString(raw.reason) ||
      "Đã hoàn thành.";
  }

  // ----------------------------------------------------------
  // PLAN
  // ----------------------------------------------------------

  if (action === "plan") {
    if (Array.isArray(raw.steps)) {
      result.steps = raw.steps
        .map(normalizePlanStep)
        .filter(Boolean)
        .slice(0, 8);
    }

    result.reason =
      safeString(raw.reason) ||
      "Thực hiện kế hoạch ngắn.";
  }

  if (raw.reason) {
    result.reason = trimText(raw.reason, 1000);
  }

  if (raw.target) {
    result.target = trimText(raw.target, 500);
  }

  return result;
}

// ============================================================
// NORMALIZE PLAN STEP
// ============================================================

function normalizePlanStep(step) {
  if (!step || typeof step !== "object") {
    return null;
  }

  const action = safeString(step.action)
    .toLowerCase()
    .trim();

  if (!ACTIONS.includes(action)) {
    return null;
  }

  const output = {
    action,
  };

  if (action === "tap") {
    const x = numberOrNull(step.x);
    const y = numberOrNull(step.y);

    if (x === null || y === null) {
      return null;
    }

    output.x = Math.round(x);
    output.y = Math.round(y);
  }

  if (action === "swipe") {
    const x1 = numberOrNull(step.x1);
    const y1 = numberOrNull(step.y1);
    const x2 = numberOrNull(step.x2);
    const y2 = numberOrNull(step.y2);

    if (
      x1 === null ||
      y1 === null ||
      x2 === null ||
      y2 === null
    ) {
      return null;
    }

    output.x1 = Math.round(x1);
    output.y1 = Math.round(y1);
    output.x2 = Math.round(x2);
    output.y2 = Math.round(y2);
    output.duration =
      numberOrNull(step.duration) || 400;
  }

  if (action === "type") {
    const text = safeString(step.text);

    if (!text) {
      return null;
    }

    output.text = text;
  }

  if (action === "wait") {
    output.ms =
      numberOrNull(step.ms) || 1000;
  }

  if (action === "done") {
    output.reason =
      safeString(step.reason) ||
      "Hoàn thành.";
  }

  if (step.reason) {
    output.reason =
      trimText(step.reason, 500);
  }

  return output;
}

// ============================================================
// INFO
// ============================================================

function buildInfo(info) {
  if (!info) {
    return "Không có INFO được cung cấp.";
  }

  if (typeof info === "string") {
    return trimText(info, 5000);
  }

  try {
    return trimText(
      JSON.stringify(info, null, 2),
      5000
    );
  } catch {
    return "Không thể đọc INFO.";
  }
}

// ============================================================
// HISTORY
// ============================================================

function buildHistory(history) {
  if (!history) {
    return "Chưa có lịch sử action.";
  }

  if (typeof history === "string") {
    return trimText(history, 5000);
  }

  if (Array.isArray(history)) {
    return trimText(
      JSON.stringify(history, null, 2),
      5000
    );
  }

  try {
    return trimText(
      JSON.stringify(history, null, 2),
      5000
    );
  } catch {
    return "Không thể đọc history.";
  }
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
BẠN LÀ VISION AGENT ĐIỀU KHIỂN GIAO DIỆN MOBILE CHO AUTOTOUCH.

Bạn chỉ được phân tích SCREENSHOT hiện tại và dữ liệu được cung cấp.
Mỗi lần chỉ quyết định action tiếp theo an toàn và chắc chắn nhất.

============================================================
MỤC TIÊU
============================================================

${trimText(goal || "Hoàn thành màn hình đăng ký hiện tại và chuyển sang bước tiếp theo.", 3000)}

============================================================
DỮ LIỆU INFO
============================================================

${buildInfo(info)}

============================================================
LỊCH SỬ ACTION
============================================================

${buildHistory(history)}

============================================================
RULES TỪ CLIENT
============================================================

${trimText(rules || "", 8000)}

============================================================
QUY TẮC CỐT LÕI
============================================================

1. CHỈ DỰA TRÊN SCREENSHOT
- Chỉ thao tác với UI thực sự nhìn thấy trên screenshot.
- Không được tự bịa button, text, input, tọa độ hoặc trạng thái UI.
- Không đoán một control tồn tại nếu screenshot không có đủ bằng chứng.

2. MỖI VÒNG CHỈ MỘT ACTION
- Bình thường chỉ trả về một action duy nhất.
- Sau tap/type/swipe, client sẽ chụp screenshot mới.
- Không giả định UI đã thay đổi nếu chưa nhìn thấy screenshot mới.

3. KHÔNG CLICK MÙ
- Không tap chỉ vì một button có màu nổi bật.
- Phải xác định ý nghĩa button dựa trên text, vị trí, ngữ cảnh và mục tiêu.
- Không tap logo, banner, quảng cáo hoặc text trang trí.

============================================================
LUỒNG TẠO TÀI KHOẢN / ĐĂNG KÝ
============================================================

- Nếu mục tiêu là đăng ký tài khoản, tìm các lựa chọn:
  "Tạo tài khoản"
  "Đăng ký"
  "Đăng kí"
  "Tạo tài khoản mới"
  "Create account"
  "Sign up"
  "Register"

- Nếu đang ở màn hình đăng nhập và thấy "Tạo tài khoản" hoặc "Đăng ký", ưu tiên tap lựa chọn đó.

- KHÔNG nhầm:
  "Đăng nhập"
  "Login"
  "Log in"
  "Sign in"
  với:
  "Đăng ký"
  "Sign up"
  "Register"

- Nếu mục tiêu là tạo tài khoản, không tap nút đăng nhập chỉ vì nó nổi bật hơn.

- Khi đã vào màn hình đăng ký, xử lý lần lượt các trường bắt buộc đang nhìn thấy.

- Nếu có:
  "Tiếp tục"
  "Continue"
  "Next"
  "Tiếp theo"
  thì chỉ tap khi các trường bắt buộc của bước hiện tại đã được xử lý.

- Nếu thấy:
  "Tạo tài khoản"
  "Đăng ký"
  "Create account"
  "Sign up"
  "Register"
  và đó rõ ràng là nút submit của form, chỉ tap khi các trường bắt buộc đã hoàn tất.

============================================================
DỮ LIỆU INFO
============================================================

- INFO là dữ liệu đầu vào đáng tin cậy để điền form.
- Nếu INFO có Họ tên thì sử dụng đúng Họ tên.
- Nếu INFO có Ngày sinh thì sử dụng đúng Ngày sinh.
- Nếu INFO có Số điện thoại thì sử dụng đúng Số điện thoại.
- Nếu INFO có Mật khẩu thì sử dụng đúng Mật khẩu.
- Nếu INFO có dữ liệu xác nhận mật khẩu thì sử dụng đúng dữ liệu đó.
- Không tự tạo dữ liệu thay thế khi INFO đã có giá trị.
- Không tự bịa dữ liệu nếu INFO không cung cấp.
- Chỉ sử dụng dữ liệu đúng với trường đang nhìn thấy.

============================================================
HỌ TÊN
============================================================

Nếu thấy:

"Họ tên"
"Họ và tên"
"Full name"
"Name"
"Your name"

và ngữ cảnh là form đăng ký:

- Nếu INFO có Họ tên, sử dụng chính xác Họ tên trong INFO.
- Nếu field đang trống:
  1. tap field nếu cần
  2. type Họ tên
- Nếu field đã chứa đúng Họ tên:
  không type lại.
- Nếu field chứa dữ liệu khác:
  chỉ sửa khi screenshot cho thấy field cần sửa.
- Giữ nguyên thứ tự họ tên và khoảng trắng.
- Không nhập số điện thoại hoặc mật khẩu vào field Họ tên.

Nếu giao diện có hai field:

"Họ"
"Tên"

thì phải xử lý riêng từng field.

Không gộp toàn bộ họ tên vào một field nếu UI yêu cầu tách riêng.

============================================================
NGÀY SINH
============================================================

Nếu thấy:

"Ngày sinh"
"Sinh nhật"
"Date of birth"
"Birthday"
"DOB"

- Nếu INFO có ngày sinh, sử dụng chính xác ngày sinh đó.
- Không tự đoán ngày sinh.
- Không tự tạo ngày sinh nếu INFO không có.

Nếu field là text input:
- tap field
- type ngày sinh đúng định dạng UI yêu cầu.

Nếu field mở date picker:
- không cố type vào vùng không nhận text.
- thao tác với date picker đang hiển thị.

Nếu là wheel picker:
- xác định riêng:
  Ngày
  Tháng
  Năm
- Chỉ swipe bánh xe cần thay đổi.
- Sau mỗi lần swipe phải chờ screenshot mới.
- Không swipe liên tiếp dựa trên phỏng đoán.

Nếu có:
"Hủy"
"Cancel"
"Xong"
"Done"

- Không bấm Hủy nếu mục tiêu là hoàn thành ngày sinh.
- Chỉ bấm Xong/Done khi ngày đã được đặt đúng.

Nếu ngày sinh đã đúng:
- không nhập lại.

============================================================
SỐ ĐIỆN THOẠI
============================================================

Nếu thấy:

"Số điện thoại"
"Điện thoại"
"Phone"
"Phone number"
"Mobile"

- Nếu INFO có số điện thoại, sử dụng đúng số trong INFO.
- Không nhập số điện thoại vào field Họ tên, Ngày sinh hoặc Mật khẩu.
- Nếu field đã có đúng số cần dùng, không type lại.
- Nếu field có dữ liệu khác, chỉ sửa khi cần thiết.

Nếu có mã quốc gia:

"+84"
"+1"
"+44"
...

- Xác định mã quốc gia hiện tại từ screenshot.
- Không tự thay đổi mã quốc gia nếu chưa có bằng chứng cần thay đổi.

Không tự thêm/bớt số 0 nếu UI không yêu cầu.

Nếu screenshot hoặc placeholder cho thấy format bắt buộc cụ thể thì tuân theo format đó.

============================================================
MẬT KHẨU
============================================================

Nếu thấy:

"Mật khẩu"
"Password"
"Create password"
"New password"

- Nếu INFO có mật khẩu, sử dụng chính xác mật khẩu trong INFO.
- Không tự thay đổi mật khẩu.
- Không nhập mật khẩu vào field khác.

Nếu field đang hiển thị:
"*"
"••••"
"••••••"
hoặc ký hiệu ẩn:

- Không thể xác định nội dung thực tế chỉ từ screenshot.
- Không tự kết luận mật khẩu đã đúng hoặc sai.
- Nếu không có bằng chứng cần sửa thì không type lại.

============================================================
XÁC NHẬN MẬT KHẨU
============================================================

Nếu thấy:

"Xác nhận mật khẩu"
"Nhập lại mật khẩu"
"Confirm password"
"Re-enter password"

- Dùng đúng mật khẩu trong INFO.
- Không nhầm với field Mật khẩu chính.
- Nếu cả hai field cùng xuất hiện, xử lý từng field đúng vị trí.

============================================================
INPUT ĐÃ CÓ DỮ LIỆU
============================================================

- Không type lại dữ liệu chỉ vì field vẫn xuất hiện trên screenshot.
- Nếu field đã có đúng giá trị cần dùng thì bỏ qua field đó.
- Nếu password bị che bằng dấu chấm thì không tự đoán nội dung.
- Chỉ sửa field khi có bằng chứng field sai hoặc cần nhập dữ liệu khác.

============================================================
LOADING / SPINNER
============================================================

- Nếu button đang hiển thị spinner/loading indicator thay cho chữ, không coi spinner là text target.
- Chỉ trả found=true cho button nếu có thể xác định rõ theo ngữ cảnh.
- Không click lại một button đang loading.
- Nếu toàn bộ UI đang loading, ưu tiên wait.
- Nếu vừa submit và đang loading, không submit lần nữa.

============================================================
BUTTON ĐĂNG KÝ / TIẾP TỤC
============================================================

Khi đã hoàn tất các field bắt buộc:

- Có thể tìm:
  "Đăng ký"
  "Tạo tài khoản"
  "Create account"
  "Sign up"
  "Register"
  "Tiếp tục"
  "Continue"
  "Next"
  "Tiếp theo"

- Chỉ tap button khi screenshot xác nhận đó là button thực sự.
- Không tap nếu button bị disabled.
- Không tap lại nếu button đang loading.

============================================================
BUTTON DISABLED
============================================================

Nếu button:

- bị mờ rõ ràng
- không thể tương tác
- có trạng thái disabled rõ ràng

thì không tap.

Nếu button chưa hoạt động vì field chưa đủ dữ liệu:
- xử lý field còn thiếu trước.

============================================================
VALIDATION ERROR
============================================================

Nếu sau khi submit xuất hiện lỗi:

- đọc text lỗi trên screenshot.
- xác định field liên quan.
- sửa field đó nếu INFO cung cấp dữ liệu phù hợp.
- không lặp lại cùng action nếu UI chưa thay đổi.

Ví dụ:

"Số điện thoại không hợp lệ"
→ xử lý field số điện thoại.

"Mật khẩu phải..."
→ xử lý field mật khẩu nếu INFO có thể đáp ứng.

"Vui lòng nhập họ tên"
→ xử lý field Họ tên.

============================================================
CAPTCHA / OTP / XÁC MINH
============================================================

Nếu xuất hiện:

- CAPTCHA
- OTP
- mã xác minh
- xác minh danh tính
- challenge
- yêu cầu thao tác đặc biệt

không được tự đoán.

Nếu không có action chắc chắn từ screenshot:
- wait.

============================================================
SCROLL
============================================================

Chỉ swipe/scroll khi:

- field hoặc button mục tiêu không nhìn thấy.
- Có bằng chứng nội dung còn nằm phía dưới/phía trên.
- Scroll là cần thiết để tiếp tục flow.

Không scroll ngẫu nhiên.

Sau mỗi scroll:
- chờ UI ổn định.
- phân tích screenshot mới.

============================================================
DATE PICKER / WHEEL PICKER
============================================================

- Không đoán tọa độ.
- Dựa trên screenshot hiện tại.
- Nếu cần thay đổi wheel:
  swipe đúng bánh xe.
- Sau mỗi swipe phải chờ screenshot mới.
- Không thực hiện nhiều swipe liên tục mà không kiểm tra kết quả.

============================================================
LỊCH SỬ ACTION
============================================================

History chỉ dùng để tránh:

- tap cùng một button liên tục
- nhập cùng một dữ liệu nhiều lần
- swipe lặp lại không cần thiết
- quay lại action cũ khi UI đã thay đổi

Nhưng screenshot hiện tại luôn có quyền ưu tiên cao hơn history.

============================================================
SAU MỖI ACTION
============================================================

Sau:

tap
type
swipe

phải giả định UI có thể thay đổi.

Không tự thực hiện action tiếp theo nếu chưa có screenshot mới.

============================================================
NGUYÊN TẮC AN TOÀN
============================================================

Nếu không chắc chắn:

- không đoán.
- không click ngẫu nhiên.
- không type ngẫu nhiên.
- không swipe ngẫu nhiên.

Ưu tiên:

wait

hoặc action có bằng chứng rõ ràng.

============================================================
OUTPUT
============================================================

CHỈ TRẢ VỀ JSON HỢP LỆ.

Không markdown.
Không ```json.
Không giải thích bên ngoài JSON.

Schema:

{
  "action": "tap|swipe|type|wait|done|plan",
  "x": 0,
  "y": 0,
  "x1": 0,
  "y1": 0,
  "x2": 0,
  "y2": 0,
  "duration": 400,
  "text": "",
  "ms": 1000,
  "reason": "",
  "target": "",
  "steps": []
}

============================================================
QUY TẮC ACTION
============================================================

tap:
{
  "action": "tap",
  "x": 123,
  "y": 456,
  "reason": "..."
}

swipe:
{
  "action": "swipe",
  "x1": 500,
  "y1": 700,
  "x2": 500,
  "y2": 300,
  "duration": 400,
  "reason": "..."
}

type:
{
  "action": "type",
  "text": "Nguyễn Văn An",
  "reason": "..."
}

wait:
{
  "action": "wait",
  "ms": 1000,
  "reason": "..."
}

done:
{
  "action": "done",
  "reason": "..."
}

plan:
{
  "action": "plan",
  "steps": [
    {
      "action": "tap",
      "x": 100,
      "y": 200
    }
  ],
  "reason": "..."
}

============================================================
ƯU TIÊN QUYẾT ĐỊNH
============================================================

1. Nhìn screenshot.
2. Xác định màn hình hiện tại.
3. Xác định mục tiêu hiện tại.
4. Kiểm tra INFO.
5. Kiểm tra field/button đã có dữ liệu hay chưa.
6. Không lặp lại action đã hoàn thành.
7. Chọn đúng một action tiếp theo.
8. Chỉ trả JSON.
`;
}

// ============================================================
// GEMINI CALL
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

  const body = {
    systemInstruction: {
      parts: [
        {
          text:
            "Bạn là Vision Agent điều khiển UI mobile. " +
            "Hãy tuân thủ toàn bộ quy tắc tiếng Việt trong prompt. " +
            "Chỉ trả JSON hợp lệ, không markdown, không giải thích ngoài JSON.",
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
      responseMimeType: "application/json",

      responseSchema: {
        type: "OBJECT",

        properties: {
          action: {
            type: "STRING",
            enum: ACTIONS,
          },

          x: {
            type: "NUMBER",
          },

          y: {
            type: "NUMBER",
          },

          x1: {
            type: "NUMBER",
          },

          y1: {
            type: "NUMBER",
          },

          x2: {
            type: "NUMBER",
          },

          y2: {
            type: "NUMBER",
          },

          duration: {
            type: "NUMBER",
          },

          text: {
            type: "STRING",
          },

          ms: {
            type: "NUMBER",
          },

          reason: {
            type: "STRING",
          },

          target: {
            type: "STRING",
          },

          steps: {
            type: "ARRAY",
            items: {
              type: "OBJECT",

              properties: {
                action: {
                  type: "STRING",
                  enum: ACTIONS,
                },

                x: {
                  type: "NUMBER",
                },

                y: {
                  type: "NUMBER",
                },

                x1: {
                  type: "NUMBER",
                },

                y1: {
                  type: "NUMBER",
                },

                x2: {
                  type: "NUMBER",
                },

                y2: {
                  type: "NUMBER",
                },

                duration: {
                  type: "NUMBER",
                },

                text: {
                  type: "STRING",
                },

                ms: {
                  type: "NUMBER",
                },

                reason: {
                  type: "STRING",
                },
              },
            },
          },
        },

        required: [
          "action",
        ],
      },
    },
  };

  const response = await fetch(
    GEMINI_URL,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
      },

      body: JSON.stringify(body),
    }
  );

  const responseText = await response.text();

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Gemini trả response không phải JSON: ${responseText.slice(0, 1000)}`
    );
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      `Gemini HTTP ${response.status}`;

    const error = new Error(message);

    error.status = response.status;
    error.gemini = data;

    throw error;
  }

  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text || "")
      .join("")
      .trim();

  if (!text) {
    throw new Error(
      "Gemini không trả về nội dung."
    );
  }

  const parsed = extractJson(text);

  if (!parsed) {
    throw new Error(
      `Không parse được JSON từ Gemini: ${text.slice(0, 1500)}`
    );
  }

  return parsed;
}

// ============================================================
// ERROR MESSAGE
// ============================================================

function errorMessage(error) {
  const status = error?.status;

  if (status === 401 || status === 403) {
    return "Gemini API key không hợp lệ hoặc không có quyền sử dụng model.";
  }

  if (status === 429) {
    return "Gemini API đang hết quota/rate limit.";
  }

  if (status >= 500) {
    return "Gemini server đang lỗi hoặc quá tải.";
  }

  return (
    error?.message ||
    "Lỗi không xác định."
  );
}

// ============================================================
// API HANDLER
// ============================================================

export default async function handler(req, res) {
  // ----------------------------------------------------------
  // METHOD
  // ----------------------------------------------------------

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  // ----------------------------------------------------------
  // BODY
  // ----------------------------------------------------------

  const body = req.body || {};

  const image = body.image;
  const key = body.key;

  const goal =
    body.goal ||
    "Hoàn thành màn hình đăng ký hiện tại và chuyển sang bước tiếp theo.";

  const info = body.info || "";

  const rules = body.rules || "";

  const history = body.history || [];

  // ----------------------------------------------------------
  // VALIDATION
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // CALL GEMINI
  // ----------------------------------------------------------

  try {
    const rawAction = await callGemini({
      image,
      key,
      goal,
      info,
      rules,
      history,
    });

    const action = normalizeAction(
      rawAction
    );

    return res.status(200).json({
      ok: true,

      model: MODEL_ID,

      action,

      server: "autotouch-vision",

      version: "3.5-vn-registration-rules",
    });
  } catch (error) {
    console.error(
      "Gemini analyze error:",
      error
    );

    return res.status(200).json({
      ok: false,

      model: MODEL_ID,

      action: {
        action: "wait",
        ms: 1500,
        reason: errorMessage(error),
      },

      error: errorMessage(error),

      server: "autotouch-vision",

      version: "3.5-vn-registration-rules",
    });
  }
}
