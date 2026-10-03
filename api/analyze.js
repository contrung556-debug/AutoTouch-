// ============================================================
// pages/api/analyze.js
// AUTOTOUCH VISION AGENT - BRAIN 6.4
//
// Hợp đồng với client AutoTouch (giữ nguyên như 6.3):
//   - action luôn là string ở cấp trên cùng
//   - tap:   x, y (pixel)
//   - type:  text
//   - wait:  ms + wait (cả hai)
//   - swipe: start/end + x1,y1,x2,y2 (pixel)
//   - wheel: x, y (pixel), rows (0..1000, KHÔNG đổi sang pixel)
//   - plan:  steps (tap pixel / type)
//
// Thay đổi so với 6.3:
//   - Tọa độ thiếu => null => validation bắt được (không còn tap 0,0).
//   - Kiểm tra INFO theo GIÁ TRỊ (không phải JSON), chuẩn hóa NFC,
//     gõ lại đúng giá trị gốc của INFO.
//   - Loop guard: giới hạn restart/launch luôn áp dụng; ngưỡng wait
//     riêng cho incoming_call / loading, chỉ áp cho action wait.
//   - Cho phép nhập lại mật khẩu khi Gemini báo state = "error".
//   - Ngân sách thời gian tổng cho các lần gọi Gemini.
//   - Tùy chọn khóa bí mật: đặt ANALYZE_SECRET và gửi header x-api-secret.
// ============================================================

import crypto from "crypto";

// ============================================================
// CONFIG
// ============================================================

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "4.5mb",
    },
  },
};

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const RECOVERY_MODEL = process.env.GEMINI_RECOVERY_MODEL || DEFAULT_MODEL;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const ANALYZE_SECRET = process.env.ANALYZE_SECRET || "";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const ATTEMPTS = 2;
const TIMEOUT_MS = 22000;
// Tổng thời gian tối đa cho mọi lần gọi Gemini (chỉnh theo giới hạn hosting).
const TOTAL_BUDGET_MS = Number(process.env.ANALYZE_BUDGET_MS) || 50000;
const MIN_RETRY_MS = 5000;

const MAX_PLAN_STEPS = 6;
const MAX_WHEEL_ROWS = 40;
const MAX_HISTORY = 30;
const MAX_OBSERVATIONS = 8;

const MAX_CONSECUTIVE_WAITS = 5;
const MAX_LOADING_WAITS = 12;
const MAX_CALL_WAITS = 20;
const MAX_RESTARTS = 2;
const MAX_LAUNCHES = 3;

const MIN_CONFIDENCE = 0.45;

const ACTIONS = [
  "tap", "swipe", "type", "wait", "wheel",
  "plan", "launch", "restart", "done", "fail",
];

const PLAN_ACTIONS = ["tap", "type"];

const STATES = [
  "welcome", "create_account", "login", "meta", "name", "birthday",
  "phone", "password", "captcha", "otp", "verification", "overlay",
  "incoming_call", "external_app", "home_screen", "loading", "error",
  "device_lock", "stuck", "success", "home", "unknown",
];

// ============================================================
// SYSTEM RULES
// ============================================================

const SYSTEM_RULES = `
You are the reasoning brain of an iOS visual automation agent.

Your job is to understand the current screenshot and choose the safest
useful next action. The automation is CLOSED LOOP:
OBSERVE -> UNDERSTAND -> DIAGNOSE -> DECIDE -> ACT -> VERIFY -> OBSERVE AGAIN

LANGUAGE
- The target app may be Vietnamese, English, Chinese, Korean, Japanese or other.
- Read the real UI text from the screenshot. Do not assume English.
- Never translate or transliterate user data. If INFO has familyName "Phạm"
  and givenName "Thu Hà", type exactly "Phạm" and "Thu Hà", never "Pham"/"Thu Ha".

VISUAL REASONING
- The screenshot is the primary source of truth.
- Consider text, buttons, fields, keyboard, dialogs, overlays, navigation,
  loading indicators, errors, selected controls, and whether the previous
  action worked or the goal is already complete.
- Do not rely only on keywords or fixed coordinates.

COORDINATES
- Output coordinates in normalized 0..1000 space (0,0 top-left; 1000,1000 bottom-right).
- Never output pixel coordinates.
- ALWAYS include x and y for tap; never omit them.
- wheel.rows stay normalized 0..1000.

SCREEN CHANGES
- Coordinates are valid only for the screenshot they came from.
- If the UI changed, discard old coordinates and observe again.

INTERRUPTIONS
- Incoming call: do NOT answer or reject automatically. Wait.
- Another app visible, or Home Screen: use launch to recover the target app.
- Overlay blocking the UI: interact only if its purpose is visually clear, else wait.

LOADING
- If loading, wait. Long loading can be normal. Only use stuck/fail after
  repeated identical observations and enough evidence.

UNKNOWN SCREENS
- Unknown does not mean failure. Use screenshot, goal, INFO, rules, history
  and the previous action to choose the safest next step. When confidence
  is low, prefer wait.

ACTION LIFECYCLE
- History statuses: proposed, executed, verified, failed, unknown.
- proposed != executed != verified. Only verified proves completion.
- A plan is only a proposal. Never assume plan = executed/submitted/verified.

PASSWORD
- Must exactly match INFO. Never invent, translate or modify it.
- Do not enter it again after it was VERIFIED, unless the screen shows the
  app rejected it (then report state "error").
- An empty password field after submission does not mean it failed.
  Use history + screenshot + expected result.

NAME
- Name values must come exactly from INFO. Family/given name may appear in
  either field order; use the screenshot to decide.

PLANS
- Use a plan only for several immediate operations on the SAME stable screen.
- Never plan across an unknown future screen. If navigation is expected,
  act once and observe again.

GOAL
- Always make progress toward GOAL. No unnecessary actions. No restart
  without evidence. Do not fail merely because wording differs.

OUTPUT
Return ONLY valid JSON with:
{
  "state": "...",
  "confidence": 0.0,
  "observations": [],
  "diagnosis": "...",
  "decision": "...",
  "expected_result": "...",
  "action": "tap|swipe|type|wait|wheel|plan|launch|restart|done|fail"
}

Tap:    { "action": "tap", "x": 0, "y": 0 }
Type:   { "action": "type", "text": "exact INFO value" }
Swipe:  { "action": "swipe", "start": {"x":0,"y":0}, "end": {"x":0,"y":0}, "duration": 500 }
Wait:   { "action": "wait", "ms": 800 }
Wheel:  { "action": "wheel", "x": 0, "y": 0, "rows": [ {"x":0,"y":0,"delta":1} ] }
Plan:   { "action": "plan", "purpose": "name", "steps": [
          {"action":"tap","x":0,"y":0}, {"action":"type","text":"exact INFO value"} ] }

Never put an action object inside the action field.
`;

// ============================================================
// HELPERS
// ============================================================

// Trả null nếu không phải số hữu hạn (KHÔNG fallback về 0).
function coord(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const n = Number(value);

  if (!Number.isFinite(n)) {
    return null;
  }

  return Math.max(0, Math.min(1000, n));
}

function clampNumber(value, min, max, fallback = 0) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, n));
}

function cleanObservation(value) {
  if (value == null) {
    return "";
  }

  return String(value).replace(/\s+/g, " ").trim().slice(0, 500);
}

function cleanState(value) {
  const state = String(value || "unknown").trim().toLowerCase();

  return STATES.includes(state) ? state : "unknown";
}

function cleanAction(value) {
  const action = String(value || "").trim().toLowerCase();

  return ACTIONS.includes(action) ? action : "";
}

function normalizeStatus(value) {
  const status = String(value || "").trim().toLowerCase();

  return ["proposed", "executed", "verified", "failed"].includes(status)
    ? status
    : "unknown";
}

function nfc(value) {
  return String(value ?? "").normalize("NFC");
}

function parseJsonLoose(text) {
  if (!text) {
    throw new Error("Empty Gemini response");
  }

  const value = String(text)
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(value);
  } catch (_) {
    const first = value.indexOf("{");
    const last = value.lastIndexOf("}");

    if (first >= 0 && last > first) {
      return JSON.parse(value.slice(first, last + 1));
    }

    throw new Error("Invalid JSON from Gemini");
  }
}

// ============================================================
// INFO
// ============================================================

function getInfoObject(info) {
  if (!info) {
    return {};
  }

  if (typeof info === "object") {
    return info;
  }

  try {
    const parsed = JSON.parse(String(info));

    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch (_) {}

  return { raw: String(info) };
}

// Chỉ lấy GIÁ TRỊ (không lấy tên key).
function collectInfoValues(node, out = [], depth = 0) {
  if (node == null || depth > 5) {
    return out;
  }

  if (
    typeof node === "string" ||
    typeof node === "number" ||
    typeof node === "boolean"
  ) {
    out.push(String(node));
  } else if (Array.isArray(node)) {
    node.forEach((v) => collectInfoValues(v, out, depth + 1));
  } else if (typeof node === "object") {
    Object.values(node).forEach((v) => collectInfoValues(v, out, depth + 1));
  }

  return out;
}

function infoValues(info) {
  return collectInfoValues(getInfoObject(info)).filter((v) => v.length > 0);
}

// Text hợp lệ nếu bằng một giá trị INFO (sau NFC) hoặc là đoạn con của một giá trị.
function infoAllows(info, text) {
  if (text == null || String(text).length === 0) {
    return false;
  }

  const target = nfc(text);

  return infoValues(info).some((v) => nfc(v).includes(target));
}

// Nếu text khớp CHÍNH XÁC một giá trị INFO (sau NFC), trả về giá trị gốc.
function canonicalText(info, text) {
  const target = nfc(text);
  const exact = infoValues(info).find((v) => nfc(v) === target);

  return exact !== undefined ? exact : String(text);
}

function pick(obj, keys) {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) {
      return String(obj[key]);
    }
  }

  return "";
}

function getNameInfo(info) {
  const obj = getInfoObject(info);

  return {
    familyName: pick(obj, ["ho", "họ", "familyName", "lastName", "last_name", "surname"]),
    givenName: pick(obj, ["ten", "tên", "givenName", "firstName", "first_name"]),
  };
}

function getPassword(info) {
  return pick(getInfoObject(info), ["password", "matKhau", "mật khẩu"]);
}

function serializeInfo(info) {
  try {
    return JSON.stringify(info ?? {});
  } catch (_) {
    return String(info ?? "");
  }
}

// ============================================================
// HISTORY
// ============================================================

function normalizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history.slice(-MAX_HISTORY).map((item, index) => {
    let status = normalizeStatus(item?.status);

    // success:true => verified, success:false => failed,
    // plan không có trạng thái => chỉ là proposed.
    if (item?.success === true) {
      status = "verified";
    } else if (item?.success === false) {
      status = "failed";
    } else if (status === "unknown" && item?.action === "plan") {
      status = "proposed";
    }

    return {
      id: item?.id ?? item?.transaction_id ?? item?.transactionId ?? `history_${index}`,
      state: cleanState(item?.state),
      action: cleanAction(item?.action),
      status,
      purpose: String(item?.purpose || "").trim().toLowerCase().slice(0, 100),
      text: item?.text == null ? "" : String(item.text).slice(0, 500),
      success: typeof item?.success === "boolean" ? item.success : null,
      reason: item?.reason == null ? "" : String(item.reason).slice(0, 500),
      expected_result:
        item?.expected_result == null ? "" : String(item.expected_result).slice(0, 500),
      timestamp: item?.timestamp ?? item?.time ?? null,
    };
  });
}

function analyzeHistory(history) {
  const items = normalizeHistory(history);

  let passwordSubmitted = false;
  let nameSubmitted = false;
  let phoneSubmitted = false;

  let lastAction = "";
  let lastState = "unknown";
  let lastOutcome = "unknown";

  let totalWaits = 0;
  let consecutiveWaits = 0;
  let restartCount = 0;
  let launchCount = 0;

  let lastTransaction = null;

  for (const item of items) {
    // Action lạ/không rõ không làm reset chuỗi wait.
    if (item.action) {
      lastAction = item.action;
    }

    lastState = item.state;
    lastOutcome = item.status;

    if (item.action === "wait") {
      totalWaits += 1;
      consecutiveWaits += 1;
    } else if (item.action) {
      consecutiveWaits = 0;
    }

    // Restart = phiên mới.
    if (item.action === "restart") {
      restartCount += 1;
      passwordSubmitted = false;
      nameSubmitted = false;
      phoneSubmitted = false;
      consecutiveWaits = 0;

      lastTransaction = {
        id: item.id,
        purpose: "restart",
        action: "restart",
        status: item.status,
      };

      continue;
    }

    if (item.action === "launch") {
      launchCount += 1;
    }

    // Chỉ "verified" mới chứng minh đã hoàn tất.
    if (item.purpose === "password" && item.status === "verified") {
      passwordSubmitted = true;
    }

    if (item.purpose === "name" && item.status === "verified") {
      nameSubmitted = true;
    }

    if (item.purpose === "phone" && item.status === "verified") {
      phoneSubmitted = true;
    }

    lastTransaction = {
      id: item.id,
      purpose: item.purpose,
      action: item.action,
      status: item.status,
      success: item.success,
      expected_result: item.expected_result,
    };
  }

  return {
    passwordSubmitted,
    nameSubmitted,
    phoneSubmitted,
    lastAction,
    lastState,
    lastOutcome,
    totalWaits,
    consecutiveWaits,
    restartCount,
    launchCount,
    lastTransaction,
  };
}

// ============================================================
// NORMALIZE GEMINI OUTPUT (hệ 0..1000, thiếu tọa độ => null)
// ============================================================

function normalizeBrain(raw) {
  const brain = raw && typeof raw === "object" ? raw : {};

  const result = {
    state: cleanState(brain.state),
    confidence: clampNumber(brain.confidence, 0, 1, 0),
    observations: Array.isArray(brain.observations)
      ? brain.observations
          .map(cleanObservation)
          .filter(Boolean)
          .slice(0, MAX_OBSERVATIONS)
      : [],
    diagnosis: cleanObservation(brain.diagnosis),
    decision: cleanObservation(brain.decision),
    expected_result: cleanObservation(brain.expected_result),
    action: cleanAction(brain.action) || "wait",
    purpose: String(brain.purpose || "").trim().toLowerCase().slice(0, 100),
    reason: cleanObservation(brain.reason),
    wait: clampNumber(brain.ms ?? brain.wait, 100, 10000, 800),
  };

  if (result.action === "tap") {
    result.x = coord(brain.x);
    result.y = coord(brain.y);
  }

  if (result.action === "type") {
    result.text = brain.text == null ? "" : String(brain.text);
  }

  if (result.action === "swipe") {
    const start = brain.start || {};
    const end = brain.end || {};

    result.start = {
      x: coord(start.x ?? brain.x1),
      y: coord(start.y ?? brain.y1),
    };

    result.end = {
      x: coord(end.x ?? brain.x2),
      y: coord(end.y ?? brain.y2),
    };

    result.duration = clampNumber(brain.duration, 100, 5000, 500);
  }

  if (result.action === "wheel") {
    result.x = coord(brain.x);
    result.y = coord(brain.y);

    result.rows = Array.isArray(brain.rows)
      ? brain.rows.slice(0, MAX_WHEEL_ROWS).map((row) => ({
          x: coord(row?.x),
          y: coord(row?.y),
          delta: clampNumber(row?.delta, -1000, 1000, 0),
        }))
      : [];
  }

  if (result.action === "plan") {
    result.steps = Array.isArray(brain.steps)
      ? brain.steps
          .slice(0, MAX_PLAN_STEPS)
          .map((step) => {
            const action = cleanAction(step?.action);
            const out = { action };

            if (action === "tap") {
              out.x = coord(step?.x);
              out.y = coord(step?.y);
            }

            if (action === "type") {
              out.text = step?.text == null ? "" : String(step.text);
            }

            return out;
          })
          .filter((step) => PLAN_ACTIONS.includes(step.action))
      : [];
  }

  return result;
}

// Gõ lại đúng giá trị gốc trong INFO (tránh lệch NFC/NFD).
function canonicalizeTyping(brain, info) {
  if (brain.action === "type" && brain.text) {
    brain.text = canonicalText(info, brain.text);
  }

  if (brain.action === "plan" && Array.isArray(brain.steps)) {
    brain.steps = brain.steps.map((step) =>
      step.action === "type" && step.text
        ? { ...step, text: canonicalText(info, step.text) }
        : step
    );
  }

  return brain;
}

function stripCoordinates(brain) {
  const copy = { ...brain };

  delete copy.x;
  delete copy.y;
  delete copy.start;
  delete copy.end;
  delete copy.rows;
  delete copy.steps;
  delete copy.text;
  delete copy.duration;

  return copy;
}

// ============================================================
// GUARDS
// ============================================================

function applyStateGuards(brain, history) {
  const result = { ...brain };

  // Đang ở app khác / Home Screen.
  if (
    (result.state === "external_app" || result.state === "home_screen") &&
    result.action !== "launch" &&
    result.action !== "wait"
  ) {
    return {
      ...stripCoordinates(result),
      action: "launch",
      purpose: "recovery",
      reason: "Target application is not visible.",
      decision: "Recover the target application before continuing.",
      expected_result: "The target application becomes visible.",
    };
  }

  // Cuộc gọi đến.
  if (
    result.state === "incoming_call" &&
    ["tap", "plan", "type", "swipe", "wheel"].includes(result.action)
  ) {
    return {
      ...stripCoordinates(result),
      action: "wait",
      purpose: "incoming_call",
      wait: 1500,
      reason: "Incoming call is blocking normal interaction.",
      decision: "Do not answer or reject the call automatically.",
      expected_result: "The call interruption disappears or the UI becomes stable.",
    };
  }

  // Thiết bị bị khóa.
  if (result.state === "device_lock") {
    return {
      ...stripCoordinates(result),
      action: "fail",
      purpose: "device_lock",
      reason: "Device is locked.",
      decision: "Stop safely.",
      expected_result: "Manual recovery is required.",
    };
  }

  // Mật khẩu đã verified: không nhập lại, trừ khi app báo lỗi.
  if (
    history.passwordSubmitted &&
    result.purpose === "password" &&
    result.state !== "error" &&
    ["plan", "type", "tap"].includes(result.action)
  ) {
    return {
      ...stripCoordinates(result),
      action: "wait",
      purpose: "password",
      wait: 600,
      reason: "Password was already verified as submitted.",
      decision: "Do not enter the password again.",
      expected_result: "The application continues beyond the password step.",
    };
  }

  return result;
}

function applyConfidenceGuard(brain) {
  if (brain.confidence >= MIN_CONFIDENCE) {
    return brain;
  }

  if (!["tap", "swipe", "type", "wheel", "plan", "restart"].includes(brain.action)) {
    return brain;
  }

  return {
    ...stripCoordinates(brain),
    action: "wait",
    purpose: "low_confidence",
    wait: 800,
    reason: "Visual confidence is too low for a risky action.",
    decision: "Wait for a clearer observation.",
    expected_result: "The next screenshot provides stronger evidence.",
  };
}

function applyLoopGuard(brain, history) {
  const stop = (purpose, reason) => ({
    ...stripCoordinates(brain),
    action: "fail",
    purpose,
    reason,
    decision: "Stop instead of looping.",
    expected_result: "Manual inspection is required.",
  });

  // Giới hạn wait theo từng loại tình huống (chỉ áp cho action wait).
  if (brain.action === "wait") {
    let limit = MAX_CONSECUTIVE_WAITS;
    let purpose = "loop_guard";
    let reason = "Too many consecutive waits.";

    if (brain.state === "incoming_call") {
      limit = MAX_CALL_WAITS;
      reason = "Incoming call remained unresolved for too long.";
    } else if (brain.state === "loading") {
      limit = MAX_LOADING_WAITS;
      purpose = "loading_timeout";
      reason = "Loading remained unchanged for too long.";
    }

    if (history.consecutiveWaits >= limit) {
      return stop(purpose, reason);
    }
  }

  // Restart / launch luôn có giới hạn, bất kể state.
  if (brain.action === "restart" && history.restartCount >= MAX_RESTARTS) {
    return stop("loop_guard", "Restart limit reached.");
  }

  if (brain.action === "launch" && history.launchCount >= MAX_LAUNCHES) {
    return stop("loop_guard", "Launch recovery limit reached.");
  }

  return brain;
}

// ============================================================
// VALIDATION
// ============================================================

function isNum(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validateAction(brain, info, history) {
  const errors = [];

  if (!ACTIONS.includes(brain.action)) {
    return ["Invalid action."];
  }

  const checkText = (text, label) => {
    if (typeof text !== "string" || !text.length) {
      errors.push(`${label} requires text.`);
    } else if (!infoAllows(info, text)) {
      errors.push(`${label} contains text not present in INFO values.`);
    }
  };

  if (brain.action === "tap") {
    if (!isNum(brain.x) || !isNum(brain.y)) {
      errors.push("tap requires x and y.");
    }
  }

  if (brain.action === "type") {
    checkText(brain.text, "type");

    if (
      brain.purpose === "password" &&
      getPassword(info) &&
      nfc(brain.text) !== nfc(getPassword(info))
    ) {
      errors.push("Password must exactly match INFO.");
    }
  }

  if (brain.action === "swipe") {
    const values = [brain.start?.x, brain.start?.y, brain.end?.x, brain.end?.y];

    if (!brain.start || !brain.end || !values.every(isNum)) {
      errors.push("swipe requires valid start and end.");
    }
  }

  if (brain.action === "wheel") {
    if (!isNum(brain.x) || !isNum(brain.y)) {
      errors.push("wheel requires x and y.");
    }

    if (!Array.isArray(brain.rows) || brain.rows.length === 0) {
      errors.push("wheel requires rows.");
    } else if (brain.rows.some((r) => !isNum(r.x) || !isNum(r.y))) {
      errors.push("wheel rows require x and y.");
    }
  }

  if (brain.action === "plan") {
    const steps = brain.steps;

    if (!Array.isArray(steps) || steps.length === 0) {
      errors.push("plan requires steps.");
    } else {
      steps.forEach((step, i) => {
        if (!PLAN_ACTIONS.includes(step.action)) {
          errors.push(`Invalid plan step ${i}.`);
        } else if (step.action === "tap") {
          if (!isNum(step.x) || !isNum(step.y)) {
            errors.push(`Plan tap step ${i} requires x/y.`);
          }
        } else {
          checkText(step.text, `Plan type step ${i}`);
        }
      });
    }

    // PASSWORD PLAN: tap -> type -> tap
    if (brain.purpose === "password") {
      const password = getPassword(info);

      if (history.passwordSubmitted && brain.state !== "error") {
        errors.push("Password already verified.");
      }

      if (!password) {
        errors.push("Password missing from INFO.");
      }

      if (!Array.isArray(steps) || steps.length !== 3) {
        errors.push("Password plan must contain exactly 3 steps.");
      } else {
        const [s1, s2, s3] = steps;

        if (s1.action !== "tap") errors.push("Password step 1 must be tap.");
        if (s2.action !== "type") errors.push("Password step 2 must be type.");
        if (s3.action !== "tap") errors.push("Password step 3 must be tap.");

        if (password && nfc(s2.text) !== nfc(password)) {
          errors.push("Password must exactly match INFO.");
        }
      }
    }

    // NAME PLAN: tap -> type -> tap -> type (chấp nhận cả hai thứ tự)
    if (brain.purpose === "name") {
      const { familyName, givenName } = getNameInfo(info);
      const validNames = [familyName, givenName].filter(Boolean).map(nfc);

      if (history.nameSubmitted) {
        errors.push("Name already verified.");
      }

      if (validNames.length < 2) {
        errors.push("Name data missing from INFO.");
      }

      if (!Array.isArray(steps) || steps.length !== 4) {
        errors.push("Name plan must contain exactly 4 steps.");
      } else {
        const [s1, s2, s3, s4] = steps;

        if (s1.action !== "tap") errors.push("Name step 1 must be tap.");
        if (s2.action !== "type") errors.push("Name step 2 must be type.");
        if (s3.action !== "tap") errors.push("Name step 3 must be tap.");
        if (s4.action !== "type") errors.push("Name step 4 must be type.");

        if (!validNames.includes(nfc(s2.text))) {
          errors.push("Name step 2 must use an exact INFO name.");
        }

        if (!validNames.includes(nfc(s4.text))) {
          errors.push("Name step 4 must use an exact INFO name.");
        }

        if (nfc(s2.text) === nfc(s4.text)) {
          errors.push("Name plan must use both name values.");
        }
      }
    }
  }

  if (brain.action === "done" && brain.confidence < 0.7) {
    errors.push("done requires confidence >= 0.7.");
  }

  return errors;
}

// ============================================================
// FALLBACK
// ============================================================

function fallbackAction(reason, options = {}) {
  const { transient = false, error = null } = options;

  return {
    state: "unknown",
    confidence: 0,
    observations: [],
    diagnosis: transient ? "Temporary vision/API failure." : "Safe fallback required.",
    decision: "Wait and observe again.",
    expected_result: "The next screenshot provides more information.",
    action: "wait",
    purpose: "fallback",
    reason: reason || "Unable to produce a safe action.",
    wait: 600,
    transient,
    error,
  };
}

// ============================================================
// 0..1000 -> PIXEL (chỉ gọi ở bước tạo response cuối)
// ============================================================

function scalePoint(x, y, width, height) {
  return {
    x: Math.round((clampNumber(x, 0, 1000, 0) / 1000) * width),
    y: Math.round((clampNumber(y, 0, 1000, 0) / 1000) * height),
  };
}

function toPixelAction(brain, width, height) {
  const base = {
    purpose: brain.purpose,
    reason: brain.reason,
  };

  switch (brain.action) {
    case "tap": {
      const p = scalePoint(brain.x, brain.y, width, height);

      return { action: "tap", x: p.x, y: p.y, ...base };
    }

    case "type":
      return { action: "type", text: brain.text, ...base };

    case "swipe": {
      const s = scalePoint(brain.start.x, brain.start.y, width, height);
      const e = scalePoint(brain.end.x, brain.end.y, width, height);

      return {
        action: "swipe",
        start: { x: s.x, y: s.y },
        end: { x: e.x, y: e.y },
        x1: s.x,
        y1: s.y,
        x2: e.x,
        y2: e.y,
        duration: brain.duration || 500,
        ...base,
      };
    }

    case "wait": {
      const ms = brain.wait || 800;

      return {
        action: "wait",
        ms,
        wait: ms,
        ...base,
      };
    }

    case "wheel": {
      const p = scalePoint(brain.x, brain.y, width, height);

      return {
        action: "wheel",
        x: p.x,
        y: p.y,
        // rows giữ nguyên hệ 0..1000 (giống 6.1).
        rows: (brain.rows || []).map((row) => ({
          x: row.x,
          y: row.y,
          delta: row.delta,
        })),
        ...base,
      };
    }

    case "plan":
      return {
        action: "plan",
        steps: (brain.steps || []).map((step) => {
          if (step.action === "tap") {
            const p = scalePoint(step.x, step.y, width, height);

            return { action: "tap", x: p.x, y: p.y };
          }

          return { action: "type", text: step.text };
        }),
        ...base,
      };

    case "launch":
    case "restart":
    case "done":
    case "fail":
      return { action: brain.action, ...base };

    default:
      return {
        action: "wait",
        ms: 600,
        wait: 600,
        purpose: "fallback",
        reason: "Unknown action converted to safe wait.",
      };
  }
}

// ============================================================
// PROMPT (SYSTEM_RULES chỉ gửi qua systemInstruction)
// ============================================================

function buildPrompt({ goal, info, rules, mode, failure, width, height, history, historyAnalysis }) {
  return `
CURRENT GOAL:
${String(goal || "")}

INFO:
${serializeInfo(info)}

USER / TASK RULES:
${Array.isArray(rules) ? rules.map((r) => `- ${String(r)}`).join("\n") : ""}

MODE:
${String(mode || "normal")}

SCREEN SIZE:
width=${width}
height=${height}

AGENT MEMORY:
${JSON.stringify(
  {
    passwordSubmitted: historyAnalysis.passwordSubmitted,
    nameSubmitted: historyAnalysis.nameSubmitted,
    phoneSubmitted: historyAnalysis.phoneSubmitted,
    lastAction: historyAnalysis.lastAction,
    lastState: historyAnalysis.lastState,
    lastOutcome: historyAnalysis.lastOutcome,
    consecutiveWaits: historyAnalysis.consecutiveWaits,
    restartCount: historyAnalysis.restartCount,
    launchCount: historyAnalysis.launchCount,
    lastTransaction: historyAnalysis.lastTransaction,
  },
  null,
  2
)}

RECENT HISTORY:
${JSON.stringify(history, null, 2)}

FAILURE / RECOVERY:
${failure ? JSON.stringify(failure, null, 2) : "No failure reported."}

TASK:
Analyze the screenshot. Determine the current UI state, what the app is
asking for, whether the screen is blocked, whether the previous action
executed and was verified, whether the goal is complete, then choose the
smallest safe next action and state the expected result.

Remember:
- coordinates are normalized 0..1000; ALWAYS include x and y for taps
- wheel.rows remain normalized 0..1000
- do not translate INFO values
- proposed and plan are not verified
- never re-enter a verified password unless the app rejected it

Return ONLY JSON.
`;
}

// ============================================================
// GEMINI
// ============================================================

async function callGemini({ image, prompt, model, timeoutMs }) {
  if (!GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  const imageString = String(image || "");

  let mimeType = "image/png";
  let base64 = "";

  const match = imageString.match(/^data:(image\/[^;]+);base64,(.+)$/s);

  if (match) {
    mimeType = match[1];
    base64 = match[2];
  } else {
    base64 = imageString.replace(/^data:[^,]+,/, "");
  }

  if (!base64) {
    throw new Error("Missing image data");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: SYSTEM_RULES }],
          },
          contents: [
            {
              role: "user",
              parts: [
                { inline_data: { mime_type: mimeType, data: base64 } },
                { text: prompt },
              ],
            },
          ],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
          },
        }),
      }
    );

    const raw = await response.text();

    if (!response.ok) {
      throw new Error(`Gemini HTTP ${response.status}: ${raw.slice(0, 1000)}`);
    }

    let data;

    try {
      data = JSON.parse(raw);
    } catch (_) {
      throw new Error("Invalid Gemini HTTP JSON.");
    }

    const text = data?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text || "")
      .join("")
      .trim();

    if (!text) {
      throw new Error("Gemini returned empty content.");
    }

    return parseJsonLoose(text);
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// RESPONSE
// ============================================================

function buildResponse({
  brain,
  width,
  height,
  success = true,
  transient = false,
  validationErrors = [],
  requestError = null,
}) {
  const payload = toPixelAction(brain, width, height);

  return {
    success,
    transient,

    state: brain.state,
    confidence: brain.confidence,
    observations: brain.observations,
    diagnosis: brain.diagnosis,
    decision: brain.decision,
    expected_result: brain.expected_result,

    // action phẳng ở cấp trên cùng (hợp đồng AutoTouch).
    ...payload,

    purpose: brain.purpose || payload.purpose || "",
    reason: brain.reason || payload.reason || "",

    validation_errors: validationErrors,
    error: requestError,
    brain_id: crypto.randomUUID(),
  };
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));

  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// ============================================================
// MAIN
// ============================================================

export default async function handler(req, res) {
  const reply = (brain, extra = {}, width = 375, height = 812) =>
    res.status(200).json(buildResponse({ brain, width, height, ...extra }));

  if (req.method !== "POST") {
    return reply(fallbackAction("Method not allowed."), {
      success: false,
      validationErrors: ["METHOD_NOT_ALLOWED"],
    });
  }

  // Khóa bí mật (tùy chọn): chỉ bật khi đặt biến môi trường ANALYZE_SECRET.
  if (ANALYZE_SECRET && !safeEqual(req.headers["x-api-secret"], ANALYZE_SECRET)) {
    return res.status(401).json({
      success: false,
      action: "fail",
      reason: "Unauthorized",
    });
  }

  try {
    const body = req.body || {};

    const { image, goal, info, rules, history, mode, failure } = body;

    const width = Number(body.width ?? body.screenWidth ?? 375) || 375;
    const height = Number(body.height ?? body.screenHeight ?? 812) || 812;

    if (!image) {
      return reply(
        fallbackAction("Missing screenshot image.", { transient: true }),
        { success: false, transient: true, validationErrors: ["MISSING_IMAGE"] },
        width,
        height
      );
    }

    const normalizedHistory = normalizeHistory(history);
    const historyAnalysis = analyzeHistory(normalizedHistory);

    const prompt = buildPrompt({
      goal,
      info,
      rules,
      mode,
      failure,
      width,
      height,
      history: normalizedHistory,
      historyAnalysis,
    });

    // ----------------------------------------------------------
    // GEMINI (chia sẻ ngân sách thời gian giữa các lần thử)
    // ----------------------------------------------------------

    const startedAt = Date.now();

    let brain = null;
    let lastError = null;

    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);

      if (attempt > 0 && remaining < MIN_RETRY_MS) {
        break;
      }

      try {
        const raw = await callGemini({
          image,
          prompt,
          model: attempt === 0 ? DEFAULT_MODEL : RECOVERY_MODEL,
          timeoutMs: Math.max(1000, Math.min(TIMEOUT_MS, remaining)),
        });

        brain = normalizeBrain(raw);

        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!brain) {
      const message = lastError?.message || "Gemini unavailable.";

      console.error("[GEMINI ERROR]", message);

      return reply(
        fallbackAction("Temporary Gemini/API failure. Wait and retry.", {
          transient: true,
          error: message,
        }),
        {
          success: false,
          transient: true,
          validationErrors: ["GEMINI_TEMPORARY_ERROR"],
          requestError: message,
        },
        width,
        height
      );
    }

    // ----------------------------------------------------------
    // CANONICALIZE -> GUARDS -> VALIDATE
    // ----------------------------------------------------------

    brain = canonicalizeTyping(brain, info);
    brain = applyStateGuards(brain, historyAnalysis);
    brain = applyConfidenceGuard(brain);
    brain = applyLoopGuard(brain, historyAnalysis);

    const validationErrors = validateAction(brain, info, historyAnalysis);

    if (validationErrors.length) {
      const errorText = validationErrors.join(" | ");

      console.warn("[ACTION VALIDATION]", errorText);

      const fallback = fallbackAction(
        `Validation rejected Gemini action: ${errorText}`,
        { transient: true }
      );

      // Giữ lại chẩn đoán của Gemini để dễ debug.
      fallback.state = brain.state;
      fallback.confidence = brain.confidence;
      fallback.observations = brain.observations;
      fallback.diagnosis = brain.diagnosis || fallback.diagnosis;
      fallback.decision = brain.decision || fallback.decision;
      fallback.expected_result = brain.expected_result || fallback.expected_result;

      return reply(
        fallback,
        {
          success: false,
          transient: true,
          validationErrors,
          requestError: errorText,
        },
        width,
        height
      );
    }

    return reply(
      brain,
      { success: true, transient: false, validationErrors: [] },
      width,
      height
    );
  } catch (error) {
    const message = error?.message || "Internal server error.";

    console.error("[ANALYZE ERROR]", message);

    return reply(
      fallbackAction("Temporary server error. Wait and retry.", {
        transient: true,
        error: message,
      }),
      {
        success: false,
        transient: true,
        validationErrors: ["INTERNAL_SERVER_ERROR"],
        requestError: message,
      }
    );
  }
}
