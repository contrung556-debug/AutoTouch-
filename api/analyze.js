// ============================================================
// pages/api/analyze.js
// AUTOTOUCH VISION AGENT - MERGED VERSION
//
// Request:
// {
//   image,
//   key,
//   goal,
//   info,
//   rules[],
//   history[],
//   mode: "normal" | "recover",
//   failure
// }
//
// Response:
// {
//   success,
//   action,
//   reason,
//   x, y,
//   x2, y2,
//   text,
//   seconds,
//   rows,
//   steps,
//   diagnosis,
//   image_width,
//   image_height,
//   model,
//   version
// }
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
  process.env.GEMINI_MODEL ||
  "gemini-3.5-flash-lite";

const RECOVER_MODEL =
  process.env.GEMINI_RECOVERY_MODEL ||
  MODEL_ID;

const VERSION =
  "6.0-autotouch-merged";

const ATTEMPTS = 2;
const TIMEOUT_MS = 22000;

const MAX_PLAN_STEPS = 8;
const MAX_WHEEL_ROWS = 40;

const geminiUrl = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// ============================================================
// HELPERS
// ============================================================

function str(value, fallback = "") {
  if (
    value === undefined ||
    value === null
  ) {
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

function num(value, fallback = null) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return fallback;
  }

  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

function clamp(
  value,
  min,
  max,
  fallback
) {
  const n = num(value, fallback);

  return Math.max(
    min,
    Math.min(max, Math.round(n))
  );
}

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

function httpError(
  message,
  status
) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function waitAction(
  reason,
  seconds = 2
) {
  return {
    action: "wait",
    seconds: clamp(
      seconds,
      1,
      10,
      2
    ),
    reason: limit(
      reason,
      500
    ),
  };
}

// ============================================================
// IMAGE
// ============================================================

function normalizeImage(image) {
  if (!image) {
    throw httpError(
      "Thiếu image.",
      400
    );
  }

  const value =
    String(image).trim();

  if (
    value.startsWith("data:")
  ) {
    const match =
      value.match(
        /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/
      );

    if (!match) {
      throw httpError(
        "Image data URI không hợp lệ.",
        400
      );
    }

    return {
      mimeType: match[1],
      data:
        match[2].replace(
          /\s+/g,
          ""
        ),
    };
  }

  let mimeType =
    "image/png";

  if (
    value.startsWith("/9j/")
  ) {
    mimeType =
      "image/jpeg";
  } else if (
    value.startsWith("UklGR")
  ) {
    mimeType =
      "image/webp";
  }

  return {
    mimeType,
    data:
      value.replace(
        /\s+/g,
        ""
      ),
  };
}

// ============================================================
// IMAGE SIZE
// ============================================================

function getImageSize(data) {
  try {
    const head =
      Buffer.from(
        data.slice(0, 64),
        "base64"
      );

    // PNG
    if (
      head.length >= 24 &&
      head[0] === 0x89 &&
      head[1] === 0x50 &&
      head[2] === 0x4e &&
      head[3] === 0x47
    ) {
      return {
        width:
          head.readUInt32BE(16),

        height:
          head.readUInt32BE(20),
      };
    }

    // JPEG
    if (
      head[0] === 0xff &&
      head[1] === 0xd8
    ) {
      const buf =
        Buffer.from(
          data,
          "base64"
        );

      let i = 2;

      while (
        i + 9 <
        buf.length
      ) {
        if (
          buf[i] !== 0xff
        ) {
          i++;
          continue;
        }

        const marker =
          buf[i + 1];

        const isSof =
          marker >= 0xc0 &&
          marker <= 0xcf &&
          ![
            0xc4,
            0xc8,
            0xcc,
          ].includes(marker);

        if (isSof) {
          return {
            height:
              buf.readUInt16BE(
                i + 5
              ),

            width:
              buf.readUInt16BE(
                i + 7
              ),
          };
        }

        const length =
          buf.readUInt16BE(
            i + 2
          );

        i +=
          2 + length;
      }
    }
  } catch {}

  return null;
}

// ============================================================
// JSON
// ============================================================

function extractJson(text) {
  if (!text) {
    return null;
  }

  const value =
    String(text)
      .trim()
      .replace(
        /^```(?:json)?\s*/i,
        ""
      )
      .replace(
        /\s*```$/i,
        ""
      )
      .trim();

  try {
    return JSON.parse(value);
  } catch {}

  const first =
    value.indexOf("{");

  const last =
    value.lastIndexOf("}");

  if (
    first !== -1 &&
    last > first
  ) {
    try {
      return JSON.parse(
        value.slice(
          first,
          last + 1
        )
      );
    } catch {}
  }

  return null;
}

// ============================================================
// COORDINATES
// ============================================================

function norm(value) {
  const n =
    num(value);

  if (n === null) {
    return null;
  }

  return Math.max(
    0,
    Math.min(1000, n)
  );
}

function toPx(
  n,
  size
) {
  return Math.max(
    0,
    Math.min(
      size - 1,
      Math.round(
        (n / 1000) *
          size
      )
    )
  );
}

function point(
  x,
  y,
  size
) {
  const nx =
    norm(x);

  const ny =
    norm(y);

  if (
    nx === null ||
    ny === null
  ) {
    return null;
  }

  return {
    x: toPx(
      nx,
      size.width
    ),

    y: toPx(
      ny,
      size.height
    ),
  };
}

// ============================================================
// ALLOWED TYPE
// ============================================================

function isAllowedText(
  text,
  info
) {
  if (
    !text ||
    !text.trim()
  ) {
    return false;
  }

  return str(info).includes(
    text
  );
}

// ============================================================
// PLAN
// ============================================================

function normalizePlanStep(
  raw,
  size,
  info
) {
  if (
    !raw ||
    typeof raw !==
      "object"
  ) {
    return {
      skip: true,
    };
  }

  const action =
    str(raw.action)
      .toLowerCase()
      .trim();

  if (
    action === "tap"
  ) {
    const p =
      point(
        raw.x,
        raw.y,
        size
      );

    if (!p) {
      return {
        skip: true,
      };
    }

    return {
      step: {
        action: "tap",
        x: p.x,
        y: p.y,
      },
    };
  }

  if (
    action === "type"
  ) {
    const text =
      str(raw.text);

    if (
      !isAllowedText(
        text,
        info
      )
    ) {
      return {
        error:
          `Text "${limit(
            text,
            40
          )}" không nằm trong INFO.`,
      };
    }

    return {
      step: {
        action: "type",
        text,
      },
    };
  }

  return {
    skip: true,
  };
}

// ============================================================
// ACTION NORMALIZATION
// ============================================================

function normalizeAction(
  raw,
  size,
  info
) {
  if (
    !raw ||
    typeof raw !==
      "object"
  ) {
    return waitAction(
      "Gemini không trả action hợp lệ."
    );
  }

  const action =
    str(raw.action)
      .toLowerCase()
      .trim();

  const reason =
    limit(
      raw.reason,
      500
    );

  switch (
    action
  ) {
    // --------------------------------------------------------
    // TAP
    // --------------------------------------------------------

    case "tap": {
      const p =
        point(
          raw.x,
          raw.y,
          size
        );

      if (!p) {
        return waitAction(
          "Gemini trả tap nhưng thiếu tọa độ."
        );
      }

      return {
        action: "tap",
        x: p.x,
        y: p.y,
        target:
          limit(
            raw.target,
            300
          ),
        reason,
      };
    }

    // --------------------------------------------------------
    // SWIPE
    // --------------------------------------------------------

    case "swipe": {
      const a =
        point(
          raw.x,
          raw.y,
          size
        );

      const b =
        point(
          raw.x2,
          raw.y2,
          size
        );

      if (!a || !b) {
        return waitAction(
          "Gemini trả swipe nhưng thiếu tọa độ."
        );
      }

      return {
        action: "swipe",
        x: a.x,
        y: a.y,
        x2: b.x,
        y2: b.y,
        reason,
      };
    }

    // --------------------------------------------------------
    // TYPE
    // --------------------------------------------------------

    case "type": {
      const text =
        str(raw.text);

      if (!text) {
        return waitAction(
          "Gemini trả type nhưng không có text."
        );
      }

      if (
        !isAllowedText(
          text,
          info
        )
      ) {
        return waitAction(
          "Text không nằm trong INFO."
        );
      }

      return {
        action: "type",
        text,
        target:
          limit(
            raw.target,
            300
          ),
        reason,
      };
    }

    // --------------------------------------------------------
    // WAIT
    // --------------------------------------------------------

    case "wait":
      return {
        action: "wait",

        seconds:
          clamp(
            raw.seconds ??
              (
                num(
                  raw.ms
                )
                  ? num(
                      raw.ms
                    ) / 1000
                  : null
              ),
            1,
            10,
            2
          ),

        reason:
          reason ||
          "Chờ UI ổn định.",
      };

    // --------------------------------------------------------
    // WHEEL
    // --------------------------------------------------------

    case "wheel": {
      const p =
        point(
          raw.x,
          raw.y,
          size
        );

      if (!p) {
        return waitAction(
          "Gemini trả wheel nhưng thiếu tọa độ."
        );
      }

      const rows =
        clamp(
          raw.rows,
          -MAX_WHEEL_ROWS,
          MAX_WHEEL_ROWS,
          0
        );

      if (
        rows === 0
      ) {
        return waitAction(
          "Wheel rows = 0."
        );
      }

      return {
        action: "wheel",
        x: p.x,
        y: p.y,
        rows,
        reason,
      };
    }

    // --------------------------------------------------------
    // PLAN
    // --------------------------------------------------------

    case "plan": {
      if (
        !Array.isArray(
          raw.steps
        )
      ) {
        return waitAction(
          "Plan không có steps."
        );
      }

      const steps = [];

      for (
        const s of raw.steps.slice(
          0,
          MAX_PLAN_STEPS
        )
      ) {
        const out =
          normalizePlanStep(
            s,
            size,
            info
          );

        if (
          out.error
        ) {
          return waitAction(
            out.error
          );
        }

        if (
          out.step
        ) {
          steps.push(
            out.step
          );
        }
      }

      if (
        steps.length === 0
      ) {
        return waitAction(
          "Plan không có step hợp lệ."
        );
      }

      return {
        action: "plan",
        steps,
        reason:
          reason ||
          "Thực hiện plan.",
      };
    }

    // --------------------------------------------------------
    // LAUNCH
    // --------------------------------------------------------

    case "launch":
      return {
        action: "launch",

        reason:
          reason ||
          "Mở lại ứng dụng.",
      };

    // --------------------------------------------------------
    // RESTART
    // --------------------------------------------------------

    case "restart":
      return {
        action: "restart",

        reason:
          reason ||
          "Đóng hẳn rồi mở lại ứng dụng.",
      };

    // --------------------------------------------------------
    // DONE
    // --------------------------------------------------------

    case "done":
      return {
        action: "done",

        reason:
          reason ||
          "Đã hoàn thành.",
      };

    // --------------------------------------------------------
    // FAIL
    // --------------------------------------------------------

    case "fail":
      return {
        action: "fail",

        reason:
          reason ||
          "AI không thể tiếp tục.",
      };

    default:
      return waitAction(
        "Action không hợp lệ."
      );
  }
}

// ============================================================
// SYSTEM PROMPT
// ============================================================

const SYSTEM_PROMPT =
  "Bạn là Vision Agent điều khiển UI điện thoại. " +
  "Làm việc cực kỳ thận trọng theo screenshot hiện tại. " +
  "Chỉ trả về MỘT JSON action hợp lệ. " +
  "Không markdown. Không giải thích ngoài JSON.";

// ============================================================
// SYSTEM RULES
// ============================================================

const SYSTEM_RULES = `
TỌA ĐỘ:
- Gemini trả tọa độ chuẩn hóa 0..1000.
- x=0 trái, x=1000 phải.
- y=0 trên, y=1000 dưới.
- Luôn chọn TÂM control.

NGUYÊN TẮC:
- Chỉ dựa trên screenshot hiện tại.
- Không bịa control.
- Không đoán tọa độ.
- Không chắc chắn thì WAIT.
- Mỗi lần chỉ một action.
- Sau mỗi action phải có screenshot mới.
- Screenshot hiện tại quan trọng hơn history.

QUẢNG CÁO:
- Không tap quảng cáo.
- Không tap banner.
- Không tap link mở website/app ngoài.
- Không thao tác nội dung ngoài mục tiêu.

LOADING:
- Spinner/loading -> wait.
- Không click lại button đang loading.
- Button disabled -> không tap.

INPUT:
- Chỉ type dữ liệu xuất hiện trong INFO.
- Không type nhãn.
- Không type dữ liệu tự suy luận.
- Field đã đúng -> không type lại.
- Không xóa dữ liệu đúng nếu không cần.

PLAN:
- Chỉ gồm tap/type.
- Không swipe.
- Không wheel.
- Không wait.
- Không đưa nút Tiếp vào plan.
- Sau plan phải kiểm tra screenshot mới.

MẬT KHẨU:
- Chỉ dùng Mật khẩu trong INFO.
- Không tự tạo mật khẩu.
- Nếu không có Mật khẩu -> fail.
- Nếu ô đã có dấu chấm -> không type lại chỉ vì không thấy plaintext.

SỐ ĐIỆN THOẠI:
- Chỉ dùng đúng Số di động trong INFO.
- Không thêm +84.
- Không bỏ số 0.
- Không tự tạo số khác.
- Nếu app báo số bị từ chối/đã dùng -> fail.

NGÀY SINH:
- INFO có ngày dạng DD/MM/YYYY.
- Chỉ dùng wheel.
- Không type ngày.
- Không tap số trong wheel.
- Thứ tự: năm -> tháng -> ngày.
- Mỗi lần chỉ chỉnh một cột.
- rows dương = giá trị phía dưới.
- rows âm = giá trị phía trên.
- Sau mỗi wheel phải xem screenshot mới.
- Không chuyển cột khi cột hiện tại chưa xác nhận đúng.
- Năm không quay vòng.
- Tháng/ngày có thể quay vòng.
- Không dùng rows > 40 trong một action.

MÀN HÌNH ĐĂNG KÝ:
- "Bắt đầu" -> tap Bắt đầu đúng ngữ cảnh đăng ký.
- "Tạo tài khoản mới" -> tap.
- "Tôi có trang cá nhân rồi" -> không tap.
- "Tìm tài khoản của tôi" -> không tap.
- "Đăng nhập" -> không tap khi đang đăng ký.
- "Quên mật khẩu" -> không tap.

MÀN HÌNH TÊN:
- Họ/Tên trống -> plan:
  tap Họ -> type Họ -> tap Tên -> type Tên.
- Sau plan kiểm tra lại rồi mới tap Tiếp.

MÀN HÌNH SỐ:
- Ô trống -> plan tap + type số.
- Sau plan kiểm tra lại.
- Chỉ sau khi số đúng mới tap Tiếp.

MÀN HÌNH MẬT KHẨU:
- Ô trống -> plan tap + type mật khẩu.
- Sau đó kiểm tra.
- Không tap mắt.
- Không tap checkbox ghi nhớ.
- Chỉ tap Tiếp khi có bằng chứng dữ liệu đã được nhập.

APP BỊ ĐÓNG:
- Nếu thấy màn hình chính iOS -> launch.
- Không tap icon app trên Home Screen.
- Nếu thấy trình chuyển đổi app -> launch.
- Nếu thấy trang lỗi kỹ thuật -> restart.
- Không tap nút Làm mới của trang lỗi.

CAPTCHA / OTP / CHECKPOINT:
- Không đoán.
- Không tự nhập.
- Có thể wait nếu rõ ràng đang loading.
- Nếu bị chặn thực sự -> fail.

KẾT THÚC:
- Nếu đã vào Facebook Feed/Home sau khi đăng ký -> done.
- Nếu mục tiêu đã hoàn thành -> done.
- Nếu không thể tiếp tục an toàn -> fail.
`;

// ============================================================
// HISTORY
// ============================================================

function formatHistory(
  history
) {
  if (
    !history ||
    (
      Array.isArray(history) &&
      history.length === 0
    )
  ) {
    return "Chưa có lịch sử.";
  }

  if (
    Array.isArray(history)
  ) {
    return limit(
      history
        .slice(-10)
        .map(
          (h) =>
            str(h)
        )
        .join("\n"),
      5000
    );
  }

  return limit(
    history,
    5000
  );
}

function formatRules(
  rules
) {
  if (
    !rules ||
    (
      Array.isArray(rules) &&
      rules.length === 0
    )
  ) {
    return "Không có.";
  }

  if (
    Array.isArray(rules)
  ) {
    return limit(
      rules
        .map(
          (r) =>
            "- " +
            str(r)
        )
        .join("\n"),
      8000
    );
  }

  return limit(
    rules,
    8000
  );
}

// ============================================================
// RECOVERY
// ============================================================

function buildRecoveryBlock(
  failure
) {
  return `
=== RECOVERY MODE ===

Lần xử lý bình thường đã thất bại.

LÝ DO:
${limit(
  failure,
  1000
)}

Hãy phân tích screenshot hiện tại.

ƯU TIÊN:

1. Nếu mục tiêu đã đạt:
   -> done

2. Nếu đang ở Home Screen iOS:
   -> launch

3. Nếu đang ở ngoài app:
   -> launch

4. Nếu trang lỗi kỹ thuật:
   -> restart

5. Nếu UI đang loading:
   -> wait

6. Nếu action trước thất bại:
   -> không lặp lại y nguyên action đó.
   -> tìm vị trí khác của cùng control nếu screenshot có bằng chứng.
   -> hoặc tap input trước rồi type.
   -> hoặc swipe để tìm control.

7. Nếu có mũi tên quay lại và đang ở sai bước:
   -> có thể tap mũi tên quay lại.

8. CAPTCHA / OTP / checkpoint:
   -> fail nếu không thể tiếp tục tự động.

9. Màn hình khóa/mật mã thiết bị:
   -> fail.

10. Không nhận diện được màn hình:
   -> fail.
   -> không đoán.

Phải trả thêm:
"diagnosis": mô tả tối đa 300 ký tự.
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
  mode,
  failure,
}) {
  return `
MỤC TIÊU:
${limit(
  goal,
  3000
)}

=== INFO ===
${limit(
  str(info),
  6000
) || "Không có dữ liệu."}

=== HISTORY ===
${formatHistory(
  history
)}

=== CLIENT RULES ===
${formatRules(
  rules
)}

=== SYSTEM RULES ===
${SYSTEM_RULES}

${
  mode === "recover"
    ? buildRecoveryBlock(
        failure
      )
    : ""
}

Hãy quan sát screenshot.

Xác định:
- màn hình hiện tại
- control phù hợp
- dữ liệu cần dùng
- trạng thái loading
- trạng thái field
- action trước đó có hiệu quả hay không

Sau đó chỉ trả MỘT action tiếp theo.

Không chắc chắn:
-> wait trong normal mode nếu UI đang chuyển/loading.
-> fail trong recovery mode nếu không nhận diện được.

CHỈ TRẢ JSON.
`;
}

// ============================================================
// GEMINI
// ============================================================

async function callGemini({
  imageData,
  key,
  goal,
  info,
  rules,
  history,
  mode,
  failure,
}) {
  const requestBody = {
    systemInstruction: {
      parts: [
        {
          text:
            SYSTEM_PROMPT,
        },
      ],
    },

    contents: [
      {
        role: "user",

        parts: [
          {
            inlineData: {
              mimeType:
                imageData.mimeType,

              data:
                imageData.data,
            },
          },

          {
            text:
              buildPrompt({
                goal,
                info,
                rules,
                history,
                mode,
                failure,
              }),
          },
        ],
      },
    ],

    generationConfig: {
      temperature: 0,
      maxOutputTokens: 1024,
      responseMimeType:
        "application/json",
    },
  };

  const payload =
    JSON.stringify(
      requestBody
    );

  let response = null;
  let responseText = "";

  for (
    let attempt = 1;
    attempt <= ATTEMPTS;
    attempt++
  ) {
    const controller =
      new AbortController();

    const timer =
      setTimeout(
        () =>
          controller.abort(),
        TIMEOUT_MS
      );

    try {
      response =
        await fetch(
          geminiUrl(
            mode === "recover"
              ? RECOVER_MODEL
              : MODEL_ID
          ),
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",

              "x-goog-api-key":
                key,
            },

            body: payload,

            signal:
              controller.signal,
          }
        );

      responseText =
        await response.text();
    } catch (err) {
      if (
        attempt ===
        ATTEMPTS
      ) {
        throw err;
      }

      console.error(
        "[GEMINI NETWORK]",
        attempt,
        err?.message
      );

      await sleep(
        500 * attempt
      );

      continue;
    } finally {
      clearTimeout(
        timer
      );
    }

    if (
      response.ok
    ) {
      break;
    }

    console.error(
      `[GEMINI ${response.status}]`,
      responseText.slice(
        0,
        1000
      )
    );

    const retryable =
      response.status ===
        429 ||
      response.status >=
        500;

    if (
      !retryable ||
      attempt ===
        ATTEMPTS
    ) {
      break;
    }

    await sleep(
      600 * attempt
    );
  }

  let data = null;

  try {
    data =
      JSON.parse(
        responseText
      );
  } catch {
    throw httpError(
      "Gemini trả response không phải JSON: " +
        responseText.slice(
          0,
          300
        ),
      response?.status ||
        502
    );
  }

  if (
    !response.ok
  ) {
    throw httpError(
      data?.error?.message ||
        `Gemini HTTP ${response.status}`,
      response.status
    );
  }

  const candidate =
    data?.candidates?.[0];

  const parts =
    candidate?.content?.parts;

  if (
    !Array.isArray(parts)
  ) {
    const why =
      data?.promptFeedback
        ?.blockReason ||
      candidate?.finishReason ||
      "không rõ";

    throw httpError(
      `Gemini không trả content: ${why}`,
      502
    );
  }

  const text =
    parts
      .map(
        (p) =>
          p?.text || ""
      )
      .join("")
      .trim();

  if (!text) {
    throw httpError(
      "Gemini trả content rỗng.",
      502
    );
  }

  const json =
    extractJson(text);

  if (!json) {
    throw httpError(
      "Không parse được JSON Gemini: " +
        text.slice(
          0,
          500
        ),
      502
    );
  }

  return Array.isArray(
    json
  )
    ? json[0]
    : json;
}

// ============================================================
// ERROR
// ============================================================

function friendlyError(
  error
) {
  if (!error) {
    return "Lỗi không xác định.";
  }

  if (
    error.name ===
    "AbortError"
  ) {
    return "Gemini timeout.";
  }

  switch (true) {
    case error.status === 400:
      return (
        "Yêu cầu không hợp lệ: " +
        error.message
      );

    case error.status === 401:
      return "Gemini API key không hợp lệ.";

    case error.status === 403:
      return "Gemini API key không có quyền dùng model.";

    case error.status === 404:
      return (
        `Model "${MODEL_ID}" không tồn tại hoặc không hỗ trợ.`
      );

    case error.status === 429:
      return "Gemini hết quota hoặc bị rate limit.";

    case error.status >= 500:
      return (
        `Gemini server error ${error.status}.`
      );

    default:
      return str(
        error.message,
        "Lỗi không xác định."
      );
  }
}

function isFatal(
  error
) {
  return [
    400,
    401,
    403,
    404,
  ].includes(
    error?.status
  );
}

// ============================================================
// HANDLER
// ============================================================

export default async function handler(
  req,
  res
) {
  try {
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

    if (
      req.method ===
      "OPTIONS"
    ) {
      return res
        .status(200)
        .end();
    }

    if (
      req.method !==
      "POST"
    ) {
      return res
        .status(405)
        .json({
          success: false,
          error:
            "Method not allowed.",
        });
    }

    let body =
      req.body;

    if (
      typeof body ===
      "string"
    ) {
      try {
        body =
          JSON.parse(
            body
          );
      } catch {
        body = {};
      }
    }

    body =
      body || {};

    const key =
      body.key ||
      process.env
        .GEMINI_API_KEY;

    if (!key) {
      return res
        .status(200)
        .json({
          success: false,
          error:
            "Thiếu Gemini API key.",
          version:
            VERSION,
        });
    }

    const imageData =
      normalizeImage(
        body.image
      );

    const size =
      getImageSize(
        imageData.data
      );

    if (
      !size ||
      !size.width ||
      !size.height
    ) {
      throw httpError(
        "Không đọc được kích thước ảnh.",
        400
      );
    }

    const info =
      body.info || "";

    const mode =
      body.mode ===
      "recover"
        ? "recover"
        : "normal";

    const raw =
      await callGemini({
        imageData,
        key,

        goal:
          body.goal ||
          "Hoàn thành màn hình đăng ký hiện tại và chuyển sang bước tiếp theo.",

        info,

        rules:
          body.rules || [],

        history:
          body.history || [],

        mode,

        failure:
          body.failure || "",
      });

    const action =
      normalizeAction(
        raw,
        size,
        info
      );

    return res
      .status(200)
      .json({
        success: true,

        ...action,

        ...(mode ===
        "recover"
          ? {
              mode,
              diagnosis:
                limit(
                  raw?.diagnosis,
                  500
                ),
            }
          : {}),

        image_width:
          size.width,

        image_height:
          size.height,

        model:
          mode === "recover"
            ? RECOVER_MODEL
            : MODEL_ID,

        version:
          VERSION,
      });
  } catch (error) {
    const message =
      friendlyError(
        error
      );

    console.error(
      "[ANALYZE ERROR]",
      message
    );

    console.error(
      "[ANALYZE STACK]",
      error?.stack ||
        ""
    );

    try {
      if (
        isFatal(error)
      ) {
        return res
          .status(200)
          .json({
            success: false,

            error:
              message,

            model:
              MODEL_ID,

            version:
              VERSION,
          });
      }

      return res
        .status(200)
        .json({
          success: true,

          ...waitAction(
            message,
            3
          ),

          model:
            MODEL_ID,

          version:
            VERSION,
        });
    } catch {}
  }
}
