// ============================================================
// pages/api/analyze.js
// AUTOTOUCH VISION AGENT
// VERSION 6.6
//
// FIX:
// - Vercel FUNCTION_INVOCATION_FAILED
// - Gemini 3.5 Flash Lite
// - Image vision
// - JSON parser recovery
// - Không để exception làm chết function
// - Wait không còn bị coi là AI error
// ============================================================

const MODEL_NAME = "gemini-3.5-flash-lite";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/" +
  MODEL_NAME +
  ":generateContent";


// ============================================================
// NEXT API CONFIG
// ============================================================

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "15mb",
    },
  },
};


// ============================================================
// SAFE STRING
// ============================================================

function str(value, max) {
  if (value === undefined || value === null) {
    return "";
  }

  let s = String(value);

  if (max && s.length > max) {
    s = s.slice(0, max);
  }

  return s;
}


// ============================================================
// ARRAY
// ============================================================

function arr(value, max) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .slice(-(max || 20))
    .map(function (x) {
      return str(x, 1000);
    })
    .filter(Boolean);
}


// ============================================================
// IMAGE
// ============================================================

function parseImage(image) {
  if (!image) {
    return null;
  }

  var value = String(image).trim();

  if (
    value.indexOf("data:image/") === 0
  ) {
    var comma = value.indexOf(",");

    if (comma !== -1) {
      var header = value.slice(0, comma);
      var data = value.slice(comma + 1);

      var match =
        header.match(
          /^data:(image\/[^;]+);base64$/i
        );

      return {
        mimeType:
          match && match[1]
            ? match[1]
            : "image/jpeg",

        data: data,
      };
    }
  }

  return {
    mimeType: "image/jpeg",
    data: value,
  };
}


// ============================================================
// JSON EXTRACT
// ============================================================

function parseModelJSON(text) {
  if (!text) {
    return null;
  }

  var s = String(text).trim();

  // remove markdown fence
  s = s.replace(/^```json\s*/i, "");
  s = s.replace(/^```\s*/i, "");
  s = s.replace(/\s*```$/i, "");
  s = s.trim();

  // direct JSON
  try {
    return JSON.parse(s);
  } catch (e) {}

  // tìm object đầu tiên
  var start = s.indexOf("{");
  var end = s.lastIndexOf("}");

  if (
    start !== -1 &&
    end !== -1 &&
    end > start
  ) {
    var candidate =
      s.slice(start, end + 1);

    try {
      return JSON.parse(candidate);
    } catch (e) {}
  }

  return null;
}


// ============================================================
// ACTION NORMALIZER
// ============================================================

function normalizeAction(action) {
  if (!action || typeof action !== "object") {
    return null;
  }

  var type =
    str(action.type, 50)
      .toLowerCase()
      .trim();

  // ----------------------------------------------------------
  // TAP
  // ----------------------------------------------------------

  if (
    type === "tap" ||
    type === "click"
  ) {
    var x = Number(action.x);
    var y = Number(action.y);

    if (
      !isFinite(x) ||
      !isFinite(y)
    ) {
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

  if (
    type === "type" ||
    type === "input"
  ) {
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
  // WAIT
  // ----------------------------------------------------------

  if (type === "wait") {
    var ms = Number(action.ms);

    if (!isFinite(ms)) {
      var seconds =
        Number(action.seconds);

      if (isFinite(seconds)) {
        ms = seconds * 1000;
      }
    }

    if (!isFinite(ms)) {
      ms = 1200;
    }

    ms = Math.max(
      300,
      Math.min(ms, 5000)
    );

    return {
      type: "wait",
      ms: Math.round(ms),
    };
  }


  // ----------------------------------------------------------
  // SWIPE
  // ----------------------------------------------------------

  if (type === "swipe") {
    var x1 = Number(action.x1);
    var y1 = Number(action.y1);
    var x2 = Number(action.x2);
    var y2 = Number(action.y2);

    if (
      !isFinite(x1) ||
      !isFinite(y1) ||
      !isFinite(x2) ||
      !isFinite(y2)
    ) {
      return null;
    }

    return {
      type: "swipe",
      x1: Math.round(x1),
      y1: Math.round(y1),
      x2: Math.round(x2),
      y2: Math.round(y2),
      duration:
        isFinite(Number(action.duration))
          ? Number(action.duration)
          : 0.5,
    };
  }


  // ----------------------------------------------------------
  // WHEEL
  // ----------------------------------------------------------

  if (type === "wheel") {
    return {
      type: "wheel",

      direction:
        str(
          action.direction,
          20
        ).toLowerCase() === "up"
          ? "up"
          : "down",

      amount:
        isFinite(Number(action.amount))
          ? Math.max(
              1,
              Math.min(
                20,
                Number(action.amount)
              )
            )
          : 3,
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

  if (
    type === "fail" ||
    type === "error"
  ) {
    return {
      type: "fail",
      reason: str(
        action.reason ||
          action.message ||
          "AI reported failure.",
        500
      ),
    };
  }


  // ----------------------------------------------------------
  // PLAN
  // ----------------------------------------------------------

  if (type === "plan") {
    var source =
      Array.isArray(action.steps)
        ? action.steps
        : Array.isArray(action.plan)
        ? action.plan
        : [];

    var steps = [];

    for (
      var i = 0;
      i < source.length && i < 8;
      i++
    ) {
      var normalized =
        normalizeAction(source[i]);

      if (normalized) {
        steps.push(normalized);
      }
    }

    if (!steps.length) {
      return null;
    }

    return {
      type: "plan",
      steps: steps,
    };
  }

  return null;
}


// ============================================================
// WAIT RESPONSE
// ============================================================

function waitResponse(reason) {
  return {
    success: true,
    transient: false,

    state: "waiting",

    confidence: 0.2,

    observations: [],

    diagnosis:
      reason ||
      "Đang chờ màn hình ổn định.",

    decision:
      "Wait and observe",

    action: {
      type: "wait",
      ms: 1200,
    },

    reason:
      reason ||
      "Chụp lại màn hình và quan sát tiếp.",
  };
}


// ============================================================
// BUILD PROMPT
// ============================================================

function buildPrompt(
  goal,
  info,
  rules,
  history,
  recovery
) {
  var rulesText =
    arr(rules, 30)
      .map(function (x, i) {
        return (
          (i + 1) +
          ". " +
          x
        );
      })
      .join("\n");

  var historyText =
    arr(history, 12)
      .map(function (x, i) {
        return (
          (i + 1) +
          ". " +
          x
        );
      })
      .join("\n");

  return `
Bạn là AI điều khiển AutoTouch bằng screenshot.

MỤC TIÊU:
${str(goal, 1000)}

INFO:
${str(info, 5000)}

RULES:
${rulesText || "(none)"}

HISTORY:
${historyText || "(none)"}

Hãy nhìn kỹ screenshot.

QUY TẮC QUAN TRỌNG:

1. Screenshot là nguồn sự thật.
2. Chỉ trả về đúng 1 action tiếp theo.
3. Nếu có nút rõ ràng thì ưu tiên tap.
4. Không được tap ngẫu nhiên.
5. Không được bịa UI.
6. Nếu đang loading thì wait.
7. Nếu màn hình rõ và có nút "Bắt đầu", "Tiếp",
   "Tiếp tục", "Xác nhận", "Đăng ký",
   hoặc "Tiếp theo", hãy tap nút phù hợp.
8. Không trả action rỗng.
9. Nếu chưa chắc nhưng có một action an toàn
   rõ ràng thì thực hiện action đó.
10. Chỉ dùng wait khi thật sự chưa có action an toàn.

MẬT KHẨU:

- Mật khẩu chỉ được nhập một lần.
- Nếu HISTORY cho biết password đã nhập,
  tuyệt đối không type password lần nữa.
- Không nhập lại password chỉ vì ô bị mask,
  hiện dấu chấm hoặc nhìn giống trống.
- Không đưa password vào observations/reason.

TRẢ VỀ JSON THUẦN:

{
  "state": "...",
  "confidence": 0.0,
  "observations": ["..."],
  "diagnosis": "...",
  "decision": "...",
  "action": {
    "type": "tap",
    "x": 123,
    "y": 456
  },
  "reason": "..."
}

ACTION HỢP LỆ:

tap
type
swipe
wait
wheel
plan
done
fail

${
  recovery
    ? `
ĐÂY LÀ LẦN PHÂN TÍCH RECOVERY.

Lần trước chưa tạo được action hợp lệ.
Hãy kiểm tra lại toàn bộ screenshot,
đặc biệt tìm nút "Bắt đầu" và các nút điều hướng.
Nếu thấy action rõ ràng thì trả action đó.
`
    : ""
}

CHỈ TRẢ JSON.
`;
}


// ============================================================
// GEMINI CALL
// ============================================================

async function callGemini(
  apiKey,
  image,
  prompt
) {
  var parsedImage =
    parseImage(image);

  if (
    !parsedImage ||
    !parsedImage.data
  ) {
    throw new Error(
      "IMAGE_MISSING"
    );
  }

  var payload = {
    contents: [
      {
        role: "user",

        parts: [
          {
            inlineData: {
              mimeType:
                parsedImage.mimeType,

              data:
                parsedImage.data,
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
    },
  };

  var response =
    await fetch(
      GEMINI_URL +
        "?key=" +
        encodeURIComponent(apiKey),
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        body: JSON.stringify(
          payload
        ),
      }
    );

  var raw =
    await response.text();

  if (!response.ok) {
    var message =
      "Gemini HTTP " +
      response.status;

    try {
      var errorJson =
        JSON.parse(raw);

      if (
        errorJson &&
        errorJson.error &&
        errorJson.error.message
      ) {
        message =
          errorJson.error.message;
      }
    } catch (e) {}

    throw new Error(message);
  }

  var data;

  try {
    data =
      JSON.parse(raw);
  } catch (e) {
    throw new Error(
      "GEMINI_INVALID_HTTP_JSON"
    );
  }

  var candidates =
    data.candidates || [];

  if (!candidates.length) {
    throw new Error(
      "GEMINI_NO_CANDIDATE"
    );
  }

  var parts =
    candidates[0] &&
    candidates[0].content &&
    candidates[0].content.parts
      ? candidates[0].content.parts
      : [];

  var output = "";

  for (
    var i = 0;
    i < parts.length;
    i++
  ) {
    if (
      parts[i] &&
      typeof parts[i].text ===
        "string"
    ) {
      output += parts[i].text;
    }
  }

  if (!output.trim()) {
    throw new Error(
      "GEMINI_EMPTY_OUTPUT"
    );
  }

  return output;
}


// ============================================================
// MAIN HANDLER
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
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );

  if (req.method === "OPTIONS") {
    return res
      .status(200)
      .end();
  }

  if (req.method !== "POST") {
    return res
      .status(405)
      .json({
        success: false,
        error: "POST only",
      });
  }

  // ----------------------------------------------------------
  // EVERYTHING INSIDE TRY
  // ----------------------------------------------------------

  try {
    var body =
      req.body || {};

    var apiKey =
      str(
        body.key ||
          process.env.GEMINI_API_KEY,
        1000
      ).trim();

    if (!apiKey) {
      console.error(
        "[ANALYZE] GEMINI API KEY MISSING"
      );

      return res
        .status(200)
        .json(
          waitResponse(
            "Gemini API key is missing."
          )
        );
    }

    var image =
      body.image;

    if (!image) {
      return res
        .status(200)
        .json(
          waitResponse(
            "Screenshot is missing."
          )
        );
    }

    var goal =
      str(
        body.goal,
        1000
      ) ||
      "Hoàn thành màn hình đăng ký hiện tại và chuyển sang bước tiếp theo.";

    var info =
      str(
        body.info,
        5000
      );

    var rules =
      Array.isArray(body.rules)
        ? body.rules
        : [];

    var history =
      Array.isArray(body.history)
        ? body.history
        : [];


    // --------------------------------------------------------
    // PRIMARY
    // --------------------------------------------------------

    var output = null;
    var primaryError = null;

    try {
      output =
        await callGemini(
          apiKey,
          image,
          buildPrompt(
            goal,
            info,
            rules,
            history,
            false
          )
        );
    } catch (error) {
      primaryError =
        error;

      console.error(
        "[GEMINI PRIMARY]",
        error &&
        error.message
          ? error.message
          : error
      );
    }


    // --------------------------------------------------------
    // RECOVERY
    // --------------------------------------------------------

    if (!output) {
      try {
        output =
          await callGemini(
            apiKey,
            image,
            buildPrompt(
              goal,
              info,
              rules,
              history,
              true
            )
          );
      } catch (error) {
        console.error(
          "[GEMINI RECOVERY]",
          error &&
          error.message
            ? error.message
            : error
        );

        // Không để Vercel trả 500.
        return res
          .status(200)
          .json(
            waitResponse(
              "Vision temporarily unavailable. Retry with a new screenshot."
            )
          );
      }
    }


    // --------------------------------------------------------
    // PARSE
    // --------------------------------------------------------

    var model =
      parseModelJSON(
        output
      );


    // --------------------------------------------------------
    // Nếu model JSON lỗi:
    // recovery thêm một lần
    // --------------------------------------------------------

    if (!model) {
      try {
        var recoveryOutput =
          await callGemini(
            apiKey,
            image,
            buildPrompt(
              goal,
              info,
              rules,
              history,
              true
            )
          );

        model =
          parseModelJSON(
            recoveryOutput
          );
      } catch (error) {
        console.error(
          "[JSON RECOVERY]",
          error &&
          error.message
            ? error.message
            : error
        );
      }
    }


    // --------------------------------------------------------
    // Không parse được
    // --------------------------------------------------------

    if (!model) {
      return res
        .status(200)
        .json(
          waitResponse(
            "AI response chưa hợp lệ. Chụp lại và phân tích lại."
          )
        );
    }


    // --------------------------------------------------------
    // ACTION
    // --------------------------------------------------------

    var action =
      normalizeAction(
        model.action
      );


    // --------------------------------------------------------
    // MODEL đôi khi trả decision = wait
    // --------------------------------------------------------

    if (
      !action &&
      model.decision
    ) {
      var decision =
        str(
          model.decision,
          300
        ).toLowerCase();

      if (
        decision.indexOf(
          "wait"
        ) !== -1 ||
        decision.indexOf(
          "observe"
        ) !== -1 ||
        decision.indexOf(
          "chờ"
        ) !== -1 ||
        decision.indexOf(
          "quan sát"
        ) !== -1
      ) {
        action = {
          type: "wait",
          ms: 1200,
        };
      }
    }


    // --------------------------------------------------------
    // Không có action
    // --------------------------------------------------------

    if (!action) {
      return res
        .status(200)
        .json(
          waitResponse(
            "Không tìm thấy action an toàn. Quan sát lại."
          )
        );
    }


    // --------------------------------------------------------
    // RESPONSE
    // --------------------------------------------------------

    var confidence =
      Number(
        model.confidence
      );

    if (!isFinite(confidence)) {
      confidence = 0.5;
    }

    confidence =
      Math.max(
        0,
        Math.min(
          1,
          confidence
        )
      );


    var result = {
      success: true,

      transient: false,

      state:
        str(
          model.state,
          100
        ) ||
        "observed",

      confidence:
        confidence,

      observations:
        arr(
          model.observations,
          12
        ),

      diagnosis:
        str(
          model.diagnosis,
          1000
        ) ||
        "Vision analysis completed.",

      decision:
        str(
          model.decision,
          500
        ) ||
        "Execute next action.",

      action:
        action,

      reason:
        str(
          model.reason,
          1000
        ) ||
        "Next UI action selected.",
    };


    // --------------------------------------------------------
    // WAIT
    // --------------------------------------------------------

    if (
      action.type ===
      "wait"
    ) {
      result.success = true;
      result.state =
        "waiting";
      result.decision =
        "Wait and observe";
    }


    // --------------------------------------------------------
    // DONE
    // --------------------------------------------------------

    if (
      action.type ===
      "done"
    ) {
      result.success = true;
      result.state =
        "done";
      result.decision =
        "Completed";
    }


    // --------------------------------------------------------
    // RETURN
    // --------------------------------------------------------

    return res
      .status(200)
      .json(result);

  } catch (error) {
    // ========================================================
    // QUAN TRỌNG:
    // Tuyệt đối không để exception biến thành FUNCTION
    // INVOCATION FAILED nếu handler đã được load.
    // ========================================================

    console.error(
      "[ANALYZE FATAL]",
      error &&
      error.stack
        ? error.stack
        : error
    );

    return res
      .status(200)
      .json(
        waitResponse(
          "Temporary server exception. Retry screenshot."
        )
      );
  }
}
