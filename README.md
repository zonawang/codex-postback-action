# Zona Cafe Postback Actions

Zona Cafe LINE Bot 的可互動搜尋版本。使用者分享位置後，Bot 透過 Vertex AI Gemini 的 Google Maps Grounding 推薦附近 3–5 間咖啡廳，並可用 LINE Postback action「換一批」或改成「更適合工作」的搜尋偏好。

## 使用流程

1. 使用者傳送任意文字，Bot 顯示「傳送目前位置」。
2. 使用者分享 LINE location message。
3. Bot 顯示載入動畫，使用 Google Maps Grounding 搜尋附近咖啡廳。
4. Bot 回覆繁體中文推薦摘要與 Google Maps 來源 Flex Message。
5. 結果下方提供：
   - `換一批`：排除上一批店名，搜尋其他選擇。
   - `更適合工作`：要求 Gemini 優先採用有明確 Maps 證據、適合專注或筆電工作的選擇。
   - `重新選位置`：重新開啟 LINE 位置分享。

Postback data 只帶版本、action 與短 session ID，例如：

```text
v=1&a=reroll&s=abc123
```

座標、搜尋偏好與上一批店名保存在 Firestore，不會放進 Postback data。

## 安全與狀態設計

- 搜尋 session 有效 30 分鐘。
- session 同時綁定 LINE 使用者與對話，其他人不能操作。
- Firestore transaction 提供 90 秒處理鎖，避免連點重複呼叫 Gemini。
- Postback action 採白名單解析，無效或過期操作會要求重新傳送位置。
- 搜尋 prompt 明確禁止捏造插座、Wi-Fi、不限時或噪音資訊。
- Firestore 寫入失敗時，第一次位置搜尋仍會回傳結果，但不顯示 Postback 按鈕。

## 技術架構

```text
LINE location / postback event
             │
             ▼
       Express webhook ─────► 立即回覆 HTTP 200
             │
             ├──── Firestore search session
             │       ├─ owner / conversation
             │       ├─ location / preference
             │       └─ previous cafe names / expiry / lock
             │
             ▼
Vertex AI Gemini + Google Maps Grounding
             │
             ├──── Gemini 繁中轉譯
             └──── Google Maps grounded URLs
                         │
                         ▼
              LINE summary + Flex carousel
```

## 本機啟動

需求：Node.js 20 以上、Google Cloud 專案、Firestore Native mode database。

```bash
gcloud auth application-default login
gcloud config set project line-zona
gcloud services enable aiplatform.googleapis.com firestore.googleapis.com
```

若專案還沒有 Firestore database，需先建立；location 建立後不能任意更換：

```bash
gcloud firestore databases create --location=asia-east1
```

啟動專案：

```bash
cp .env.example .env
npm install
npm run dev
```

`.env`：

```env
PORT=3000
LINE_CHANNEL_SECRET=...
LINE_CHANNEL_ACCESS_TOKEN=...
GOOGLE_CLOUD_PROJECT=line-zona
GOOGLE_CLOUD_LOCATION=global
GEMINI_MAPS_MODEL=gemini-2.5-flash
GEMINI_TRANSLATION_MODEL=gemini-2.5-flash
FIRESTORE_SESSION_COLLECTION=cafe-search-sessions
```

本機不需要 Gemini API key；Vertex AI 與 Firestore 都使用 Application Default Credentials。

## LINE 設定

在 LINE Developers Console 將 webhook 設為：

```text
https://<service-url>/webhook
```

開啟 `Use webhook` 並執行 Verify。建議關閉 LINE 官方帳號自動回覆，避免同一事件出現兩份回答。

## Cloud Run 部署

建立不提交到 Git 的 `cloud-run-env.yaml`：

```yaml
LINE_CHANNEL_SECRET: "..."
LINE_CHANNEL_ACCESS_TOKEN: "..."
GOOGLE_CLOUD_PROJECT: "line-zona"
GOOGLE_CLOUD_LOCATION: "global"
GEMINI_MAPS_MODEL: "gemini-2.5-flash"
GEMINI_TRANSLATION_MODEL: "gemini-2.5-flash"
FIRESTORE_SESSION_COLLECTION: "cafe-search-sessions"
```

建立 runtime service account 並授予 Vertex AI 與 Firestore 權限：

```bash
gcloud iam service-accounts create codex-postback-action \
  --display-name="Zona Cafe Postback Action"

gcloud projects add-iam-policy-binding line-zona \
  --member="serviceAccount:codex-postback-action@line-zona.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"

gcloud projects add-iam-policy-binding line-zona \
  --member="serviceAccount:codex-postback-action@line-zona.iam.gserviceaccount.com" \
  --role="roles/datastore.user"

gcloud projects add-iam-policy-binding line-zona \
  --member="serviceAccount:codex-postback-action@line-zona.iam.gserviceaccount.com" \
  --role="roles/serviceusage.serviceUsageConsumer"
```

部署：

```bash
gcloud run deploy codex-postback-action \
  --source . \
  --region asia-east1 \
  --allow-unauthenticated \
  --no-cpu-throttling \
  --service-account codex-postback-action@line-zona.iam.gserviceaccount.com \
  --env-vars-file cloud-run-env.yaml
```

Webhook 驗證完簽章後會先回覆 `200`，再進行 Gemini 與 Firestore 工作。因此 Cloud Run 必須保留 `--no-cpu-throttling`。

可選：啟用 Firestore TTL，自動刪除過期 session：

```bash
gcloud firestore fields ttls update expiresAt \
  --collection-group=cafe-search-sessions \
  --enable-ttl
```

部署後檢查：

```bash
curl https://<service-url>/health
```

確認新版服務正常後，再把 LINE webhook 指向它，避免直接影響目前線上 Bot。

## 驗證

```bash
npm run typecheck
npm test
```

測試涵蓋 Postback data 的產生與拒絕規則、Quick Reply action 組裝，以及 Google Maps source 去重。

## 目前範圍

- 已完成：位置分享、Maps grounding、繁中摘要、Maps attribution、Flex Message、換一批、工作偏好、Firestore session、過期與連點保護。
- 尚未加入：插座／Wi-Fi／不限時的硬性篩選、收藏、歷史紀錄、管理介面。
