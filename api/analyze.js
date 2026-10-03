// ============================================================
// pages/api/analyze.js
// AUTOTOUCH VISION AGENT
// VERSION: 6.5 - GEMINI 3.5 FLASH LITE / SAFE FALLBACK FIX
//
// Request:
// {
//   image,
//   key,
//   goal,
//   info,
//   rules[],
//   history[]
// }
//
// Response:
// {
//   success,
//   transient,
//   state,
//   confidence,
//   observations,
//   diagnosis,
//   decision,
//   action,
//   reason
// }
//
// ACTION:
//   tap
//   type
//   swipe
//   wait
//   plan
//   wheel
//   done
//   fail
//
// IMPORTANT:
//   - Chỉ dùng Gemini 3.5 Flash Lite
//   - Không coi "Wait and observe" là AI error
//   - JSON lỗi -> recovery
//   - Recovery vẫn dùng Gemini 3.5 Flash Lite
// ============================================================

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "12mb",
    },
  },
};

// ============================================================
// CONFIG
// ============================================================

const MODEL_NAME = "gemini-3.5-flash-lite";

const GEMINI_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

const MAX_HISTORY = 12;
const MAX_RULES = 30;
const MAX_INFO_LENGTH = 5000;

// ============================================================
// UTIL
// ============================================================

function safeString(value, max = 5000) {
  if (value === null || value === undefined) return "";
  return String(value).slice(0, max);
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, n));
}

function cleanArray(value, max = 20) {
  if (!Array.isArray(value)) return [];

  return value
    .slice(-max)
    .map((x) => safeString(x, 1000))
    .filter(Boolean);
}

function stripCodeFence(text) {
  let s = safeString(text, 30000).trim();

  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?/i, "");
    s = s.replace(/```$/i, "");
  }

  return s.trim();
}

function parseJsonSafe(text) {
  const raw = stripCodeFence(text);

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (_) {}

  // ----------------------------------------------------------
  // Thử lấy object JSON đầu tiên trong response
  // ----------------------------------------------------------

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");

  if (first >= 0 && last > first) {
    const candidate = raw.slice(first, last + 1);

    try {
      return JSON.parse(candidate);
    } catch (_) {}
  }

  return null;
}

// ============================================================
// NORMALIZE ACTION
// ============================================================

function normalizeAction(action) {
  if (!action || typeof action !== "object") {
    return null;
  }

  const type = safeString(action.type, 40).toLowerCase().trim();

  // ----------------------------------------------------------
  // TAP
  // ----------------------------------------------------------

  if (type === "tap" || type === "click") {
    const x = clampNumber(action.x, 0, 10000, NaN);
    const y = clampNumber(action.y, 0, 10000, NaN);

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }

    return {
      type: "tap",
      x: Math.round(x),
      y: Math.round(y),
    };
  }

  // ----------------------------------------------------------
  // TYPE
  // ----------------------------------------------------------

  if (type === "type" || type === "input") {
    if (
      action.text === undefined ||
      action.text === null
    ) {
      return null;
    }

    return {
      type: "type",
      text: String(action.text),
    };
  }

  // ----------------------------------------------------------
  // SWIPE
  // ----------------------------------------------------------

  if (type === "swipe") {
    const x1 = clampNumber(action.x1, 0, 10000, NaN);
    const y1 = clampNumber(action.y1, 0, 10000, NaN);
    const x2 = clampNumber(action.x2, 0, 10000, NaN);
    const y2 = clampNumber(action.y2, 0, 10000, NaN);

    if (
      !Number.isFinite(x1) ||
      !Number.isFinite(y1) ||
      !Number.isFinite(x2) ||
      !Number.isFinite(y2)
    ) {
      return null;
    }

    return {
      type: "swipe",
      x1: Math.round(x1),
      y1: Math.round(y1),
      x2: Math.round(x2),
      y2: Math.round(y2),
      duration: clampNumber(
        action.duration,
        0.1,
        5,
        0.5
      ),
    };
  }

  // ----------------------------------------------------------
  // WAIT
  // ----------------------------------------------------------

  if (type === "wait") {
    let ms = Number(action.ms);

    if (!Number.isFinite(ms)) {
      const seconds = Number(action.seconds);

      if (Number.isFinite(seconds)) {
        ms = seconds * 1000;
      }
    }

    if (!Number.isFinite(ms)) {
      ms = 1200;
    }

    return {
      type: "wait",
      ms: Math.round(
        Math.max(300, Math.min(ms, 5000))
      ),
    };
  }

  // ----------------------------------------------------------
  // DONE
  // ----------------------------------------------------------

  if (
    type === "done" ||
    type === "complete" ||
    type === "completed"
  ) {
    return {
      type: "done",
    };
  }

  // ----------------------------------------------------------
  // FAIL
  // ----------------------------------------------------------

  if (type === "fail" || type === "error") {
    return {
      type: "fail",
      reason: safeString(
        action.reason || action.message,
        500
      ),
    };
  }

  // ----------------------------------------------------------
  // WHEEL
  // ----------------------------------------------------------

  if (type === "wheel") {
    return {
      type: "wheel",
      direction:
        safeString(action.direction || "down", 20)
          .toLowerCase() === "up"
          ? "up"
          : "down",
      amount: clampNumber(
        action.amount,
        1,
        20,
        3
      ),
    };
  }

  // ----------------------------------------------------------
  // PLAN
  // ----------------------------------------------------------

  if (type === "plan") {
    const rawSteps =
      Array.isArray(action.steps)
        ? action.steps
        : Array.isArray(action.plan)
        ? action.plan
        : [];

    const steps = [];

    for (const step of rawSteps.slice(0, 8)) {
      const normalized = normalizeAction(step);

      if (normalized) {
        steps.push(normalized);
      }
    }

    if (!steps.length) {
      return null;
    }

    return {
      type: "plan",
      steps,
    };
  }

  return null;
}

// ============================================================
// NORMALIZE MODEL RESPONSE
// ============================================================

function normalizeModelResponse(data) {
  if (!data || typeof data !== "object") {
    return null;
  }

  let action = normalizeAction(data.action);

  // ----------------------------------------------------------
  // Một số model có thể trả decision thay vì action
  // ----------------------------------------------------------

  if (!action && data.decision) {
    const decision =
      safeString(data.decision, 200)
        .toLowerCase()
        .trim();

    if (
      decision.includes("wait") ||
      decision.includes("observe") ||
      decision.includes("chờ") ||
      decision.includes("quan sát")
    ) {
      action = {
        type: "wait",
        ms: 1200,
      };
    }
  }

  // ----------------------------------------------------------
  // Nếu không có action thì không coi là lỗi server.
  // Cho AutoTouch wait rồi chụp lại.
  // ----------------------------------------------------------

  if (!action) {
    action = {
      type: "wait",
      ms: 1200,
    };
  }

  const confidence = clampNumber(
    data.confidence,
    0,
    1,
    0.5
  );

  let state =
    safeString(data.state, 80)
      .toLowerCase()
      .trim();

  if (!state) {
    state = "observed";
  }

  let decision =
    safeString(data.decision, 300);

  if (!decision) {
    decision =
      action.type === "wait"
        ? "Wait and observe"
        : `Execute ${action.type}`;
  }

  const observations = cleanArray(
    data.observations,
    12
  );

  const diagnosis =
    safeString(
      data.diagnosis || data.reason,
      1000
    );

  return {
    success: true,
    transient: false,
    state,
    confidence,
    observations,
    diagnosis:
      diagnosis || "Vision analysis completed.",
    decision,
    action,
    reason:
      safeString(
        data.reason || decision,
        1000
      ),
  };
}

// ============================================================
// FALLBACK
// ============================================================

function waitResponse(reason = "Wait and observe.") {
  return {
    success: true,
    transient: false,
    state: "waiting",
    confidence: 0.2,
    observations: [],
    diagnosis: reason,
    decision: "Wait and observe",
    action: {
      type: "wait",
      ms: 1200,
    },
    reason,
  };
}

// ============================================================
// ERROR RESPONSE
// ============================================================

function transientError(message) {
  return {
    success: false,
    transient: true,
    state: "server_error",
    confidence: 0,
    observations: [],
    diagnosis: safeString(message, 1000),
    decision: "Retry",
    action: {
      type: "wait",
      ms: 1500,
    },
    reason: safeString(message, 1000),
  };
}

// ============================================================
// IMAGE NORMALIZATION
// ============================================================

function normalizeImage(image) {
  if (!image) {
    return null;
  }

  let value = String(image).trim();

  // ----------------------------------------------------------
  // data:image/jpeg;base64,...
  // ----------------------------------------------------------

  if (value.startsWith("data:image/")) {
    const comma = value.indexOf(",");

    if (comma >= 0) {
      const header = value.slice(0, comma);
      const data = value.slice(comma + 1);

      let mimeType = "image/jpeg";

      const match =
        header.match(
          /^data:(image\/[a-zA-Z0-9.+-]+);base64$/i
        );

      if (match) {
        mimeType = match[1];
      }

      return {
        mimeType,
        data,
      };
    }
  }

  // ----------------------------------------------------------
  // Nếu client gửi raw base64
  // ----------------------------------------------------------

  return {
    mimeType: "image/jpeg",
    data: value,
  };
}

// ============================================================
// GEMINI CALL
// ============================================================

async function callGemini({
  apiKey,
  image,
  systemInstruction,
  prompt,
}) {
  const imageData = normalizeImage(image);

  if (!imageData || !imageData.data) {
    throw new Error("Missing image data.");
  }

  const url =
    `${GEMINI_API_BASE}/${MODEL_NAME}:generateContent` +
    `?key=${encodeURIComponent(apiKey)}`;

  const body = {
    systemInstruction: {
      parts: [
        {
          text: systemInstruction,
        },
      ],
    },

    contents: [
      {
        role: "user",
        parts: [
          {
            inline_data: {
              mime_type: imageData.mimeType,
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
      temperature: 0.1,
      topP: 0.8,
      maxOutputTokens: 1800,
      responseMimeType: "application/json",
    },
  };

  const controller =
    new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 30000);

  let response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();

  if (!response.ok) {
    let detail = text;

    try {
      const json = JSON.parse(text);

      detail =
        json?.error?.message ||
        json?.error ||
        text;
    } catch (_) {}

    throw new Error(
      `Gemini HTTP ${response.status}: ${safeString(
        detail,
        1200
      )}`
    );
  }

  let json;

  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error(
      "Gemini returned invalid HTTP JSON."
    );
  }

  const candidate =
    json?.candidates?.[0];

  const parts =
    candidate?.content?.parts || [];

  let output = "";

  for (const part of parts) {
    if (part && typeof part.text === "string") {
      output += part.text;
    }
  }

  if (!output.trim()) {
    throw new Error(
      "Gemini returned an empty response."
    );
  }

  const parsed =
    parseJsonSafe(output);

  if (!parsed) {
    throw new Error(
      "Gemini returned invalid action JSON."
    );
  }

  return parsed;
}

// ============================================================
// SYSTEM PROMPT
// ============================================================

function buildSystemInstruction() {
  return `
You are the vision controller for an AutoTouch UI agent.

MODEL:
Gemini 3.5 Flash Lite.

YOUR JOB:
Look at the supplied screenshot and choose exactly ONE next action.

IMPORTANT:
The screenshot is the source of truth.

DO NOT invent UI elements.

DO NOT describe what the user should manually do.

RETURN JSON ONLY.

VALID ACTIONS:

1. tap
{
  "type": "tap",
  "x": 123,
  "y": 456
}

2. type
{
  "type": "type",
  "text": "..."
}

3. swipe
{
  "type": "swipe",
  "x1": 100,
  "y1": 700,
  "x2": 100,
  "y2": 300,
  "duration": 0.5
}

4. wait
{
  "type": "wait",
  "ms": 1200
}

5. wheel
{
  "type": "wheel",
  "direction": "down",
  "amount": 3
}

6. plan
{
  "type": "plan",
  "steps": [
    {
      "type": "tap",
      "x": 100,
      "y": 200
    },
    {
      "type": "type",
      "text": "..."
    }
  ]
}

7. done
{
  "type": "done"
}

8. fail
{
  "type": "fail",
  "reason": "..."
}

RESPONSE FORMAT:

{
  "state": "string",
  "confidence": 0.0,
  "observations": ["..."],
  "diagnosis": "...",
  "decision": "...",
  "action": {
    ...
  },
  "reason": "..."
}

IMPORTANT UI RULES:

- If a button is clearly visible and it is the next logical step, TAP IT.
- Do not return "unknown" merely because the screen is unfamiliar.
- Do not return an empty observations array if visible UI elements can be identified.
- If the screenshot is clear but you are not completely certain, choose the safest visible next action.
- Only use wait when there genuinely is no safe visible action.
- If the screen is loading, use wait.
- If a keyboard is visible and the next field is clearly active, use the appropriate type action.
- Do not tap random areas.
- Prefer the center of a clearly visible button.
- Do not create coordinates outside the screenshot.
- Never expose or repeat secrets in observations, diagnosis, or reason.

PASSWORD RULE:

The client controls password entry.

The password must be entered only ONCE during the whole session.

If history says the password was already entered:
- NEVER return a type action containing that password.
- NEVER ask the client to type it again.
- Even if a password field looks visually empty because it is masked, assume the password may already have been entered.
- Choose the next non-password action or wait for the UI to update.

CONFIRM PASSWORD:

The client has an explicit single-entry password policy.
Do not force a second password type action merely because a confirmation field appears visually empty.

VERY IMPORTANT:

If the screenshot clearly shows a button such as:
"Bắt đầu"
"Tiếp"
"Tiếp tục"
"Đăng ký"
"Xác nhận"
"Tiếp theo"

and it is obviously the next step, return a tap action.

Do not return:
"Safe fallback required"
when a visible safe action exists.
`;
}

// ============================================================
// USER PROMPT
// ============================================================

function buildUserPrompt({
  goal,
  info,
  rules,
  history,
  recovery = false,
}) {
  const safeRules = cleanArray(
    rules,
    MAX_RULES
  );

  const safeHistory = cleanArray(
    history,
    MAX_HISTORY
  );

  const safeInfo = safeString(
    info,
    MAX_INFO_LENGTH
  );

  return `
GOAL:
${safeString(goal, 1000)}

INFO:
${safeInfo}

RULES:
${safeRules.map((x, i) => `${i + 1}. ${x}`).join("\n")}

RECENT HISTORY:
${
  safeHistory.length
    ? safeHistory
        .map((x, i) => `${i + 1}. ${x}`)
        .join("\n")
    : "(none)"
}

${
  recovery
    ? `
RECOVERY ANALYSIS:

The previous vision response was missing, invalid, or too conservative.

Re-examine the screenshot carefully.

Look specifically for:
- visible buttons
- active input fields
- keyboard
- loading indicators
- navigation controls
- "Bắt đầu"
- "Tiếp"
- "Tiếp tục"
- "Đăng ký"
- "Xác nhận"
- "Tiếp theo"

If a clear safe UI action exists, return that action instead of wait.

Do not return an empty action.
`
    : ""
}

Return exactly one JSON object.
`;
}

// ============================================================
// MAIN HANDLER
// ============================================================

export default async function handler(req, res) {
  // ----------------------------------------------------------
  // CORS
  // ----------------------------------------------------------

  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      transient: false,
      error: "POST only",
    });
  }

  try {
    const body = req.body || {};

    // --------------------------------------------------------
    // API KEY
    //
    // Ưu tiên:
    //   1. body.key
    //   2. GEMINI_API_KEY
    //
    // --------------------------------------------------------

    const apiKey =
      safeString(
        body.key ||
        process.env.GEMINI_API_KEY,
        500
      ).trim();

    if (!apiKey) {
      return res.status(500).json(
        transientError(
          "Gemini API key is missing."
        )
      );
    }

    // --------------------------------------------------------
    // INPUT
    // --------------------------------------------------------

    const image = body.image;

    if (!image) {
      return res.status(400).json(
        transientError(
          "Image is missing."
        )
      );
    }

    const goal =
      safeString(
        body.goal,
        1000
      ) ||
      "Hoàn thành màn hình hiện tại và chuyển sang bước tiếp theo.";

    const info =
      safeString(
        body.info,
        MAX_INFO_LENGTH
      );

    const rules =
      Array.isArray(body.rules)
        ? body.rules
        : [];

    const history =
      Array.isArray(body.history)
        ? body.history
        : [];

    // --------------------------------------------------------
    // SYSTEM + PROMPT
    // --------------------------------------------------------

    const systemInstruction =
      buildSystemInstruction();

    const prompt =
      buildUserPrompt({
        goal,
        info,
        rules,
        history,
        recovery: false,
      });

    // --------------------------------------------------------
    // PRIMARY GEMINI
    // --------------------------------------------------------

    let rawResult = null;

    try {
      rawResult = await callGemini({
        apiKey,
        image,
        systemInstruction,
        prompt,
      });
    } catch (primaryError) {
      // ------------------------------------------------------
      // Không chết ngay.
      // Recovery bằng cùng Gemini 3.5 Flash Lite.
      // ------------------------------------------------------

      try {
        rawResult = await callGemini({
          apiKey,
          image,
          systemInstruction,
          prompt: buildUserPrompt({
            goal,
            info,
            rules,
            history,
            recovery: true,
          }),
        });
      } catch (recoveryError) {
        return res.status(200).json(
          waitResponse(
            "Vision service temporarily unavailable. Retry with a new screenshot."
          )
        );
      }
    }

    // --------------------------------------------------------
    // NORMALIZE
    // --------------------------------------------------------

    const result =
      normalizeModelResponse(
        rawResult
      );

    // --------------------------------------------------------
    // Nếu model response không chuẩn:
    // KHÔNG trả success:false.
    //
    // Đây chính là phần sửa lỗi trong ảnh.
    // --------------------------------------------------------

    if (!result) {
      return res.status(200).json(
        waitResponse(
          "Vision result was incomplete. Rechecking the current screen."
        )
      );
    }

    // --------------------------------------------------------
    // FORCE SAFE WAIT TO BE SUCCESSFUL
    // --------------------------------------------------------

    if (
      result.action &&
      result.action.type === "wait"
    ) {
      result.success = true;
      result.transient = false;

      if (!result.state) {
        result.state = "waiting";
      }

      if (!result.decision) {
        result.decision =
          "Wait and observe";
      }
    }

    // --------------------------------------------------------
    // DONE
    // --------------------------------------------------------

    if (
      result.action &&
      result.action.type === "done"
    ) {
      result.success = true;
      result.transient = false;
      result.state = "done";
      result.decision = "Completed";

      return res.status(200).json(
        result
      );
    }

    // --------------------------------------------------------
    // FAIL DO AI CHỌN
    // --------------------------------------------------------

    if (
      result.action &&
      result.action.type === "fail"
    ) {
      result.success = true;
      result.transient = false;
      result.state = "failed";

      return res.status(200).json(
        result
      );
    }

    // --------------------------------------------------------
    // NORMAL ACTION
    // --------------------------------------------------------

    result.success = true;
    result.transient = false;

    return res.status(200).json(
      result
    );

  } catch (error) {
    // --------------------------------------------------------
    // Tuyệt đối không làm API chết chỉ vì exception.
    // --------------------------------------------------------

    console.error(
      "[ANALYZE ERROR]",
      error?.message || error
    );

    return res.status(200).json(
      waitResponse(
        "Temporary analysis error. Taking another screenshot."
      )
    );
  }
}
