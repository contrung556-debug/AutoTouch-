// ============================================================
// VERCEL API - /api/analyze.js
// AUTOTOUCH VISION AGENT
//
// MODEL:
//   Gemini 3.5 Flash-Lite
//
// MODEL ID:
//   gemini-3.5-flash-lite
//
// Input:
//   {
//     image: "data:image/png;base64,...",
//     key: "GEMINI_API_KEY",
//     goal: "...",
//     info: {...},
//     rules: "...",
//     history: [...]
//   }
//
// Output:
//   {
//     ok: true,
//     model: "gemini-3.5-flash-lite",
//     action: "tap",
//     ...
//   }
//
// Supported actions:
//   tap
//   swipe
//   type
//   wait
//   done
//   plan
//
// ============================================================

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "4.5mb",
    },
  },
};

// ============================================================
// HARD LOCK MODEL
// ============================================================

const MODEL_ID = "gemini-3.5-flash-lite";

const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent`;

// ============================================================
// LIMITS
// ============================================================

const MAX_HISTORY = 20;
const MAX_RULES_LENGTH = 30000;
const MAX_INFO_LENGTH = 12000;

// ============================================================
// SAFE HELPERS
// ============================================================

function safeString(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }

  return String(value);
}

function safeJson(value, fallback = {}) {
  if (value === undefined || value === null) {
    return fallback;
  }

  return value;
}

function trimText(value, maxLength) {
  const text = safeString(value);

  if (text.length <= maxLength) {
    return text;
  }

  return text.slice(0, maxLength);
}

// ============================================================
// NORMALIZE IMAGE
// ============================================================

function normalizeImage(image) {
  if (!image) {
    return null;
  }

  const value = safeString(image).trim();

  if (!value) {
    return null;
  }

  // Already data URL
  if (value.startsWith("data:image/")) {
    const comma = value.indexOf(",");

    if (comma === -1) {
      return null;
    }

    const header = value.slice(0, comma);
    const base64 = value.slice(comma + 1);

    if (!base64) {
      return null;
    }

    let mimeType = "image/png";

    const match = header.match(/^data:([^;]+);base64$/i);

    if (match && match[1]) {
      mimeType = match[1];
    }

    return {
      mimeType,
      data: base64,
    };
  }

  // Raw base64
  return {
    mimeType: "image/png",
    data: value,
  };
}

// ============================================================
// CLEAN GEMINI RESPONSE
// ============================================================

function stripCodeFence(text) {
  let value = safeString(text).trim();

  if (!value) {
    return "";
  }

  if (value.startsWith("```")) {
    value = value.replace(/^```(?:json)?/i, "");
    value = value.replace(/```$/i, "");
    value = value.trim();
  }

  return value;
}

// ============================================================
// FIND JSON INSIDE TEXT
// ============================================================

function extractJson(text) {
  const cleaned = stripCodeFence(text);

  if (!cleaned) {
    return null;
  }

  // Direct JSON
  try {
    return JSON.parse(cleaned);
  } catch (_) {}

  // Find object
  const firstObject = cleaned.indexOf("{");
  const lastObject = cleaned.lastIndexOf("}");

  if (
    firstObject !== -1 &&
    lastObject !== -1 &&
    lastObject > firstObject
  ) {
    const candidate = cleaned.slice(firstObject, lastObject + 1);

    try {
      return JSON.parse(candidate);
    } catch (_) {}
  }

  // Find array
  const firstArray = cleaned.indexOf("[");
  const lastArray = cleaned.lastIndexOf("]");

  if (
    firstArray !== -1 &&
    lastArray !== -1 &&
    lastArray > firstArray
  ) {
    const candidate = cleaned.slice(firstArray, lastArray + 1);

    try {
      return JSON.parse(candidate);
    } catch (_) {}
  }

  return null;
}

// ============================================================
// NORMALIZE ACTION
// ============================================================

function normalizeAction(result) {
  if (!result || typeof result !== "object") {
    return {
      action: "wait",
      ms: 1000,
      reason: "Invalid model result",
    };
  }

  let action = safeString(result.action).toLowerCase().trim();

  // Some models may return type/action_type
  if (!action && result.action_type) {
    action = safeString(result.action_type).toLowerCase().trim();
  }

  if (!action) {
    action = "wait";
  }

  // ----------------------------------------------------------
  // TAP
  // ----------------------------------------------------------

  if (action === "tap") {
    const x = Number(result.x);
    const y = Number(result.y);

    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      return {
        action: "wait",
        ms: 800,
        reason: "Invalid tap coordinates",
      };
    }

    return {
      action: "tap",
      x,
      y,
      reason: safeString(result.reason),
    };
  }

  // ----------------------------------------------------------
  // SWIPE
  // ----------------------------------------------------------

  if (action === "swipe") {
    const x1 = Number(result.x1);
    const y1 = Number(result.y1);
    const x2 = Number(result.x2);
    const y2 = Number(result.y2);

    if (
      !Number.isFinite(x1) ||
      !Number.isFinite(y1) ||
      !Number.isFinite(x2) ||
      !Number.isFinite(y2)
    ) {
      return {
        action: "wait",
        ms: 800,
        reason: "Invalid swipe coordinates",
      };
    }

    let duration = Number(result.duration);

    if (!Number.isFinite(duration)) {
      duration = 450;
    }

    duration = Math.max(100, Math.min(duration, 2000));

    return {
      action: "swipe",
      x1,
      y1,
      x2,
      y2,
      duration,
      reason: safeString(result.reason),
    };
  }

  // ----------------------------------------------------------
  // TYPE
  // ----------------------------------------------------------

  if (action === "type") {
    const text = safeString(result.text);

    if (!text) {
      return {
        action: "wait",
        ms: 800,
        reason: "Empty type text",
      };
    }

    return {
      action: "type",
      text,
      field: safeString(result.field),
      reason: safeString(result.reason),
    };
  }

  // ----------------------------------------------------------
  // WAIT
  // ----------------------------------------------------------

  if (action === "wait") {
    let ms = Number(result.ms);

    if (!Number.isFinite(ms)) {
      ms = 800;
    }

    ms = Math.max(200, Math.min(ms, 5000));

    return {
      action: "wait",
      ms,
      reason: safeString(result.reason),
    };
  }

  // ----------------------------------------------------------
  // DONE
  // ----------------------------------------------------------

  if (action === "done") {
    return {
      action: "done",
      reason: safeString(result.reason),
    };
  }

  // ----------------------------------------------------------
  // PLAN
  // ----------------------------------------------------------

  if (action === "plan") {
    let steps = [];

    if (Array.isArray(result.steps)) {
      steps = result.steps;
    }

    if (!steps.length) {
      return {
        action: "wait",
        ms: 800,
        reason: "Empty plan",
      };
    }

    steps = steps
      .slice(0, 8)
      .map((step) => normalizePlanStep(step))
      .filter(Boolean);

    if (!steps.length) {
      return {
        action: "wait",
        ms: 800,
        reason: "Invalid plan",
      };
    }

    return {
      action: "plan",
      steps,
      reason: safeString(result.reason),
    };
  }

  // Unknown action
  return {
    action: "wait",
    ms: 800,
    reason: `Unknown action: ${action}`,
  };
}

// ============================================================
// PLAN STEP
// ============================================================

function normalizePlanStep(step) {
  if (!step || typeof step !== "object") {
    return null;
  }

  const action = safeString(step.action)
    .toLowerCase()
    .trim();

  if (action === "tap") {
    const x = Number(step.x);
    const y = Number(step.y);

    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      return null;
    }

    return {
      action: "tap",
      x,
      y,
      reason: safeString(step.reason),
    };
  }

  if (action === "swipe") {
    const x1 = Number(step.x1);
    const y1 = Number(step.y1);
    const x2 = Number(step.x2);
    const y2 = Number(step.y2);

    if (
      !Number.isFinite(x1) ||
      !Number.isFinite(y1) ||
      !Number.isFinite(x2) ||
      !Number.isFinite(y2)
    ) {
      return null;
    }

    let duration = Number(step.duration);

    if (!Number.isFinite(duration)) {
      duration = 450;
    }

    return {
      action: "swipe",
      x1,
      y1,
      x2,
      y2,
      duration: Math.max(
        100,
        Math.min(duration, 2000)
      ),
      reason: safeString(step.reason),
    };
  }

  if (action === "type") {
    const text = safeString(step.text);

    if (!text) {
      return null;
    }

    return {
      action: "type",
      text,
      field: safeString(step.field),
      reason: safeString(step.reason),
    };
  }

  if (action === "wait") {
    let ms = Number(step.ms);

    if (!Number.isFinite(ms)) {
      ms = 800;
    }

    return {
      action: "wait",
      ms: Math.max(
        200,
        Math.min(ms, 5000)
      ),
      reason: safeString(step.reason),
    };
  }

  if (action === "done") {
    return {
      action: "done",
      reason: safeString(step.reason),
    };
  }

  return null;
}

// ============================================================
// BUILD INFO
// ============================================================

function buildInfo(info) {
  if (!info) {
    return "{}";
  }

  try {
    return trimText(
      JSON.stringify(info, null, 2),
      MAX_INFO_LENGTH
    );
  } catch (_) {
    return safeString(info);
  }
}

// ============================================================
// BUILD HISTORY
// ============================================================

function buildHistory(history) {
  if (!Array.isArray(history)) {
    return "[]";
  }

  const sliced = history.slice(-MAX_HISTORY);

  try {
    return JSON.stringify(sliced, null, 2);
  } catch (_) {
    return "[]";
  }
}

// ============================================================
// MAIN VISION PROMPT
// ============================================================

function buildPrompt({
  goal,
  info,
  rules,
  history,
}) {
  const safeGoal = trimText(
    safeString(goal),
    4000
  );

  const safeRules = trimText(
    safeString(rules),
    MAX_RULES_LENGTH
  );

  const safeInfo = buildInfo(info);

  const safeHistory = buildHistory(history);

  return `
You are a STRICT mobile UI vision agent.

Your job is to inspect the CURRENT SCREENSHOT and return the
NEXT SAFE UI ACTION for an AutoTouch automation agent.

============================================================
PRIMARY GOAL
============================================================

${safeGoal}

============================================================
KNOWN DATA
============================================================

${safeInfo}

============================================================
RULES
============================================================

${safeRules}

============================================================
RECENT ACTION HISTORY
============================================================

${safeHistory}

============================================================
CORE OPERATING RULES
============================================================

1. Analyze ONLY the current screenshot and the supplied context.

2. Never invent a UI element that cannot be reasonably located
   in the screenshot.

3. Coordinates must refer to the actual screenshot coordinate
   system.

4. Prefer one small action at a time.

5. Do not perform unnecessary taps.

6. If a screen is still loading, use:
   {
     "action": "wait",
     "ms": 800
   }

7. If a button is showing a spinner/loading indicator instead
   of its normal label, do NOT treat the spinner as the target.

8. Do NOT click a button that is clearly disabled.

9. Do NOT click the same submit/continue button again while it
   is visibly loading.

10. If an input already contains the required value, do NOT
    type it again.

11. If an input already contains part of the required value,
    do not blindly duplicate the value.

12. Never clear or overwrite an input unless the current UI
    clearly requires it.

13. When entering a password, use the exact password supplied
    in KNOWN DATA.

14. Never invent a password.

15. Never invent a phone number.

16. Never invent a first name or last name.

17. If a value is not known and cannot be safely inferred,
    do not fabricate it.

18. If the target field is hidden by the keyboard, use a safe
    UI action such as swipe/wait only when necessary.

19. If a date picker is visible, reason from the actual picker
    shown on screen.

20. If a wheel date picker is visible, use swipe actions on the
    actual wheel rather than guessing.

21. If a QWERTY keyboard is visible, do not confuse keyboard
    keys with form buttons.

22. If a numeric keypad is visible, do not confuse keypad keys
    with form buttons.

23. If the current screen already satisfies the goal, return:

    {
      "action": "done",
      "reason": "..."
    }

24. If a single action is sufficient, return a single action.

25. Use PLAN only when several immediately consecutive actions
    are clearly required and each step is directly supported
    by the screenshot/context.

26. Do not return markdown.

27. Do not return explanations outside JSON.

============================================================
ALLOWED OUTPUT ACTIONS
============================================================

TAP:

{
  "action": "tap",
  "x": 123,
  "y": 456,
  "reason": "..."
}

SWIPE:

{
  "action": "swipe",
  "x1": 200,
  "y1": 700,
  "x2": 200,
  "y2": 300,
  "duration": 450,
  "reason": "..."
}

TYPE:

{
  "action": "type",
  "field": "first_name",
  "text": "Nguyen",
  "reason": "..."
}

WAIT:

{
  "action": "wait",
  "ms": 800,
  "reason": "..."
}

DONE:

{
  "action": "done",
  "reason": "..."
}

PLAN:

{
  "action": "plan",
  "steps": [
    {
      "action": "tap",
      "x": 123,
      "y": 456
    },
    {
      "action": "type",
      "field": "first_name",
      "text": "Nguyen"
    }
  ],
  "reason": "..."
}

============================================================
IMPORTANT
============================================================

Return EXACTLY ONE valid JSON object.

No markdown.
No code fence.
No commentary.
`.trim();
}

// ============================================================
// GEMINI REQUEST
// ============================================================

async function callGemini({
  apiKey,
  image,
  prompt,
}) {
  const imageData = normalizeImage(image);

  if (!imageData) {
    throw new Error("Invalid or missing image");
  }

  const payload = {
    systemInstruction: {
      parts: [
        {
          text:
            "You are a strict mobile UI automation vision agent. " +
            "Return valid JSON only."
        },
      ],
    },

    contents: [
      {
        role: "user",
        parts: [
          {
            text: prompt,
          },
          {
            inlineData: {
              mimeType: imageData.mimeType,
              data: imageData.data,
            },
          },
        ],
      },
    ],

    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",

        properties: {
          action: {
            type: "STRING",
            enum: [
              "tap",
              "swipe",
              "type",
              "wait",
              "done",
              "plan",
            ],
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

          ms: {
            type: "NUMBER",
          },

          field: {
            type: "STRING",
          },

          text: {
            type: "STRING",
          },

          reason: {
            type: "STRING",
          },

          steps: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                action: {
                  type: "STRING",
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
                ms: {
                  type: "NUMBER",
                },
                field: {
                  type: "STRING",
                },
                text: {
                  type: "STRING",
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
        "x-goog-api-key": apiKey,
      },

      body: JSON.stringify(payload),
    }
  );

  const rawText = await response.text();

  let data;

  try {
    data = JSON.parse(rawText);
  } catch (_) {
    throw new Error(
      `Gemini returned non-JSON HTTP ${response.status}: ` +
      rawText.slice(0, 1000)
    );
  }

  if (!response.ok) {
    let message =
      data?.error?.message ||
      data?.error?.status ||
      `Gemini HTTP ${response.status}`;

    throw new Error(message);
  }

  const candidates = data?.candidates;

  if (
    !Array.isArray(candidates) ||
    !candidates.length
  ) {
    throw new Error(
      "Gemini returned no candidates"
    );
  }

  const parts =
    candidates[0]?.content?.parts || [];

  let modelText = "";

  for (const part of parts) {
    if (
      part &&
      typeof part.text === "string"
    ) {
      modelText += part.text;
    }
  }

  modelText = modelText.trim();

  if (!modelText) {
    throw new Error(
      "Gemini returned empty text"
    );
  }

  const parsed = extractJson(modelText);

  if (!parsed) {
    throw new Error(
      "Gemini returned invalid JSON: " +
      modelText.slice(0, 1000)
    );
  }

  return parsed;
}

// ============================================================
// FALLBACK
// ============================================================

function fallbackAction(reason) {
  return {
    ok: true,
    model: MODEL_ID,

    action: "wait",

    ms: 800,

    reason:
      reason ||
      "Fallback wait",
  };
}

// ============================================================
// METHOD CHECK
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
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  // ----------------------------------------------------------
  // BODY
  // ----------------------------------------------------------

  const body =
    req.body && typeof req.body === "object"
      ? req.body
      : {};

  const {
    image,
    key,
    goal,
    info,
    rules,
    history,
  } = body;

  // ----------------------------------------------------------
  // API KEY
  // ----------------------------------------------------------

  const apiKey = safeString(key).trim();

  if (!apiKey) {
    return res.status(400).json({
      ok: false,
      error:
        "Missing Gemini API key. " +
        "AutoTouch must send body.key.",
      model: MODEL_ID,
    });
  }

  // ----------------------------------------------------------
  // IMAGE
  // ----------------------------------------------------------

  if (!image) {
    return res.status(400).json({
      ok: false,
      error: "Missing screenshot image.",
      model: MODEL_ID,
    });
  }

  // ----------------------------------------------------------
  // PROMPT
  // ----------------------------------------------------------

  const prompt = buildPrompt({
    goal,
    info,
    rules,
    history,
  });

  // ----------------------------------------------------------
  // CALL GEMINI
  // ----------------------------------------------------------

  try {
    const result = await callGemini({
      apiKey,
      image,
      prompt,
    });

    const action = normalizeAction(result);

    return res.status(200).json({
      ok: true,

      // Hard locked
      model: MODEL_ID,

      action: action.action,

      // Keep all action fields
      ...action,

      // Server metadata
      server: "autotouch-vision",
      version: "3.5-flash-lite-v1",
    });

  } catch (error) {
    const message =
      error?.message ||
      "Unknown Gemini error";

    console.error(
      "[AUTOTOUCH GEMINI ERROR]",
      message
    );

    // --------------------------------------------------------
    // AUTH / API ERROR
    // --------------------------------------------------------

    if (
      message.includes("API key") ||
      message.includes("INVALID_ARGUMENT") ||
      message.includes("PERMISSION_DENIED") ||
      message.includes("UNAUTHENTICATED")
    ) {
      return res.status(401).json({
        ok: false,

        model: MODEL_ID,

        error:
          "Gemini API authentication/model error.",

        detail: message,
      });
    }

    // --------------------------------------------------------
    // QUOTA
    // --------------------------------------------------------

    if (
      message.includes("RESOURCE_EXHAUSTED") ||
      message.includes("quota") ||
      message.includes("429")
    ) {
      return res.status(429).json({
        ok: false,

        model: MODEL_ID,

        error:
          "Gemini quota/rate limit reached.",

        detail: message,
      });
    }

    // --------------------------------------------------------
    // OTHER ERROR
    // --------------------------------------------------------

    return res.status(200).json(
      fallbackAction(message)
    );
  }
}
