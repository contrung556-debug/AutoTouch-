// ============================================================
// pages/api/analyze.js
// AUTOTOUCH VISION AGENT
// VERSION: 5.2-name-plan-fix
//
// Gemini:
//   - Primary: gemini-3.5-flash-lite
//   - Recovery: same model by default
//
// Supports:
//   tap
//   swipe
//   type
//   wait
//   wheel
//   plan
//   launch
//   restart
//   done
//   fail
//
// Important:
//   - NAME SCREEN plan fixed
//   - plan.steps[].action is the canonical format
//   - type text must exist in INFO
//   - no "Tiếp" inside name-entry plan
// ============================================================

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "4.5mb",
    },
  },
  maxDuration: 60,
};

// ============================================================
// CONFIG
// ============================================================

const MODEL_ID =
  process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const RECOVERY_MODEL =
  process.env.GEMINI_RECOVERY_MODEL || MODEL_ID;

const VERSION = "5.2-name-plan-fix";

const ATTEMPTS = 2;
const TIMEOUT_MS = 22000;

const MAX_PLAN_STEPS = 6;
const MAX_WHEEL_ROWS = 40;

const GEMINI_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

const ALLOWED_ACTIONS = [
  "tap",
  "swipe",
  "type",
  "wait",
  "wheel",
  "plan",
  "launch",
  "restart",
  "done",
  "fail",
];

// ============================================================
// HELPERS
// ============================================================

function str(v, fallback = "") {
  return typeof v === "string" ? v : fallback;
}

function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function cleanText(v) {
  return String(v ?? "")
    .replace(/\u0000/g, "")
    .trim();
}

function jsonSafe(v, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return fallback;
  }
}

// ============================================================
// IMAGE
// ============================================================

function normalizeImage(input) {
  if (!input || typeof input !== "string") {
    throw new Error("IMAGE_MISSING");
  }

  let s = input.trim();

  // data:image/png;base64,...
  if (s.startsWith("data:image/")) {
    const comma = s.indexOf(",");

    if (comma < 0) {
      throw new Error("IMAGE_DATA_URI_INVALID");
    }

    const header = s.slice(0, comma);
    const data = s.slice(comma + 1);

    if (!data) {
      throw new Error("IMAGE_DATA_EMPTY");
    }

    let mime = "image/png";

    if (/image\/jpeg/i.test(header)) {
      mime = "image/jpeg";
    }

    if (/image\/jpg/i.test(header)) {
      mime = "image/jpeg";
    }

    if (/image\/webp/i.test(header)) {
      mime = "image/webp";
    }

    return {
      mimeType: mime,
      data: data.replace(/\s+/g, ""),
    };
  }

  // raw base64
  s = s.replace(/\s+/g, "");

  if (!s) {
    throw new Error("IMAGE_DATA_EMPTY");
  }

  return {
    mimeType: "image/png",
    data: s,
  };
}

// ============================================================
// IMAGE SIZE
// ============================================================

function getImageSize(image) {
  try {
    const buffer = Buffer.from(image.data, "base64");

    // PNG
    if (
      buffer.length >= 24 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    ) {
      return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
      };
    }

    // JPEG
    if (
      buffer.length >= 2 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8
    ) {
      let offset = 2;

      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset++;
          continue;
        }

        const marker = buffer[offset + 1];

        // SOF markers
        const isSOF =
          marker === 0xc0 ||
          marker === 0xc1 ||
          marker === 0xc2 ||
          marker === 0xc3 ||
          marker === 0xc5 ||
          marker === 0xc6 ||
          marker === 0xc7 ||
          marker === 0xc9 ||
          marker === 0xca ||
          marker === 0xcb ||
          marker === 0xcd ||
          marker === 0xce ||
          marker === 0xcf;

        if (isSOF) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);

          return {
            width,
            height,
          };
        }

        if (offset + 4 > buffer.length) {
          break;
        }

        const segmentLength = buffer.readUInt16BE(offset + 2);

        if (!segmentLength || segmentLength < 2) {
          break;
        }

        offset += 2 + segmentLength;
      }
    }
  } catch {
    // ignore
  }

  return {
    width: null,
    height: null,
  };
}

// ============================================================
// COORDINATE NORMALIZATION
//
// Gemini is instructed to use 0..1000 coordinates.
// AutoTouch/client receives actual screenshot pixels.
// ============================================================

function normalizeXY(x, y, width, height) {
  let nx = num(x);
  let ny = num(y);

  if (nx === null || ny === null) {
    return {
      x: null,
      y: null,
    };
  }

  // 0..1000 coordinate system
  if (
    nx >= 0 &&
    nx <= 1000 &&
    ny >= 0 &&
    ny <= 1000 &&
    width &&
    height
  ) {
    nx = (nx / 1000) * width;
    ny = (ny / 1000) * height;
  }

  if (width) {
    nx = clamp(nx, 0, width - 1);
  }

  if (height) {
    ny = clamp(ny, 0, height - 1);
  }

  return {
    x: Math.round(nx),
    y: Math.round(ny),
  };
}

// ============================================================
// TEXT VALIDATION
// ============================================================

function textAllowed(text, info) {
  const t = cleanText(text);

  if (!t) {
    return false;
  }

  const source = String(info || "");

  if (!source) {
    return false;
  }

  return source.includes(t);
}

// ============================================================
// NORMALIZE PLAN STEP
// ============================================================

function normalizePlanStep(step, info, width, height) {
  if (!step || typeof step !== "object") {
    return null;
  }

  // ----------------------------------------------------------
  // IMPORTANT:
  // canonical field is step.action
  //
  // We DO NOT accept:
  // { type: "tap" }
  //
  // We accept:
  // { action: "tap" }
  // ----------------------------------------------------------

  const action = cleanText(step.action).toLowerCase();

  if (!["tap", "type"].includes(action)) {
    return null;
  }

  // ----------------------------------------------------------
  // TAP
  // ----------------------------------------------------------

  if (action === "tap") {
    const point = normalizeXY(
      step.x,
      step.y,
      width,
      height
    );

    if (
      point.x === null ||
      point.y === null
    ) {
      return null;
    }

    return {
      action: "tap",
      x: point.x,
      y: point.y,
    };
  }

  // ----------------------------------------------------------
  // TYPE
  // ----------------------------------------------------------

  if (action === "type") {
    const text = cleanText(step.text);

    if (!text) {
      return null;
    }

    if (!textAllowed(text, info)) {
      return null;
    }

    return {
      action: "type",
      text,
    };
  }

  return null;
}

// ============================================================
// NORMALIZE ACTION
// ============================================================

function normalizeAction(raw, info, width, height) {
  if (!raw || typeof raw !== "object") {
    return {
      action: "fail",
      reason: "AI returned an invalid action object.",
    };
  }

  let action = cleanText(raw.action).toLowerCase();

  // ----------------------------------------------------------
  // Small compatibility layer.
  //
  // The model MUST still return "action", but this prevents
  // harmless capitalization problems.
  // ----------------------------------------------------------

  if (!ALLOWED_ACTIONS.includes(action)) {
    return {
      action: "fail",
      reason: `Unsupported action: ${action || "empty"}`,
    };
  }

  // ==========================================================
  // TAP
  // ==========================================================

  if (action === "tap") {
    const point = normalizeXY(
      raw.x,
      raw.y,
      width,
      height
    );

    if (
      point.x === null ||
      point.y === null
    ) {
      return {
        action: "fail",
        reason: "Tap coordinates are invalid.",
      };
    }

    return {
      action: "tap",
      x: point.x,
      y: point.y,
      reason: str(raw.reason),
    };
  }

  // ==========================================================
  // SWIPE
  // ==========================================================

  if (action === "swipe") {
    const from = normalizeXY(
      raw.x1,
      raw.y1,
      width,
      height
    );

    const to = normalizeXY(
      raw.x2,
      raw.y2,
      width,
      height
    );

    if (
      from.x === null ||
      from.y === null ||
      to.x === null ||
      to.y === null
    ) {
      return {
        action: "fail",
        reason: "Swipe coordinates are invalid.",
      };
    }

    const duration = clamp(
      num(raw.duration, 500),
      100,
      3000
    );

    return {
      action: "swipe",
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      duration,
      reason: str(raw.reason),
    };
  }

  // ==========================================================
  // TYPE
  // ==========================================================

  if (action === "type") {
    const text = cleanText(raw.text);

    if (!text) {
      return {
        action: "fail",
        reason: "Type text is empty.",
      };
    }

    if (!textAllowed(text, info)) {
      return {
        action: "fail",
        reason:
          "AI attempted to type text that does not exist in INFO.",
      };
    }

    return {
      action: "type",
      text,
      reason: str(raw.reason),
    };
  }

  // ==========================================================
  // WAIT
  // ==========================================================

  if (action === "wait") {
    const seconds = clamp(
      num(raw.seconds, 2),
      1,
      10
    );

    return {
      action: "wait",
      seconds,
      reason: str(raw.reason),
    };
  }

  // ==========================================================
  // WHEEL
  // ==========================================================

  if (action === "wheel") {
    const rows = num(raw.rows);

    if (rows === null || rows === 0) {
      return {
        action: "fail",
        reason: "Wheel rows are invalid.",
      };
    }

    if (Math.abs(rows) > MAX_WHEEL_ROWS) {
      return {
        action: "fail",
        reason:
          `Wheel movement exceeds ${MAX_WHEEL_ROWS} rows.`,
      };
    }

    const point = normalizeXY(
      raw.x,
      raw.y,
      width,
      height
    );

    if (
      point.x === null ||
      point.y === null
    ) {
      return {
        action: "fail",
        reason: "Wheel coordinates are invalid.",
      };
    }

    return {
      action: "wheel",
      x: point.x,
      y: point.y,
      rows: Math.round(rows),
      reason: str(raw.reason),
    };
  }

  // ==========================================================
  // PLAN
  // ==========================================================

  if (action === "plan") {
    // --------------------------------------------------------
    // The biggest fix:
    //
    // Gemini must return:
    //
    // {
    //   "action": "plan",
    //   "steps": [
    //      {"action":"tap",...},
    //      {"action":"type","text":"..."},
    //      ...
    //   ]
    // }
    //
    // NOT:
    //
    // {"type":"tap"}
    // --------------------------------------------------------

    if (!Array.isArray(raw.steps)) {
      return {
        action: "fail",
        reason: "Plan không hợp lệ: thiếu steps.",
      };
    }

    if (raw.steps.length < 1) {
      return {
        action: "fail",
        reason: "Plan không hợp lệ: steps rỗng.",
      };
    }

    if (raw.steps.length > MAX_PLAN_STEPS) {
      return {
        action: "fail",
        reason:
          `Plan không hợp lệ: tối đa ${MAX_PLAN_STEPS} steps.`,
      };
    }

    const steps = [];

    for (const step of raw.steps) {
      const normalized = normalizePlanStep(
        step,
        info,
        width,
        height
      );

      if (!normalized) {
        return {
          action: "fail",
          reason:
            "Plan không hợp lệ: mỗi step phải là action='tap' hoặc action='type', và type phải nằm trong INFO.",
        };
      }

      steps.push(normalized);
    }

    // --------------------------------------------------------
    // NAME SCREEN SAFETY
    //
    // Never allow "Tiếp" inside the same name-entry plan.
    // We cannot reliably know the button coordinate, so the
    // server enforces the plan structure only:
    //
    // tap Họ
    // type Họ
    // tap Tên
    // type Tên
    //
    // A client screenshot after the plan decides next action.
    // --------------------------------------------------------

    const reason = str(raw.reason);

    return {
      action: "plan",
      steps,
      reason,
    };
  }

  // ==========================================================
  // LAUNCH
  // ==========================================================

  if (action === "launch") {
    return {
      action: "launch",
      reason: str(raw.reason),
    };
  }

  // ==========================================================
  // RESTART
  // ==========================================================

  if (action === "restart") {
    return {
      action: "restart",
      reason: str(raw.reason),
    };
  }

  // ==========================================================
  // DONE
  // ==========================================================

  if (action === "done") {
    return {
      action: "done",
      reason: str(raw.reason),
    };
  }

  // ==========================================================
  // FAIL
  // ==========================================================

  if (action === "fail") {
    return {
      action: "fail",
      reason:
        str(raw.reason) ||
        "AI reported failure.",
    };
  }

  return {
    action: "fail",
    reason: "Unknown action.",
  };
}

// ============================================================
// SYSTEM RULES
// ============================================================

const SYSTEM_RULES = [
  "You are a STRICT iOS Facebook signup vision controller.",
  "You see exactly ONE current screenshot.",
  "Never invent UI elements that are not visible.",
  "Never invent text values.",
  "Never invent phone numbers.",
  "Never invent passwords.",
  "Never use information that is not present in INFO.",

  // ----------------------------------------------------------
  // COORDINATES
  // ----------------------------------------------------------

  "COORDINATES:",
  "- Return x/y in a 0..1000 coordinate system.",
  "- x=0 is left, x=1000 is right.",
  "- y=0 is top, y=1000 is bottom.",
  "- Tap the center of the actual visible control.",
  "- Never tap based on a remembered coordinate from an old screenshot.",

  // ----------------------------------------------------------
  // LOADING
  // ----------------------------------------------------------

  "LOADING / SPINNER:",
  "- If a button displays a spinner/loading indicator instead of normal text, do NOT treat the spinner as the target text.",
  "- Do not click a button that is visibly loading.",
  "- If the UI is loading, return wait.",
  "- Never repeat-click a loading button.",
  "- Prefer wait 2-3 seconds.",

  // ----------------------------------------------------------
  // EXISTING INPUT
  // ----------------------------------------------------------

  "INPUT ALREADY FILLED:",
  "- If an input already contains the correct value, do not type it again.",
  "- Masked password dots count as already entered if the password field visibly contains content.",
  "- Do not clear a correct existing value.",
  "- Do not append duplicate text.",
  "- Only type into an empty or clearly incomplete field.",

  // ----------------------------------------------------------
  // FACEBOOK WELCOME
  // ----------------------------------------------------------

  "WELCOME SCREEN:",
  "- If the visible screen has 'Tham gia Facebook' and a button 'Bắt đầu', tap 'Bắt đầu'.",
  "- Never choose 'Tôi có trang cá nhân rồi' for this flow.",

  // ----------------------------------------------------------
  // CREATE ACCOUNT
  // ----------------------------------------------------------

  "CREATE ACCOUNT SCREEN:",
  "- If the screen says 'Tham gia Facebook' and shows 'Tạo tài khoản mới', tap 'Tạo tài khoản mới'.",
  "- Never choose 'Tìm tài khoản của tôi'.",
  "- Do not press back when the create-account option is visible.",

  // ----------------------------------------------------------
  // LOGIN SCREEN
  // ----------------------------------------------------------

  "LOGIN SCREEN:",
  "- If login fields are visible and 'Tạo tài khoản mới' is visible, tap 'Tạo tài khoản mới'.",
  "- Do not enter credentials into the login screen.",
  "- Do not press login.",

  // ----------------------------------------------------------
  // META ACCOUNT
  // ----------------------------------------------------------

  "META ACCOUNT SCREEN:",
  "- If 'Bắt đầu trên Facebook bằng Tài khoản Meta' is visible with 'Bắt đầu', tap 'Bắt đầu'.",

  // ==========================================================
  // NAME SCREEN - IMPORTANT FIX
  // ==========================================================

  "NAME SCREEN - BAN TEN GI:",
  "- If the current screen has title 'Bạn tên gì?' and fields 'Họ' and 'Tên':",

  "- If BOTH Họ and Tên are empty:",
  "  + MUST return action='plan'.",
  "  + The plan MUST contain tap Họ -> type Họ -> tap Tên -> type Tên.",
  "  + Do NOT tap 'Tiếp' in this same plan.",
  "  + Do NOT type both names into one field.",
  "  + Use coordinates from the CURRENT screenshot.",
  "  + Do not use hard-coded coordinates.",

  "- If Họ is empty and Tên already contains the correct value:",
  "  + Plan only Họ: tap Họ -> type Họ.",

  "- If Tên is empty and Họ already contains the correct value:",
  "  + Plan only Tên: tap Tên -> type Tên.",

  "- If both Họ and Tên already contain the correct values:",
  "  + Do not type them again.",
  "  + The next screenshot may then allow tapping 'Tiếp'.",

  "- The name-entry plan MUST NOT contain a tap on 'Tiếp'.",
  "- After executing the name-entry plan, the client MUST capture a NEW screenshot before another action.",
  "- Never tap keyboard suggestions.",
  "- Never tap keyboard keys manually.",
  "- Never tap the microphone, globe, spacebar, delete, or 'Xong' unless explicitly required by the UI flow.",

  // ----------------------------------------------------------
  // BIRTH DATE
  // ----------------------------------------------------------

  "BIRTH DATE:",
  "- If a wheel date picker is visible, use wheel actions only.",
  "- Target date comes from INFO in DD/MM/YYYY format.",
  "- Adjust YEAR first, then MONTH, then DAY.",
  "- Each wheel must be handled separately.",
  "- After each wheel movement, the client must capture a new screenshot.",
  "- Years increase downward.",
  "- Month and day wheels wrap.",
  "- Use the shortest direction for month/day when safe.",
  "- Maximum wheel movement is 40 rows per action.",
  "- Verify the displayed date before tapping 'Tiếp'.",
  "- Do not swipe randomly on a wheel.",

  // ----------------------------------------------------------
  // PHONE
  // ----------------------------------------------------------

  "MOBILE NUMBER:",
  "- Use only the exact allowed phone number from INFO.",
  "- If phone field is empty, plan tap -> type exact phone.",
  "- After entering phone, client must capture a new screenshot.",
  "- Only then decide whether to tap 'Tiếp'.",
  "- If Facebook reports invalid or already-used number, return fail.",
  "- Never invent another phone number.",

  // ----------------------------------------------------------
  // PASSWORD
  // ----------------------------------------------------------

  "PASSWORD:",
  "- Use only the exact allowed password from INFO.",
  "- If password field is empty, plan tap -> type exact password.",
  "- If masked dots are already visible, do not type again.",
  "- Do not tap the remember-password checkbox.",
  "- Do not tap the password eye icon.",
  "- After entering password, client must capture a new screenshot.",

  // ----------------------------------------------------------
  // CAPTCHA / OTP
  // ----------------------------------------------------------

  "CAPTCHA / OTP / IDENTITY:",
  "- If CAPTCHA, OTP, identity verification, suspicious login verification, or similar verification is visible, return wait.",
  "- Do not attempt to solve verification automatically.",
  "- If the same verification screen remains unchanged after 3 consecutive waits, return fail.",

  // ----------------------------------------------------------
  // APP OPEN / SPLASH
  // ----------------------------------------------------------

  "APP SPLASH:",
  "- If Facebook or Meta logo splash screen is visible, return wait.",
  "- Do not return launch while the splash is already visible.",
  "- Wait approximately 3 seconds.",

  // ----------------------------------------------------------
  // HOME / APP SWITCHER
  // ----------------------------------------------------------

  "HOME SCREEN / APP SWITCHER:",
  "- If the device is at iOS Home Screen or app switcher instead of Facebook, return launch.",
  "- launch means the client should open Facebook again.",

  // ----------------------------------------------------------
  // APP ERROR
  // ----------------------------------------------------------

  "APP ERROR:",
  "- If the page says 'Trang này hiện không hiển thị' or clearly indicates a technical Facebook page error, return restart.",
  "- Do not simply tap 'Làm mới' for this type of technical error.",

  // ----------------------------------------------------------
  // DEVICE LOCK
  // ----------------------------------------------------------

  "DEVICE LOCK:",
  "- If device passcode/lock screen is visible, return fail.",

  // ----------------------------------------------------------
  // REOPEN
  // ----------------------------------------------------------

  "REOPEN HISTORY:",
  "- If history contains 'App vừa được mở lại', ignore old UI assumptions.",
  "- Evaluate only the current screenshot.",

  // ----------------------------------------------------------
  // SUCCESS
  // ----------------------------------------------------------

  "SUCCESS:",
  "- If Facebook feed/home has been reached and signup flow is complete, return done.",

  // ----------------------------------------------------------
  // REOPEN LIMIT
  // ----------------------------------------------------------

  "REOPEN LIMIT:",
  "- If the app has been reopened 3 or more times and still does not reach the expected flow, return fail.",
].join("\n");

// ============================================================
// RECOVERY BLOCK
// ============================================================

function buildRecoveryBlock(failure) {
  if (!failure || typeof failure !== "object") {
    return "";
  }

  const reason = cleanText(failure.reason);
  const previousAction = cleanText(
    failure.previous_action
  );

  if (!reason && !previousAction) {
    return "";
  }

  return [
    "",
    "RECOVERY MODE:",
    "- The previous action failed.",
    "- DO NOT blindly repeat the failed action.",
    "- Diagnose the current screenshot first.",
    "- If the screen changed, use the new screen state.",
    "- If the target control is loading, return wait.",
    "- If the app is outside Facebook, return launch.",
    "- If a technical Facebook error page is visible, return restart.",
    "- If the action is genuinely impossible, return fail.",
    "",
    `Previous action: ${previousAction || "unknown"}`,
    `Failure reason: ${reason || "unknown"}`,
  ].join("\n");
}

// ============================================================
// PROMPT
// ============================================================

function buildPrompt({
  goal,
  info,
  rules,
  history,
  mode,
  failure,
}) {
  const clientRules = Array.isArray(rules)
    ? rules
        .filter(Boolean)
        .map((x) => String(x))
        .join("\n")
    : "";

  const historyText = Array.isArray(history)
    ? history
        .slice(-20)
        .map((x) => String(x))
        .join("\n")
    : "";

  const recovery =
    mode === "recover"
      ? buildRecoveryBlock(failure)
      : "";

  return [
    "CURRENT TASK:",
    cleanText(goal) || "Complete the current signup flow.",
    "",
    "INFO:",
    String(info || ""),
    "",
    "CLIENT RULES:",
    clientRules || "(none)",
    "",
    "HISTORY:",
    historyText || "(none)",
    "",
    SYSTEM_RULES,
    recovery,
    "",
    "OUTPUT REQUIREMENTS:",
    "- Return ONE JSON object only.",
    "- No markdown.",
    "- No explanation outside JSON.",
    "- action must be one of: tap, swipe, type, wait, wheel, plan, launch, restart, done, fail.",
    "",
    "FOR PLAN:",
    "- plan.steps must be an array.",
    "- Every step MUST use field 'action'.",
    "- Valid step action values are ONLY 'tap' and 'type'.",
    "- Tap step: {action:'tap', x:number, y:number}.",
    "- Type step: {action:'type', text:string}.",
    "- Do not use step.type as the action field.",
    "- Do not put 'Tiếp' inside the name-entry plan.",
    "",
    "JSON SHAPES:",
    "",
    '{"action":"tap","x":500,"y":500,"reason":"..."}',
    "",
    '{"action":"type","text":"Phạm","reason":"..."}',
    "",
    '{"action":"wait","seconds":3,"reason":"..."}',
    "",
    '{"action":"wheel","x":500,"y":500,"rows":3,"reason":"..."}',
    "",
    '{"action":"plan","steps":[' +
      '{"action":"tap","x":250,"y":450},' +
      '{"action":"type","text":"Phạm"},' +
      '{"action":"tap","x":750,"y":450},' +
      '{"action":"type","text":"Thu Hà"}' +
      '],"reason":"Nhập Họ và Tên"}',
    "",
    '{"action":"launch","reason":"..."}',
    "",
    '{"action":"restart","reason":"..."}',
    "",
    '{"action":"done","reason":"..."}',
    "",
    '{"action":"fail","reason":"..."}',
  ].join("\n");
}

// ============================================================
// GEMINI REQUEST
// ============================================================

async function callGemini({
  model,
  key,
  image,
  prompt,
}) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);

  try {
    const url =
      `${GEMINI_BASE}/${encodeURIComponent(model)}` +
      `:generateContent?key=${encodeURIComponent(key)}`;

    const body = {
      systemInstruction: {
        parts: [
          {
            text:
              "Return strict JSON only. " +
              "You are a vision controller. " +
              "Follow the system rules exactly.",
          },
        ],
      },

      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: image.mimeType,
                data: image.data,
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
        maxOutputTokens: 1024,
        responseMimeType: "application/json",
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    let payload = null;

    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const error = new Error(
        payload?.error?.message ||
          `Gemini HTTP ${response.status}`
      );

      error.status = response.status;
      error.payload = payload;

      throw error;
    }

    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// EXTRACT GEMINI TEXT
// ============================================================

function extractGeminiText(payload) {
  const text =
    payload?.candidates?.[0]?.content?.parts
      ?.map((p) => p?.text || "")
      .join("")
      .trim();

  if (!text) {
    throw new Error("GEMINI_EMPTY_RESPONSE");
  }

  return text;
}

// ============================================================
// PARSE JSON
// ============================================================

function parseModelJSON(text) {
  let source = String(text || "").trim();

  // Remove accidental markdown fences
  source = source
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(source);
  } catch {
    // Try extracting first JSON object
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");

    if (start >= 0 && end > start) {
      const candidate = source.slice(
        start,
        end + 1
      );

      try {
        return JSON.parse(candidate);
      } catch {
        // continue
      }
    }
  }

  throw new Error("GEMINI_INVALID_JSON");
}

// ============================================================
// RETRY
// ============================================================

function shouldRetry(status) {
  return (
    status === 429 ||
    status >= 500
  );
}

async function askGemini({
  model,
  key,
  image,
  prompt,
}) {
  let lastError = null;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      return await callGemini({
        model,
        key,
        image,
        prompt,
      });
    } catch (error) {
      lastError = error;

      const status = Number(error?.status || 0);

      if (
        attempt >= ATTEMPTS ||
        !shouldRetry(status)
      ) {
        throw error;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, 600 * attempt)
      );
    }
  }

  throw lastError || new Error("GEMINI_FAILED");
}

// ============================================================
// FRIENDLY ERRORS
// ============================================================

function friendlyError(error, model) {
  const status = Number(error?.status || 0);

  if (error?.name === "AbortError") {
    return "Gemini timeout.";
  }

  if (status === 400) {
    return (
      error?.message ||
      "Gemini request không hợp lệ."
    );
  }

  if (status === 401) {
    return "Gemini API key không hợp lệ.";
  }

  if (status === 403) {
    return "Gemini API key không có quyền sử dụng model.";
  }

  if (status === 404) {
    return `Không tìm thấy Gemini model: ${model}`;
  }

  if (status === 429) {
    return "Gemini quota/rate limit.";
  }

  if (status >= 500) {
    return "Gemini server error.";
  }

  return (
    error?.message ||
    "Unknown Gemini error."
  );
}

function isFatal(error) {
  const status = Number(error?.status || 0);

  return (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404
  );
}

// ============================================================
// CORS
// ============================================================

function setCors(res) {
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
    "Content-Type, Authorization"
  );

  res.setHeader(
    "Cache-Control",
    "no-store, max-age=0"
  );
}

// ============================================================
// MAIN HANDLER
// ============================================================

export default async function handler(req, res) {
  setCors(res);

  // ----------------------------------------------------------
  // OPTIONS
  // ----------------------------------------------------------

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // ----------------------------------------------------------
  // METHOD
  // ----------------------------------------------------------

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed.",
      version: VERSION,
    });
  }

  try {
    const body =
      req.body &&
      typeof req.body === "object"
        ? req.body
        : {};

    // --------------------------------------------------------
    // API KEY
    //
    // Recommended:
    // GEMINI_API_KEY in Vercel Environment Variables.
    //
    // body.key is kept for compatibility with the current
    // AutoTouch client.
    // --------------------------------------------------------

    const key =
      cleanText(body.key) ||
      cleanText(process.env.GEMINI_API_KEY);

    if (!key) {
      return res.status(200).json({
        success: false,
        error: "Missing GEMINI_API_KEY.",
        version: VERSION,
      });
    }

    // --------------------------------------------------------
    // IMAGE
    // --------------------------------------------------------

    let image;

    try {
      image = normalizeImage(body.image);
    } catch (error) {
      return res.status(200).json({
        success: false,
        error:
          error?.message ||
          "Invalid image.",
        version: VERSION,
      });
    }

    const {
      width: imageWidth,
      height: imageHeight,
    } = getImageSize(image);

    // --------------------------------------------------------
    // INPUTS
    // --------------------------------------------------------

    const goal =
      cleanText(body.goal) ||
      "Complete the current Facebook signup flow.";

    const info =
      typeof body.info === "string"
        ? body.info
        : "";

    const rules = Array.isArray(body.rules)
      ? body.rules
      : [];

    const history = Array.isArray(body.history)
      ? body.history
      : [];

    const mode =
      body.mode === "recover"
        ? "recover"
        : "normal";

    const failure =
      body.failure &&
      typeof body.failure === "object"
        ? body.failure
        : null;

    // --------------------------------------------------------
    // PROMPT
    // --------------------------------------------------------

    const prompt = buildPrompt({
      goal,
      info,
      rules,
      history,
      mode,
      failure,
    });

    // --------------------------------------------------------
    // MODEL
    // --------------------------------------------------------

    const model =
      mode === "recover"
        ? RECOVERY_MODEL
        : MODEL_ID;

    // --------------------------------------------------------
    // GEMINI
    // --------------------------------------------------------

    const payload = await askGemini({
      model,
      key,
      image,
      prompt,
    });

    // --------------------------------------------------------
    // TEXT
    // --------------------------------------------------------

    const modelText =
      extractGeminiText(payload);

    // --------------------------------------------------------
    // JSON
    // --------------------------------------------------------

    const rawAction =
      parseModelJSON(modelText);

    // --------------------------------------------------------
    // NORMALIZE
    // --------------------------------------------------------

    const action = normalizeAction(
      rawAction,
      info,
      imageWidth,
      imageHeight
    );

    // --------------------------------------------------------
    // DIAGNOSIS
    //
    // Only useful in recovery mode.
    // --------------------------------------------------------

    const diagnosis =
      mode === "recover"
        ? cleanText(rawAction?.diagnosis)
        : "";

    // --------------------------------------------------------
    // IMPORTANT:
    // If normalizeAction detects invalid plan, return
    // success=false instead of silently executing it.
    // --------------------------------------------------------

    if (action.action === "fail") {
      const reason =
        action.reason ||
        "Invalid AI action.";

      return res.status(200).json({
        success: false,
        action: "fail",
        reason,
        diagnosis,
        mode,
        image_width: imageWidth,
        image_height: imageHeight,
        model,
        version: VERSION,
      });
    }

    // --------------------------------------------------------
    // NORMAL RESPONSE
    // --------------------------------------------------------

    return res.status(200).json({
      success: true,

      action: action.action,

      // tap
      ...(action.x !== undefined
        ? { x: action.x }
        : {}),

      ...(action.y !== undefined
        ? { y: action.y }
        : {}),

      // swipe
      ...(action.x1 !== undefined
        ? { x1: action.x1 }
        : {}),

      ...(action.y1 !== undefined
        ? { y1: action.y1 }
        : {}),

      ...(action.x2 !== undefined
        ? { x2: action.x2 }
        : {}),

      ...(action.y2 !== undefined
        ? { y2: action.y2 }
        : {}),

      ...(action.duration !== undefined
        ? { duration: action.duration }
        : {}),

      // type
      ...(action.text !== undefined
        ? { text: action.text }
        : {}),

      // wait
      ...(action.seconds !== undefined
        ? { seconds: action.seconds }
        : {}),

      // wheel
      ...(action.rows !== undefined
        ? { rows: action.rows }
        : {}),

      // plan
      ...(Array.isArray(action.steps)
        ? { steps: action.steps }
        : {}),

      reason:
        action.reason || "",

      diagnosis,

      mode,

      image_width: imageWidth,
      image_height: imageHeight,

      model,
      version: VERSION,
    });
  } catch (error) {
    // --------------------------------------------------------
    // IMPORTANT:
    // Do not let normal Gemini/API failures crash the Vercel
    // function. Always return JSON to AutoTouch.
    // --------------------------------------------------------

    const model =
      MODEL_ID;

    const message =
      friendlyError(error, model);

    console.error(
      "[ANALYZE ERROR]",
      error?.stack ||
        error?.message ||
        error
    );

    // Fatal configuration/API errors
    if (isFatal(error)) {
      return res.status(200).json({
        success: false,
        action: "fail",
        reason: message,
        error: message,
        mode: "normal",
        model,
        version: VERSION,
      });
    }

    // --------------------------------------------------------
    // TRANSIENT ERROR
    //
    // Tell AutoTouch to wait instead of crashing.
    // --------------------------------------------------------

    return res.status(200).json({
      success: true,
      action: "wait",
      seconds: 3,
      reason: message,
      transient_error: true,
      model,
      version: VERSION,
    });
  }
}
