"""AI-assisted extraction for photographed factory work orders."""
import json
import os
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
MAX_IMAGE_DATA_LENGTH = 8_000_000

DOCUMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "documentType": {"type": "string"},
        "supplier": {"type": "string"},
        "customer": {"type": "string"},
        "orderNumber": {"type": "string"},
        "orderDate": {"type": "string"},
        "deliveryDate": {"type": "string"},
        "productName": {"type": "string"},
        "destination": {"type": "string"},
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "description": {"type": "string"},
                    "quantity": {"type": "number"},
                    "sizeLength": {"type": "number"},
                    "sizeWidth": {"type": "number"},
                    "sizeUnit": {"type": "string", "enum": ["mm", "cm", "inch", "tai-inch", ""]},
                    "glossType": {"type": "string"},
                    "notes": {"type": "string"},
                    "confidence": {"type": "number"},
                },
                "required": [
                    "description", "quantity", "sizeLength", "sizeWidth",
                    "sizeUnit", "glossType", "notes", "confidence",
                ],
                "additionalProperties": False,
            },
        },
        "warnings": {"type": "array", "items": {"type": "string"}},
    },
    "required": [
        "documentType", "supplier", "customer", "orderNumber", "orderDate",
        "deliveryDate", "productName", "destination", "items", "warnings",
    ],
    "additionalProperties": False,
}

EXTRACTION_PROMPT = """你是台灣印刷與上光工廠的單據辨識助手。
閱讀照片中的工單、加工單或工作傳票，忽略電話、統編等不需要輸入工單的個資。
照片可能旋轉、傾斜、含手寫字，且同一張單可能有多筆加工項目。
請抽取工單號碼、日期、交期、客戶、送達地點、產品名稱，以及每一筆加工項目的數量、尺寸、單位、上光方式與備註。
民國年請換成西元 YYYY-MM-DD。尺寸若寫 26*38 台寸，單位用 tai-inch；英吋用 inch。
不要猜測看不清楚的內容；缺失值使用空字串或 0，並在 warnings 說明。
confidence 使用 0 到 1，表示該項目整體辨識信心。"""


class DocumentAIError(Exception):
    pass


def _response_text(payload):
    for item in payload.get("output", []):
        if item.get("type") != "message":
            continue
        for content in item.get("content", []):
            if content.get("type") == "output_text":
                return content.get("text", "")
    raise DocumentAIError("AI did not return extracted text")


def analyze_document_image(image_data_url):
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise DocumentAIError("尚未設定 OPENAI_API_KEY，無法使用 AI 單據辨識")
    if not isinstance(image_data_url, str) or not image_data_url.startswith("data:image/"):
        raise DocumentAIError("請上傳有效的圖片")
    if len(image_data_url) > MAX_IMAGE_DATA_LENGTH:
        raise DocumentAIError("圖片太大，請重新拍攝或壓縮後再上傳")

    body = {
        "model": os.environ.get("OPENAI_VISION_MODEL", "gpt-4.1-mini"),
        "store": False,
        "input": [{
            "role": "user",
            "content": [
                {"type": "input_text", "text": EXTRACTION_PROMPT},
                {"type": "input_image", "image_url": image_data_url, "detail": "high"},
            ],
        }],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "factory_document",
                "strict": True,
                "schema": DOCUMENT_SCHEMA,
            },
        },
    }
    request = Request(
        OPENAI_RESPONSES_URL,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=90) as response:
            api_payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")
        raise DocumentAIError(f"AI 服務回覆錯誤：HTTP {err.code} {detail[:300]}") from err
    except (URLError, TimeoutError) as err:
        raise DocumentAIError(f"無法連線至 AI 服務：{err}") from err
    except (ValueError, OSError) as err:
        raise DocumentAIError(f"AI 回覆格式錯誤：{err}") from err

    try:
        return json.loads(_response_text(api_payload))
    except json.JSONDecodeError as err:
        raise DocumentAIError("AI 回覆不是有效的 JSON") from err
