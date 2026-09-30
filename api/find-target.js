const { GoogleGenAI } = require('@google/genai');

// Khởi tạo Gemini với API Key được gán trực tiếp trong mã nguồn
const ai = new GoogleGenAI({ apiKey: "AQ.Ab8RN6KSlwWgrkmf6K6ZsAc9lr9CivV9C122iYmzquAZHoHQDA" });

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Chỉ hỗ trợ phương thức POST' });
    }

    try {
        const { image, target } = req.body;
        
        if (!image) {
            return res.status(400).json({ success: false, error: 'Thiếu dữ liệu ảnh' });
        }

        const imagePart = {
            inlineData: {
                data: image,
                mimeType: "image/png"
            },
        };

        const targetWord = target || "Họ";
        const prompt = `Đây là ảnh chụp màn hình điện thoại kích thước 750x1334. 
        Hãy tìm vị trí (tâm theo tọa độ pixel x, y trên màn hình này) của từ hoặc ô nhập liệu chứa chữ "${targetWord}".
        Chỉ trả về kết quả định dạng JSON thuần túy theo cấu trúc: {"found": true, "x": <số>, "y": <số>}. 
        Nếu không tìm thấy, trả về: {"found": false}. Không kèm theo bất kỳ định dạng markdown hay chữ giải thích nào khác.`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [prompt, imagePart],
        });

        const rawText = response.text.trim();
        const cleanJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        const jsonResult = JSON.parse(cleanJson);

        return res.status(200).json({ success: true, ...jsonResult });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
}
