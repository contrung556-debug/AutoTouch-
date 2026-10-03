// ============================================================
// AUTOTOUCH AGENT - FULL VERSION
// Password chỉ nhập 1 lần
//
// Integrated:
// - Supabase Họ/Tên
// - Random phone
// - Random password
// - Vision agent
// - Plan tap/type
// - Wheel date picker
// - QWERTY + Numpad
// - Password mixed letters/numbers
// - Jitter tap
// - Password guard: KHÔNG NHẬP LẠI
// ============================================================

const { exec, usleep, touchDown, touchMove, touchUp } = at;


// ============================================================
// BASIC UTILS
// ============================================================

function wait(ms) {
    ms = Number(ms) || 0;

    if (ms > 0) {
        usleep(Math.round(ms * 1000));
    }
}

function safeString(value) {
    return String(value == null ? "" : value);
}

function isFiniteNumber(v) {
    return typeof v === "number" && isFinite(v);
}

function clampNumber(v, min, max) {
    if (v < min) return min;
    if (v > max) return max;
    return v;
}


// ============================================================
// SERVER & GOAL
// ============================================================

const SERVER_URL =
    "https://apigemini-azure.vercel.app/api/analyze";

const GOAL =
    "Hoàn thành màn hình đăng ký hiện tại và chuyển sang bước tiếp theo.";


// ============================================================
// SUPABASE
// ============================================================

const SUPABASE_URL =
    "https://hopvaedxefekmojrqdzw.supabase.co";

// Giữ key hiện tại của bạn tại đây.
// Không log key ra console.
const SUPABASE_KEY =
    "THAY_SUPABASE_KEY_CUA_BAN";

const TABLE_NAME = "ho_ten";


// ============================================================
// TEST PHONE
// ============================================================

const TEST_PHONE = "";

const PHONE_WITHOUT_LEADING_ZERO = false;

const PHONE_PREFIXES = [
    "097",
    "086"
];

function randomPhoneForTest() {

    const prefix =
        PHONE_PREFIXES[
            Math.floor(
                Math.random() *
                PHONE_PREFIXES.length
            )
        ];

    let rest = "";

    for (let i = 0; i < 7; i++) {
        rest += Math.floor(
            Math.random() * 10
        );
    }

    const full =
        prefix + rest;

    return PHONE_WITHOUT_LEADING_ZERO
        ? full.substring(1)
        : full;
}

function getPhone() {

    const configured =
        safeString(TEST_PHONE).trim();

    return configured ||
        randomPhoneForTest();
}


// ============================================================
// RANDOM PASSWORD
// ============================================================

const PASSWORD_LENGTH = 12;

function randomPassword(length) {

    length =
        Number(length) ||
        PASSWORD_LENGTH;

    const upper =
        "ABCDEFGHJKLMNPQRSTUVWXYZ";

    const lower =
        "abcdefghijkmnopqrstuvwxyz";

    const digits =
        "23456789";

    const all =
        upper +
        lower +
        digits;

    let password = "";

    // Ít nhất 1 hoa
    password +=
        upper[
            Math.floor(
                Math.random() *
                upper.length
            )
        ];

    // Ít nhất 1 thường
    password +=
        lower[
            Math.floor(
                Math.random() *
                lower.length
            )
        ];

    // Ít nhất 1 số
    password +=
        digits[
            Math.floor(
                Math.random() *
                digits.length
            )
        ];

    while (
        password.length <
        length
    ) {

        password +=
            all[
                Math.floor(
                    Math.random() *
                    all.length
                )
            ];
    }

    const chars =
        password.split("");

    for (
        let i = chars.length - 1;
        i > 0;
        i--
    ) {

        const j =
            Math.floor(
                Math.random() *
                (i + 1)
            );

        const tmp =
            chars[i];

        chars[i] =
            chars[j];

        chars[j] =
            tmp;
    }

    return chars.join("");
}

function getPassword() {
    return randomPassword(
        PASSWORD_LENGTH
    );
}


// ============================================================
// SUPABASE NAME
// ============================================================

function splitHoTen(fullName) {

    const parts =
        safeString(fullName)
            .trim()
            .split(/\s+/);

    return {

        ho:
            parts[0] || "",

        ten:
            parts
                .slice(1)
                .join(" ") || ""
    };
}

function supabaseHeaders() {

    return (
        ' -H "apikey: ' +
        SUPABASE_KEY +
        '"' +

        ' -H "Authorization: Bearer ' +
        SUPABASE_KEY +
        '"'
    );
}

function getUnusedName() {

    if (
        !SUPABASE_KEY ||
        SUPABASE_KEY ===
            "THAY_SUPABASE_KEY_CUA_BAN"
    ) {

        throw new Error(
            "SUPABASE_KEY chưa được cấu hình."
        );
    }

    const getUrl =
        SUPABASE_URL +
        "/rest/v1/" +
        TABLE_NAME +
        "?select=id,ho_ten" +
        "&da_dung=eq.false" +
        "&limit=1";

    const getCmd =
        'curl -sS -m 30 "' +
        getUrl +
        '"' +
        supabaseHeaders();

    const raw =
        exec(getCmd);

    console.log(
        "[Supabase GET] " +
        safeString(raw)
            .substring(0, 500)
    );

    let rows;

    try {

        rows =
            JSON.parse(raw);

    } catch (e) {

        throw new Error(
            "Supabase trả JSON không hợp lệ: " +
            safeString(raw)
                .substring(0, 300)
        );
    }

    if (
        !Array.isArray(rows) ||
        rows.length === 0
    ) {

        throw new Error(
            "Không còn Họ Tên chưa dùng."
        );
    }

    const row =
        rows[0];

    if (
        !row ||
        !row.id ||
        !row.ho_ten
    ) {

        throw new Error(
            "Dòng Supabase không có id/ho_ten hợp lệ."
        );
    }

    return {

        id:
            row.id,

        ho_ten:
            safeString(row.ho_ten),

        ...splitHoTen(
            row.ho_ten
        )
    };
}

function markNameUsed(rowId) {

    if (!rowId) {

        throw new Error(
            "Thiếu rowId khi mark name."
        );
    }

    const patchUrl =
        SUPABASE_URL +
        "/rest/v1/" +
        TABLE_NAME +
        "?id=eq." +
        encodeURIComponent(rowId);

    const patchCmd =
        'curl -sS -m 30 -X PATCH "' +
        patchUrl +
        '"' +
        supabaseHeaders() +

        ' -H "Content-Type: application/json"' +

        ' -H "Prefer: return=minimal"' +

        ' -d \'{"da_dung":true}\'';

    const raw =
        exec(patchCmd);

    console.log(
        "[Supabase PATCH] " +
        safeString(raw)
            .substring(0, 300)
    );
}


// ============================================================
// INFO
// ============================================================

let INFO = "";


// ============================================================
// PASSWORD STATE
// ============================================================
//
// QUAN TRỌNG:
//
// passwordTyped = true ngay sau khi client thực sự type
// đúng password.
//
// Sau đó:
// - AI yêu cầu type password lần nữa -> KHÔNG TYPE.
// - Plan yêu cầu type password lần nữa -> KHÔNG TYPE.
// - Screenshot password bị mask/trống -> KHÔNG TYPE LẠI.
//
// ============================================================

let passwordTyped = false;


// ============================================================
// RULES
// ============================================================

const RULES = [

    "Không bấm vào quảng cáo.",

    "Không bấm vào banner quảng cáo.",

    "Không bấm vào liên kết có dấu hiệu mở website hoặc ứng dụng bên ngoài.",

    "Không thao tác với nội dung không liên quan đến mục tiêu đăng ký.",

    "Chỉ thao tác với phần giao diện cần thiết để hoàn thành GOAL.",


    // --------------------------------------------------------
    // LOADING
    // --------------------------------------------------------

    "LOADING / SPINNER:",

    "- Nếu button đang hiển thị spinner/loading indicator thay cho chữ, không coi spinner là text target.",

    "- Không click lại button đang ở trạng thái loading.",

    "- Nếu màn hình đang loading rõ ràng, ưu tiên action wait.",

    "- Không suy đoán button loading là button có thể bấm.",

    "- Chỉ thao tác khi có thể xác định rõ button đang ở trạng thái có thể bấm.",


    // --------------------------------------------------------
    // INPUT
    // --------------------------------------------------------

    "INPUT ĐÃ CÓ GIÁ TRỊ:",

    "- Nếu ô nhập đã chứa đúng dữ liệu mục tiêu thì KHÔNG type lại.",

    "- Không xóa rồi nhập lại input đã đúng nếu không cần.",

    "- Nếu input đang chứa một phần dữ liệu thì quan sát kỹ trước khi sửa.",

    "- Không tự thay đổi dữ liệu được phép dùng.",


    // --------------------------------------------------------
    // DATE WHEEL
    // --------------------------------------------------------

    "NGÀY SINH DẠNG BÁNH XE:",

    "- Không dùng tap hoặc type để chọn ngày/tháng/năm.",

    "- Chỉ dùng action wheel.",

    "- Mỗi action wheel chỉ chỉnh MỘT cột.",

    "- Thứ tự ưu tiên: năm trước, tháng sau, ngày cuối.",

    "- Giá trị đang chọn là dòng ở giữa/nền đậm.",

    "- So sánh giá trị hiện tại với ngày sinh trong INFO.",

    "- rows > 0 nghĩa là tăng giá trị.",

    "- rows < 0 nghĩa là giảm giá trị.",

    "- Sau mỗi wheel phải quan sát ảnh mới.",

    "- Không chỉnh cột tiếp theo khi cột hiện tại chưa xác nhận đúng.",

    "- Không tự bấm Tiếp khi ngày tháng năm chưa xác nhận đúng.",


    // --------------------------------------------------------
    // MULTI INPUT
    // --------------------------------------------------------

    "MÀN HÌNH NHIỀU Ô NHẬP:",

    "- Khi nhiều ô nhập cùng lúc, ví dụ Họ và Tên, dùng action plan.",

    "- Plan chỉ được chứa tap và type.",

    "- Nếu ô đầu tiên đã focus rõ ràng thì plan có thể bắt đầu bằng type.",

    "- Nếu ô chưa focus thì tap ô trước rồi type.",

    "- Không type rồi type liên tiếp.",

    "- Không tap rồi tap liên tiếp.",

    "- Mỗi ô chỉ điền một lần.",

    "- Không đưa nút Tiếp vào plan.",

    "- Sau plan phải chụp ảnh mới và kiểm tra lại.",

    "- Không type lại ô đã có đúng dữ liệu.",


    // --------------------------------------------------------
    // PHONE
    // --------------------------------------------------------

    "SỐ DI ĐỘNG:",

    "- Chỉ sử dụng đúng số nằm trong INFO.",

    "- Không tự thay đổi số.",

    "- Không tự thêm hoặc bỏ mã quốc gia.",

    "- Nếu app đã chọn +84 thì tuân theo định dạng INFO.",

    "- Nếu một ô số điện thoại thì có thể tap rồi type.",

    "- Nếu nhiều ô nhập cùng màn hình thì dùng plan.",

    "- Sau khi nhập số phải quan sát ảnh mới.",

    "- Chỉ bấm Tiếp/Gửi mã sau khi xác nhận số đã hiển thị đúng.",


    // --------------------------------------------------------
    // PASSWORD
    // --------------------------------------------------------

    "MẬT KHẨU - CHỈ NHẬP MỘT LẦN:",

    "- Nếu thấy ô Mật khẩu, Password, Create password hoặc ngữ cảnh rõ ràng là tạo mật khẩu, dùng đúng trường Mật khẩu trong INFO.",

    "- Không tự bịa mật khẩu.",

    "- Không tự sinh mật khẩu khác với INFO.",

    "- Chỉ nhập nguyên văn mật khẩu trong INFO.",

    "- Nếu ô chưa focus thì tap đúng ô rồi type.",

    "- Nếu ô đã focus thì type trực tiếp.",

    "- Nếu ô password hiển thị dấu chấm, dấu sao hoặc nhìn giống trống thì KHÔNG được suy luận rằng password chưa nhập.",

    "- Sau khi client đã nhập đúng password một lần thì KHÔNG nhập lại password.",

    "- Nếu màn hình sau đó vẫn hiển thị ô password bị che thì giữ nguyên trạng thái đã nhập.",

    "- Nếu server yêu cầu lại chính password sau khi đã nhập thì không type lại; phải quan sát màn hình mới và tìm bước tiếp theo.",

    "- Nếu có ô Nhập lại mật khẩu, Confirm password hoặc tương tự, không tự động nhập lần thứ hai chỉ vì ô đang nhìn trống; tuân theo trạng thái password đã nhập và quyết định của server.",

    "- Không lấy mật khẩu từ placeholder.",

    "- Không suy luận mật khẩu từ dấu chấm hoặc dấu sao.",

    "- Nếu INFO không có Mật khẩu thì không được tự tạo mật khẩu.",

    "- Sau khi nhập mật khẩu phải chụp ảnh mới và kiểm tra lại.",


    // --------------------------------------------------------
    // PLAN
    // --------------------------------------------------------

    "PLAN:",

    "- Chỉ được chứa tap và type.",

    "- Không chứa swipe.",

    "- Không chứa wheel.",

    "- Không chứa wait.",

    "- Không chứa nút Tiếp.",

    "- Không chứa action ngoài danh sách.",

    "- Mỗi vòng quan sát chỉ thực thi một action chính.",

    "- Sau action phải quan sát lại ảnh trước khi quyết định action tiếp theo.",

    "- Nếu password đã nhập thì plan không được type lại password."
];


// ============================================================
// LIMITS
// ============================================================

const MAX_STEPS = 30;

const SETTLE_MS = 1200;

const MAX_REPEAT = 3;

const MAX_WAIT_SECONDS = 10;

const MAX_PLAN_STEPS = 8;

const MAX_WHEEL_ROWS = 31;

const PLAN_AFTER_TAP_MS = 600;

const PLAN_AFTER_TYPE_MS = 400;

const WHEEL_STEP_DISTANCE = 83.48;

const WHEEL_STEP_COUNT = 24;

const WHEEL_START_Y = 0;

const TAP_SCREEN_WIDTH = 0;

const TAP_SCREEN_HEIGHT = 0;

const MAX_BASE64_LENGTH = 4000000;


// ============================================================
// FILES & GEMINI KEY
// ============================================================

const ROOT =
    String(at.rootDir())
        .replace(/\/+$/, "");

const SCREENSHOT_PATH =
    ROOT +
    "/agent_shot.png";

const PAYLOAD_PATH =
    ROOT +
    "/agent_payload.json";

const KEY_FILE =
    ROOT +
    "/gemini_key.txt";

function loadKey() {

    try {

        const out =
            exec(
                "cat '" +
                KEY_FILE +
                "' 2>/dev/null"
            );

        const key =
            String(out || "")
                .trim();

        if (
            key.length >= 20 &&
            key.length <= 200 &&
            /^[A-Za-z0-9_.-]+$/.test(key)
        ) {

            return key;
        }

    } catch (e) {}

    return "";
}

const GEMINI_API_KEY =
    loadKey();


// ============================================================
// TOUCH / TAP / SWIPE
// ============================================================

function doTap(x, y) {

    if (
        !isFiniteNumber(
            Number(x)
        ) ||
        !isFiniteNumber(
            Number(y)
        )
    ) {

        throw new Error(
            "Tọa độ tap không hợp lệ."
        );
    }

    x = Number(x);
    y = Number(y);

    const jitterX =
        x +
        (
            Math.random() * 12 -
            6
        );

    const jitterY =
        y +
        (
            Math.random() * 12 -
            6
        );

    touchDown(
        0,
        jitterX,
        jitterY
    );

    usleep(
        16000 +
        Math.random() * 20000
    );

    touchUp(
        0,
        jitterX,
        jitterY
    );
}

function doSwipe(
    x1,
    y1,
    x2,
    y2
) {

    if (
        !isFiniteNumber(
            Number(x1)
        ) ||
        !isFiniteNumber(
            Number(y1)
        ) ||
        !isFiniteNumber(
            Number(x2)
        ) ||
        !isFiniteNumber(
            Number(y2)
        )
    ) {

        throw new Error(
            "Tọa độ swipe không hợp lệ."
        );
    }

    at.swipe(
        Number(x1),
        Number(y1),
        Number(x2),
        Number(y2)
    );
}


// ============================================================
// KEYBOARDS
// ============================================================

const NUM_KEYS = {

    "1": {
        x: 157.04,
        y: 964.61
    },

    "2": {
        x: 415.68,
        y: 986.01
    },

    "3": {
        x: 635.34,
        y: 952.40
    },

    "4": {
        x: 197.07,
        y: 1078.64
    },

    "5": {
        x: 413.64,
        y: 1071.52
    },

    "6": {
        x: 642.52,
        y: 1055.24
    },

    "7": {
        x: 174.49,
        y: 1164.18
    },

    "8": {
        x: 417.74,
        y: 1179.44
    },

    "9": {
        x: 645.60,
        y: 1160.11
    },

    "0": {
        x: 418.76,
        y: 1271.08
    }
};


const KEY_COORDS = {

    q:{x:34.89,y:959.52},
    w:{x:106.74,y:959.52},
    e:{x:175.51,y:975.81},
    r:{x:261.73,y:971.74},
    t:{x:322.29,y:962.58},
    y:{x:414.67,y:950.37},
    u:{x:495.75,y:942.22},
    i:{x:547.06,y:975.81},
    o:{x:631.23,y:957.49},
    p:{x:713.34,y:943.24},

    a:{x:62.60,y:1086.79},
    s:{x:144.72,y:1082.71},
    d:{x:230.93,y:1068.47},
    f:{x:316.12,y:1069.48},
    g:{x:368.48,y:1075.59},
    h:{x:431.09,y:1078.64},
    j:{x:524.48,y:1071.52},
    k:{x:595.31,y:1069.48},
    l:{x:708.21,y:1056.25},

    z:{x:162.16,y:1188.60},
    x:{x:241.20,y:1182.50},
    c:{x:303.81,y:1189.62},
    v:{x:378.73,y:1172.32},
    b:{x:441.34,y:1181.48},
    n:{x:528.59,y:1178.43},
    m:{x:608.65,y:1170.28}
};


const SHIFT = {
    x: 70.82,
    y: 1188.60
};

const BACKSPACE = {
    x: 712.31,
    y: 1178.43
};

const SPACE = {
    x: 420.82,
    y: 1299.58
};


function tapKey(letter) {

    const lower =
        safeString(letter)
            .toLowerCase();

    const isUpper =
        letter !== lower &&
        /[A-Z]/.test(letter);

    if (isUpper) {

        doTap(
            SHIFT.x,
            SHIFT.y
        );

        usleep(
            120000 +
            Math.random() * 50000
        );
    }

    const coord =
        KEY_COORDS[lower];

    if (!coord) {

        throw new Error(
            "Không có tọa độ keyboard cho: " +
            letter
        );
    }

    doTap(
        coord.x,
        coord.y
    );
}


// ============================================================
// TYPE NUMBER
// ============================================================

function typeNumberString(
    digits
) {

    for (
        const digit of digits
    ) {

        const k =
            NUM_KEYS[digit];

        if (!k) {

            throw new Error(
                "Không có tọa độ Numpad cho: " +
                digit
            );
        }

        doTap(
            k.x,
            k.y
        );

        wait(
            150 +
            Math.random() * 100
        );
    }
}


// ============================================================
// VIETNAMESE TELEX
// ============================================================

function charToTelexKeys(ch) {

    if (ch === "đ") {
        return ["d", "d"];
    }

    if (ch === "Đ") {
        return ["D", "d"];
    }

    const isUpper =
        ch !== ch.toLowerCase();

    const nfd =
        ch.normalize("NFD");

    const first =
        nfd[0];

    if (!first) {
        return [];
    }

    const baseChar =
        isUpper
            ? first.toUpperCase()
            : first.toLowerCase();

    const baseLower =
        first.toLowerCase();

    const marks =
        nfd.slice(1);

    let modKey = "";

    let toneKey = "";

    for (
        let i = 0;
        i < marks.length;
        i++
    ) {

        const m =
            marks[i];

        if (
            m === "\u0300"
        ) {
            toneKey = "f";

        } else if (
            m === "\u0301"
        ) {
            toneKey = "s";

        } else if (
            m === "\u0303"
        ) {
            toneKey = "x";

        } else if (
            m === "\u0309"
        ) {
            toneKey = "r";

        } else if (
            m === "\u0323"
        ) {
            toneKey = "j";

        } else if (
            m === "\u0302"
        ) {
            modKey =
                baseLower;

        } else if (
            m === "\u0306" ||
            m === "\u031B"
        ) {
            modKey = "w";
        }
    }

    const keys = [
        baseChar
    ];

    if (modKey) {
        keys.push(modKey);
    }

    if (toneKey) {
        keys.push(toneKey);
    }

    return keys;
}


function typeVietnameseTelex(
    text,
    options
) {

    options =
        options || {};

    const minDelay =
        options.minDelay ||
        250;

    const maxDelay =
        options.maxDelay ||
        500;

    function randomDelay() {

        return (
            minDelay +
            Math.random() *
            (
                maxDelay -
                minDelay
            )
        );
    }

    text =
        safeString(text);

    for (
        let i = 0;
        i < text.length;
        i++
    ) {

        const ch =
            text[i];

        if (ch === " ") {

            doTap(
                SPACE.x,
                SPACE.y
            );

            usleep(
                randomDelay() *
                1000
            );

            continue;
        }

        const keys =
            charToTelexKeys(ch);

        for (
            let k = 0;
            k < keys.length;
            k++
        ) {

            tapKey(
                keys[k]
            );

            usleep(
                randomDelay() *
                1000
            );
        }
    }
}


// ============================================================
// PASSWORD CHECK
// ============================================================

function isPasswordText(text) {

    text =
        safeString(text);

    if (!text) {
        return false;
    }

    const password =
        extractPasswordFromInfo();

    if (!password) {
        return false;
    }

    return text === password;
}


function extractPasswordFromInfo() {

    const marker =
        "Mật khẩu: ";

    const index =
        INFO.indexOf(marker);

    if (index < 0) {
        return "";
    }

    return INFO
        .substring(
            index + marker.length
        )
        .split("\n")[0]
        .trim();
}


// ============================================================
// TYPE - HỖ TRỢ CHỮ + SỐ
// ============================================================

function doType(text) {

    text =
        safeString(text);

    if (!text) {

        throw new Error(
            "Type text rỗng."
        );
    }

    // --------------------------------------------------------
    // PASSWORD GUARD
    // --------------------------------------------------------

    if (
        isPasswordText(text)
    ) {

        if (passwordTyped) {

            throw new Error(
                "Password đã nhập rồi - không nhập lại."
            );
        }
    }


    // --------------------------------------------------------
    // TOÀN SỐ
    // --------------------------------------------------------

    if (/^\d+$/.test(text)) {

        typeNumberString(
            text
        );

        return;
    }


    // --------------------------------------------------------
    // HỖN HỢP CHỮ + SỐ
    // --------------------------------------------------------

    for (
        let i = 0;
        i < text.length;
        i++
    ) {

        const ch =
            text[i];

        // Số
        if (/\d/.test(ch)) {

            const k =
                NUM_KEYS[ch];

            if (!k) {

                throw new Error(
                    "Không có tọa độ numpad cho: " +
                    ch
                );
            }

            doTap(
                k.x,
                k.y
            );

            wait(
                150 +
                Math.random() * 100
            );

            continue;
        }

        // Space
        if (ch === " ") {

            doTap(
                SPACE.x,
                SPACE.y
            );

            wait(
                200 +
                Math.random() * 150
            );

            continue;
        }

        // Chữ
        const keys =
            charToTelexKeys(ch);

        if (!keys.length) {

            throw new Error(
                "Không thể nhập ký tự: " +
                ch
            );
        }

        for (
            let k = 0;
            k < keys.length;
            k++
        ) {

            tapKey(
                keys[k]
            );

            wait(
                250 +
                Math.random() * 250
            );
        }
    }


    // --------------------------------------------------------
    // PASSWORD SUCCESS
    // --------------------------------------------------------

    if (
        isPasswordText(text)
    ) {

        passwordTyped =
            true;

        console.log(
            "[PASSWORD] Đã nhập password 1 lần."
        );

        at.toast(
            "Password đã nhập",
            2
        );
    }
}


// ============================================================
// WHEEL
// ============================================================

function scrollOneStep(
    x,
    startY,
    direction
) {

    const swipeSign =
        direction > 0
            ? -1
            : 1;

    const totalDistance =
        WHEEL_STEP_DISTANCE *
        swipeSign;

    let currentY =
        startY;

    touchDown(
        0,
        x,
        startY
    );

    for (
        let i = 1;
        i <= WHEEL_STEP_COUNT;
        i++
    ) {

        const t =
            i /
            WHEEL_STEP_COUNT;

        const eased =
            1 -
            Math.pow(
                1 - t,
                3
            );

        currentY =
            startY +
            totalDistance *
            eased;

        usleep(
            16000 +
            Math.random() * 2000
        );

        touchMove(
            0,
            x,
            currentY
        );
    }

    usleep(20000);

    touchUp(
        0,
        x,
        currentY
    );
}


function scrollSteps(
    x,
    startY,
    delta
) {

    delta =
        Number(delta);

    if (
        !isFiniteNumber(delta) ||
        !Number.isInteger(delta)
    ) {

        throw new Error(
            "Wheel rows không hợp lệ."
        );
    }

    if (
        delta === 0 ||
        Math.abs(delta) >
            MAX_WHEEL_ROWS
    ) {

        throw new Error(
            "Wheel rows vượt giới hạn."
        );
    }

    const dir =
        delta > 0
            ? 1
            : -1;

    const count =
        Math.abs(delta);

    for (
        let i = 0;
        i < count;
        i++
    ) {

        scrollOneStep(
            x,
            startY,
            dir
        );

        usleep(
            350000 +
            Math.random() * 200000
        );
    }
}


// ============================================================
// FILE UTILITIES
// ============================================================

function readBase64(path) {

    const commands = [

        "base64 -i '" +
        path +
        "'",

        "openssl base64 -A -in '" +
        path +
        "'",

        "base64 '" +
        path +
        "'"
    ];

    for (
        let i = 0;
        i < commands.length;
        i++
    ) {

        try {

            const output =
                exec(
                    commands[i]
                );

            if (!output) {
                continue;
            }

            const clean =
                String(output)
                    .replace(/\s/g, "");

            if (
                clean.length > 100 &&
                /^[A-Za-z0-9+/=]+$/.test(
                    clean
                )
            ) {

                return clean;
            }

        } catch (e) {}
    }

    return null;
}


function writeFile(
    path,
    data
) {

    try {

        if (
            typeof fs !==
                "undefined" &&
            fs.writeFile
        ) {

            fs.writeFile(
                path,
                data
            );

            return true;
        }

    } catch (e) {}


    try {

        const escaped =
            String(data)
                .replace(
                    /'/g,
                    "'\\''"
                );

        exec(
            "printf '%s' '" +
            escaped +
            "' > '" +
            path +
            "'"
        );

        return true;

    } catch (e) {

        return false;
    }
}


function removeFile(path) {

    try {

        if (
            typeof fs !==
                "undefined" &&
            fs.remove
        ) {

            fs.remove(path);

            return;
        }

    } catch (e) {}

    try {

        exec(
            "rm -f '" +
            path +
            "'"
        );

    } catch (e) {}
}


// ============================================================
// SERVER COMMUNICATION
// ============================================================

function callServer(
    base64Image,
    history
) {

    const payload =
        JSON.stringify({

            image:
                "data:image/png;base64," +
                base64Image,

            key:
                GEMINI_API_KEY,

            goal:
                GOAL,

            info:
                INFO,

            rules:
                RULES,

            history:
                history
        });


    if (
        !writeFile(
            PAYLOAD_PATH,
            payload
        )
    ) {

        return {

            status: 0,

            text:
                "Không ghi được payload"
        };
    }


    const command =
        "curl -sS -m 90 " +
        "-X POST " +
        "-H 'Content-Type: application/json' " +
        "--data-binary @'" +
        PAYLOAD_PATH +
        "' " +
        "-w '\\n%{http_code}' " +
        "'" +
        SERVER_URL +
        "' 2>&1";


    let output = "";

    try {

        output =
            exec(command);

    } catch (e) {

        removeFile(
            PAYLOAD_PATH
        );

        return {

            status: 0,

            text:
                safeString(e)
        };
    }


    removeFile(
        PAYLOAD_PATH
    );

    output =
        safeString(output);


    const index =
        output.lastIndexOf("\n");


    if (index < 0) {

        return {

            status: 0,

            text:
                output
        };
    }


    const status =
        parseInt(
            output.substring(
                index + 1
            ),
            10
        );


    return {

        status:
            isNaN(status)
                ? 0
                : status,

        text:
            output.substring(
                0,
                index
            )
    };
}


// ============================================================
// JSON & COORDINATES
// ============================================================

function parseJson(text) {

    const raw =
        safeString(text)
            .trim();

    try {

        return JSON.parse(
            raw
        );

    } catch (e) {}


    const first =
        raw.indexOf("{");

    const last =
        raw.lastIndexOf("}");


    if (
        first >= 0 &&
        last > first
    ) {

        try {

            return JSON.parse(
                raw.substring(
                    first,
                    last + 1
                )
            );

        } catch (e2) {}
    }


    return null;
}


function toTap(
    x,
    y,
    imgW,
    imgH
) {

    x =
        Number(x);

    y =
        Number(y);

    imgW =
        Number(imgW);

    imgH =
        Number(imgH);


    if (
        !isFiniteNumber(x) ||
        !isFiniteNumber(y)
    ) {

        throw new Error(
            "AI trả tọa độ không hợp lệ."
        );
    }


    let sx = 1;

    let sy = 1;


    if (
        TAP_SCREEN_WIDTH > 0 &&
        imgW > 0
    ) {

        sx =
            TAP_SCREEN_WIDTH /
            imgW;
    }


    if (
        TAP_SCREEN_HEIGHT > 0 &&
        imgH > 0
    ) {

        sy =
            TAP_SCREEN_HEIGHT /
            imgH;
    }


    return {

        x:
            Math.round(
                x * sx
            ),

        y:
            Math.round(
                y * sy
            )
    };
}


// ============================================================
// VALIDATION
// ============================================================

function validateCoordinate(
    x,
    y
) {

    if (
        !isFiniteNumber(
            Number(x)
        ) ||
        !isFiniteNumber(
            Number(y)
        )
    ) {

        return false;
    }


    if (
        Number(x) < -100 ||
        Number(y) < -100
    ) {

        return false;
    }


    return true;
}


// ============================================================
// PLAN VALIDATION
// ============================================================

function validatePlan(
    steps
) {

    if (
        !Array.isArray(steps)
    ) {

        return false;
    }


    if (
        steps.length < 1 ||
        steps.length >
            MAX_PLAN_STEPS
    ) {

        return false;
    }


    for (
        let i = 0;
        i < steps.length;
        i++
    ) {

        const st =
            steps[i];

        if (!st) {
            return false;
        }


        if (
            st.action !== "tap" &&
            st.action !== "type"
        ) {

            return false;
        }


        // ----------------------------------------------------
        // TAP
        // ----------------------------------------------------

        if (
            st.action === "tap"
        ) {

            if (
                !validateCoordinate(
                    st.x,
                    st.y
                )
            ) {

                return false;
            }


            if (
                i > 0 &&
                steps[i - 1].action ===
                    "tap"
            ) {

                return false;
            }
        }


        // ----------------------------------------------------
        // TYPE
        // ----------------------------------------------------

        if (
            st.action === "type"
        ) {

            const txt =
                safeString(
                    st.text
                );


            if (
                !txt ||
                txt.length > 300
            ) {

                return false;
            }


            if (
                i > 0 &&
                steps[i - 1].action !==
                    "tap"
            ) {

                return false;
            }


            // Chỉ type dữ liệu nằm trong INFO.
            if (
                INFO.indexOf(txt) < 0
            ) {

                return false;
            }


            // ------------------------------------------------
            // PASSWORD GUARD
            // ------------------------------------------------

            if (
                isPasswordText(txt) &&
                passwordTyped
            ) {

                console.log(
                    "[PLAN BLOCK] Password đã nhập, không nhập lại."
                );

                return false;
            }
        }
    }


    return true;
}


// ============================================================
// EXECUTE PLAN
// ============================================================

function executePlan(r) {

    const steps =
        r.steps;


    if (
        !validatePlan(
            steps
        )
    ) {

        throw new Error(
            "Plan không hợp lệ."
        );
    }


    let sig =
        "plan";


    for (
        let i = 0;
        i < steps.length;
        i++
    ) {

        const st =
            steps[i];


        // ----------------------------------------------------
        // TAP
        // ----------------------------------------------------

        if (
            st.action === "tap"
        ) {

            const p =
                toTap(
                    st.x,
                    st.y,
                    r.image_width,
                    r.image_height
                );


            at.toast(
                "Plan " +
                (i + 1) +
                "/" +
                steps.length +
                ": tap",
                1
            );


            doTap(
                p.x,
                p.y
            );


            sig +=
                ":t" +
                Math.round(
                    p.x / 20
                ) +
                "," +
                Math.round(
                    p.y / 20
                );


            wait(
                PLAN_AFTER_TAP_MS
            );
        }


        // ----------------------------------------------------
        // TYPE
        // ----------------------------------------------------

        else if (
            st.action === "type"
        ) {

            const text =
                safeString(
                    st.text
                );


            // Password guard lần cuối.
            if (
                isPasswordText(text) &&
                passwordTyped
            ) {

                throw new Error(
                    "Password đã nhập trước đó, plan không được nhập lại."
                );
            }


            at.toast(
                "Plan " +
                (i + 1) +
                "/" +
                steps.length +
                ": nhập",
                1
            );


            doType(
                text
            );


            sig +=
                ":y" +
                text.length;


            wait(
                PLAN_AFTER_TYPE_MS
            );
        }
    }


    return sig;
}


// ============================================================
// RUN ONE STEP
// ============================================================

function runStep(history) {

    // --------------------------------------------------------
    // SCREENSHOT
    // --------------------------------------------------------

    at.screenshot(
        SCREENSHOT_PATH
    );

    wait(300);


    const base64Image =
        readBase64(
            SCREENSHOT_PATH
        );


    removeFile(
        SCREENSHOT_PATH
    );


    if (!base64Image) {

        at.toast(
            "Không đọc được screenshot",
            4
        );

        return {
            stop: true
        };
    }


    if (
        base64Image.length >
        MAX_BASE64_LENGTH
    ) {

        at.toast(
            "Ảnh quá lớn",
            5
        );

        return {
            stop: true
        };
    }


    // --------------------------------------------------------
    // SERVER
    // --------------------------------------------------------

    const response =
        callServer(
            base64Image,
            history
        );


    if (
        response.status !== 200
    ) {

        at.toast(
            "HTTP " +
            response.status +
            ": " +
            safeString(
                response.text
            ).substring(
                0,
                150
            ),
            5
        );

        return {
            stop: true
        };
    }


    // --------------------------------------------------------
    // JSON
    // --------------------------------------------------------

    const r =
        parseJson(
            response.text
        );


    if (
        !r ||
        r.success !== true
    ) {

        at.toast(
            "AI response lỗi: " +
            safeString(
                r && r.error
                    ? r.error
                    : response.text
            ).substring(
                0,
                150
            ),
            5
        );

        return {
            stop: true
        };
    }


    const action =
        safeString(
            r.action
        ).toLowerCase();


    const reason =
        safeString(
            r.reason
        );


    // ========================================================
    // DONE
    // ========================================================

    if (
        action === "done"
    ) {

        at.toast(
            "Hoàn thành: " +
            reason,
            4
        );

        return {

            stop: true,

            completed: true
        };
    }


    // ========================================================
    // FAIL
    // ========================================================

    if (
        action === "fail"
    ) {

        at.toast(
            "AI dừng: " +
            reason,
            5
        );

        return {
            stop: true
        };
    }


    // ========================================================
    // WAIT
    // ========================================================

    if (
        action === "wait"
    ) {

        let secs =
            Number(
                r.seconds
            );


        if (
            !isFiniteNumber(secs) ||
            secs <= 0
        ) {

            secs = 2;
        }


        secs =
            clampNumber(
                secs,
                1,
                MAX_WAIT_SECONDS
            );


        at.toast(
            "Chờ " +
            secs +
            "s: " +
            reason,
            2
        );


        wait(
            secs * 1000
        );


        return {

            stop: false,

            note:
                "wait " +
                secs +
                "s: " +
                reason,

            signature:
                "wait"
        };
    }


    // ========================================================
    // TAP
    // ========================================================

    if (
        action === "tap"
    ) {

        if (
            !validateCoordinate(
                r.x,
                r.y
            )
        ) {

            at.toast(
                "AI trả tọa độ tap lỗi",
                5
            );

            return {
                stop: true
            };
        }


        const p =
            toTap(
                r.x,
                r.y,
                r.image_width,
                r.image_height
            );


        at.toast(
            "Tap " +
            p.x +
            "," +
            p.y,
            1
        );


        doTap(
            p.x,
            p.y
        );


        return {

            stop: false,

            note:
                "tap (" +
                p.x +
                "," +
                p.y +
                "): " +
                reason,

            signature:
                "tap:" +
                Math.round(
                    p.x / 20
                ) +
                ":" +
                Math.round(
                    p.y / 20
                )
        };
    }


    // ========================================================
    // SWIPE
    // ========================================================

    if (
        action === "swipe"
    ) {

        if (
            !validateCoordinate(
                r.x,
                r.y
            ) ||
            !validateCoordinate(
                r.x2,
                r.y2
            )
        ) {

            at.toast(
                "AI trả tọa độ swipe lỗi",
                5
            );

            return {
                stop: true
            };
        }


        const a =
            toTap(
                r.x,
                r.y,
                r.image_width,
                r.image_height
            );


        const b =
            toTap(
                r.x2,
                r.y2,
                r.image_width,
                r.image_height
            );


        at.toast(
            "Swipe",
            1
        );


        doSwipe(
            a.x,
            a.y,
            b.x,
            b.y
        );


        return {

            stop: false,

            note:
                "swipe (" +
                a.x +
                "," +
                a.y +
                ")->(" +
                b.x +
                "," +
                b.y +
                "): " +
                reason,

            signature:
                "swipe:" +
                Math.round(
                    a.x / 20
                ) +
                ":" +
                Math.round(
                    a.y / 20
                ) +
                ":" +
                Math.round(
                    b.x / 20
                ) +
                ":" +
                Math.round(
                    b.y / 20
                )
        };
    }


    // ========================================================
    // PLAN
    // ========================================================

    if (
        action === "plan"
    ) {

        try {

            const sig =
                executePlan(r);


            return {

                stop: false,

                note:
                    "plan " +
                    r.steps.length +
                    " bước: " +
                    reason,

                signature:
                    sig
            };

        } catch (e) {

            at.toast(
                "Plan lỗi: " +
                safeString(
                    e.message || e
                ).substring(
                    0,
                    120
                ),
                5
            );


            return {
                stop: true
            };
        }
    }


    // ========================================================
    // WHEEL
    // ========================================================

    if (
        action === "wheel"
    ) {

        if (
            !validateCoordinate(
                r.x,
                r.y
            )
        ) {

            at.toast(
                "Wheel tọa độ lỗi",
                5
            );

            return {
                stop: true
            };
        }


        const rows =
            Number(
                r.rows
            );


        if (
            !isFiniteNumber(rows) ||
            !Number.isInteger(rows) ||
            rows === 0 ||
            Math.abs(rows) >
                MAX_WHEEL_ROWS
        ) {

            at.toast(
                "Wheel rows không hợp lệ",
                5
            );

            return {
                stop: true
            };
        }


        const a =
            toTap(
                r.x,
                r.y,
                r.image_width,
                r.image_height
            );


        const startY =
            WHEEL_START_Y > 0
                ? WHEEL_START_Y
                : a.y;


        at.toast(
            "Cuộn " +
            rows +
            " nấc",
            1
        );


        scrollSteps(
            a.x,
            startY,
            rows
        );


        wait(400);


        return {

            stop: false,

            note:
                "wheel (" +
                a.x +
                "," +
                startY +
                ") rows=" +
                rows +
                ": " +
                reason,

            signature:
                "wheel:" +
                Math.round(
                    a.x / 20
                ) +
                ":" +
                rows
        };
    }


    // ========================================================
    // TYPE
    // ========================================================

    if (
        action === "type"
    ) {

        const text =
            safeString(
                r.text
            );


        if (!text) {

            at.toast(
                "AI trả text rỗng",
                5
            );

            return {
                stop: true
            };
        }


        if (
            text.length > 300
        ) {

            at.toast(
                "Text quá dài",
                5
            );

            return {
                stop: true
            };
        }


        // ----------------------------------------------------
        // INFO GUARD
        // ----------------------------------------------------

        if (
            INFO.indexOf(text) < 0
        ) {

            at.toast(
                "Text không nằm trong INFO",
                5
            );

            return {
                stop: true
            };
        }


        // ----------------------------------------------------
        // PASSWORD GUARD
        // ----------------------------------------------------

        if (
            isPasswordText(text)
        ) {

            // Password đã nhập rồi:
            // KHÔNG type lại.
            //
            // Không stop agent.
            // Ghi history để server biết rằng
            // password đã được nhập và cần
            // chuyển sang bước tiếp theo.

            if (passwordTyped) {

                at.toast(
                    "Password đã nhập - bỏ qua type lại",
                    2
                );

                return {

                    stop: false,

                    note:
                        "password đã nhập trước đó; không nhập lại; tiếp tục quan sát bước kế tiếp",

                    signature:
                        "password-already-typed"
                };
            }
        }


        // ----------------------------------------------------
        // TYPE
        // ----------------------------------------------------

        at.toast(
            "Nhập text",
            1
        );


        doType(
            text
        );


        // ----------------------------------------------------
        // PASSWORD HISTORY
        // ----------------------------------------------------

        if (
            isPasswordText(text)
        ) {

            passwordTyped =
                true;

            return {

                stop: false,

                note:
                    "đã nhập Mật khẩu đúng 1 lần; không được nhập lại; quan sát màn hình tiếp theo",

                signature:
                    "password-typed-once"
            };
        }


        return {

            stop: false,

            note:
                "type text: " +
                reason,

            signature:
                "type:" +
                text.length
        };
    }


    // ========================================================
    // INVALID ACTION
    // ========================================================

    at.toast(
        "Action không hợp lệ: " +
        action,
        5
    );


    return {
        stop: true
    };
}


// ============================================================
// MAIN AGENT LOOP
// ============================================================

let nameRowId =
    null;

let completed =
    false;


try {

    // --------------------------------------------------------
    // GEMINI KEY
    // --------------------------------------------------------

    if (!GEMINI_API_KEY) {

        at.toast(
            "Không đọc được Gemini key từ " +
            KEY_FILE,
            6
        );

        throw new Error(
            "Thiếu GEMINI_API_KEY"
        );
    }


    // --------------------------------------------------------
    // DATA
    // --------------------------------------------------------

    const phone =
        getPhone();


    const password =
        getPassword();


    // --------------------------------------------------------
    // SUPABASE NAME
    // --------------------------------------------------------

    at.toast(
        "Đang lấy Họ Tên...",
        2
    );


    const nameResult =
        getUnusedName();


    nameRowId =
        nameResult.id;


    console.log(
        "Họ Tên: " +
        nameResult.ho +
        " " +
        nameResult.ten
    );


    // --------------------------------------------------------
    // INFO
    // --------------------------------------------------------

    INFO =
        "Họ: " +
        nameResult.ho +
        "\n" +

        "Tên: " +
        nameResult.ten +
        "\n" +

        "Ngày sinh: 15/06/1995" +
        "\n" +

        "Số di động: " +
        phone +
        "\n" +

        "Mật khẩu: " +
        password;


    // --------------------------------------------------------
    // PASSWORD STATE
    // --------------------------------------------------------

    passwordTyped =
        false;


    at.toast(
        "Đã chuẩn bị dữ liệu",
        2
    );


    // --------------------------------------------------------
    // HISTORY
    // --------------------------------------------------------

    const history = [];


    let lastSignature =
        "";

    let repeat =
        0;


    // ========================================================
    // AGENT LOOP
    // ========================================================

    for (
        let step = 1;
        step <= MAX_STEPS;
        step++
    ) {

        at.toast(
            "Bước " +
            step +
            "/" +
            MAX_STEPS,
            1
        );


        const out =
            runStep(
                history
            );


        if (
            out.stop
        ) {

            if (
                out.completed
            ) {

                completed =
                    true;
            }

            break;
        }


        // ----------------------------------------------------
        // HISTORY
        // ----------------------------------------------------

        if (
            out.note
        ) {

            history.push(
                step +
                ". " +
                out.note
            );
        }


        if (
            history.length > 10
        ) {

            history.shift();
        }


        // ----------------------------------------------------
        // REPEAT DETECTION
        // ----------------------------------------------------

        if (
            out.signature ===
            lastSignature
        ) {

            repeat++;

        } else {

            repeat = 1;

            lastSignature =
                out.signature;
        }


        // ----------------------------------------------------
        // PASSWORD SPECIAL CASE
        // ----------------------------------------------------
        //
        // Nếu server cố yêu cầu password
        // lần thứ 2 liên tiếp, không stop ngay.
        //
        // Cho server thêm một vòng screenshot
        // để nhận biết password đã nhập.
        //
        // ----------------------------------------------------

        if (
            repeat >= MAX_REPEAT &&
            out.signature !== "wait" &&
            out.signature !==
                "password-already-typed"
        ) {

            at.toast(
                "Dừng: hành động lặp " +
                repeat +
                " lần",
                5
            );

            break;
        }


        // ----------------------------------------------------
        // SETTLE
        // ----------------------------------------------------

        wait(
            SETTLE_MS
        );


        if (
            step === MAX_STEPS
        ) {

            at.toast(
                "Đã đạt MAX_STEPS",
                4
            );
        }
    }


    // ========================================================
    // MARK NAME USED
    // ========================================================

    // Chỉ đánh dấu tên khi server/AI báo DONE.
    if (
        completed &&
        nameRowId
    ) {

        try {

            markNameUsed(
                nameRowId
            );

            console.log(
                "Đã đánh dấu tên đã dùng."
            );

        } catch (markError) {

            console.log(
                "[WARN] Không mark được tên: " +
                safeString(
                    markError.message ||
                    markError
                )
            );
        }
    }


} catch (e) {

    at.toast(
        "Lỗi: " +
        safeString(
            e.message || e
        ).substring(
            0,
            180
        ),
        6
    );


    console.log(
        "[FATAL] " +
        safeString(
            e.message || e
        )
    );


} finally {

    try {

        at.stop();

    } catch (e2) {}
}
