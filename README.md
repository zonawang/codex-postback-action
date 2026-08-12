# LINE Map Grounding

使用者在 LINE 傳送地理位置後，Bot 透過 Vertex AI（Gemini Enterprise Agent Platform）的 Google Maps Grounding 找出附近 3–5 間咖啡廳，將推薦理由整理成繁體中文，並附上每個回答來源的 Google Maps 連結。

## MVP 互動流程

1. 使用者傳送任意文字或輸入「開始」。
2. Bot 顯示「傳送目前位置」按鈕。
3. 使用者分享 LINE location message。
4. 後端透過 Vertex AI `models.generateContent`，將經緯度放入 `retrievalConfig.latLng`，並啟用 `googleMaps` tool。
5. Gemini 回傳英文 Grounded recommendation 與 `groundingMetadata.groundingChunks`。
6. 後端再透過同一個 Vertex AI client 翻成台灣繁體中文，不新增事實。
7. Bot 回覆：
   - 咖啡廳推薦摘要
   - Google Maps 來源 Flex Message 輪播卡片

Google Maps Grounding 目前要求 grounded prompt 與回答使用英文，所以本專案採用「英文 grounding、繁中轉譯」兩階段架構。來源 URL 不經過翻譯模型，直接使用 `groundingChunks.maps.uri`，避免產生錯誤連結。

## 技術架構

```text
LINE Messaging API
        │ location event
        ▼
Express webhook
        │ latitude / longitude
        ▼
Vertex AI generateContent + googleMaps
        │ grounded English text + grounding metadata
        ├──────────────► Vertex AI translation call
        │                         │
        └──── Google Maps URLs    ▼
                   LINE summary + source carousel
```

## 本機啟動

需求：Node.js 20 以上。

先安裝並登入 Google Cloud CLI，設定 Application Default Credentials：

```bash
gcloud auth application-default login
gcloud config set project line-zona
gcloud services enable aiplatform.googleapis.com
```

```bash
cp .env.example .env
npm install
npm run dev
```

`.env` 必填：

```env
PORT=3000
LINE_CHANNEL_SECRET=...
LINE_CHANNEL_ACCESS_TOKEN=...
GOOGLE_CLOUD_PROJECT=line-zona
GOOGLE_CLOUD_LOCATION=global
GEMINI_MAPS_MODEL=gemini-2.5-flash
GEMINI_TRANSLATION_MODEL=gemini-2.5-flash
```

本機不需要 `GEMINI_API_KEY`。SDK 會使用 Application Default Credentials 呼叫 Vertex AI。

健康檢查：

```bash
curl http://localhost:3000/health
```

## LINE 設定

在 LINE Developers Console 的 Messaging API channel 設定：

```text
https://<service-url>/webhook
```

接著開啟 `Use webhook` 並執行 Verify。建議關閉 LINE 官方帳號的自動回覆，避免同一則訊息收到兩份回答。

## Cloud Run 部署

先建立一份不提交到 Git 的 `cloud-run-env.yaml`：

```yaml
LINE_CHANNEL_SECRET: "..."
LINE_CHANNEL_ACCESS_TOKEN: "..."
GOOGLE_CLOUD_PROJECT: "line-zona"
GOOGLE_CLOUD_LOCATION: "global"
GEMINI_MAPS_MODEL: "gemini-2.5-flash"
GEMINI_TRANSLATION_MODEL: "gemini-2.5-flash"
```

Cloud Run 不需要放 service account key 或 Gemini API key。服務會使用 Cloud Run runtime service account 的 Application Default Credentials。

先建立專用 service account 並授予 Vertex AI User：

```bash
gcloud iam service-accounts create line-map-grounding \
  --display-name="LINE Map Grounding"

gcloud projects add-iam-policy-binding line-zona \
  --member="serviceAccount:line-map-grounding@line-zona.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"
```

部署：

```bash
gcloud run deploy line-map-grounding \
  --source . \
  --region asia-east1 \
  --allow-unauthenticated \
  --service-account line-map-grounding@line-zona.iam.gserviceaccount.com \
  --env-vars-file cloud-run-env.yaml
```

取得網址後驗證：

```bash
curl https://<service-url>/health
```

最後把 `https://<service-url>/webhook` 設到 LINE Developers Console。

## 驗證

```bash
npm run typecheck
npm test
```

## 目前範圍

- 已完成：位置分享、附近咖啡廳 grounding、繁中摘要、Google Maps attribution、Flex Message、Cloud Run 設定。
- 尚未加入：使用者條件（插座、Wi-Fi、不限時）、收藏、換一批、歷史紀錄、資料庫。
